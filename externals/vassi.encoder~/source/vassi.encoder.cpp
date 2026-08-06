#include "ext.h"
#include "ext_obex.h"
#include "z_dsp.h"

#include "encoder_state.h"

#include <cmath>

static const long QUEUE_CAPACITY_MS = 1000;
static const long DEFAULT_SAMPLE_RATE = 48000;
static const long MAX_SUPPORTED_SAMPLE_RATE = 384000;

static t_class *vassi_encoder_class = nullptr;

static void *vassi_encoder_new(t_symbol *symbol, long argc, t_atom *argv);
static void vassi_encoder_free(t_vassi_encoder *x);
static void vassi_encoder_dsp64(t_vassi_encoder *x, t_object *dsp64, short *count, double samplerate, long maxvectorsize, long flags);
static void vassi_encoder_perform64(t_vassi_encoder *x, t_object *dsp64, double **ins, long numins, double **outs, long numouts, long sampleframes, long flags, void *userparam);
static void vassi_encoder_bang(t_vassi_encoder *x);
static void vassi_encoder_reset(t_vassi_encoder *x);
static void vassi_encoder_active(t_vassi_encoder *x, long value);
static void vassi_encoder_start(t_vassi_encoder *x);
static void vassi_encoder_stop(t_vassi_encoder *x);
static void vassi_encoder_quality(t_vassi_encoder *x, long profile);
static void vassi_encoder_bitrate(t_vassi_encoder *x, long bitrate);
static void vassi_encoder_port(t_vassi_encoder *x, long port);
static void vassi_encoder_status_changed(void *context);
static void vassi_encoder_publish_status(t_vassi_encoder *x);
static bool vassi_encoder_prepare_queue(t_vassi_encoder *x, double sample_rate);
static bool block_carries_signal(const double *samples, long sampleframes);

// Cette fonction enregistre l'objet dans Max sous le nom vassi.encoder~.
extern "C" void ext_main(void *module_ref) {
  t_class *class_ref = class_new("vassi.encoder~", (method)vassi_encoder_new, (method)vassi_encoder_free, sizeof(t_vassi_encoder), nullptr, A_GIMME, 0);

  class_dspinit(class_ref);
  class_addmethod(class_ref, (method)vassi_encoder_dsp64, "dsp64", A_CANT, 0);
  class_addmethod(class_ref, (method)vassi_encoder_bang, "bang", 0);
  class_addmethod(class_ref, (method)vassi_encoder_reset, "reset", 0);
  class_addmethod(class_ref, (method)vassi_encoder_active, "active", A_LONG, 0);
  class_addmethod(class_ref, (method)vassi_encoder_start, "start", 0);
  class_addmethod(class_ref, (method)vassi_encoder_stop, "stop", 0);
  class_addmethod(class_ref, (method)vassi_encoder_quality, "quality", A_LONG, 0);
  class_addmethod(class_ref, (method)vassi_encoder_bitrate, "bitrate", A_LONG, 0);
  class_addmethod(class_ref, (method)vassi_encoder_port, "port", A_LONG, 0);
  class_register(CLASS_BOX, class_ref);

  vassi_encoder_class = class_ref;
  (void)module_ref;
}

// Cette fonction cree deux entrees signal et une sortie de diagnostic message.
static void *vassi_encoder_new(t_symbol *symbol, long argc, t_atom *argv) {
  t_vassi_encoder *x = (t_vassi_encoder *)object_alloc(vassi_encoder_class);

  if (x == nullptr) {
    return nullptr;
  }

  encoder_state_construct(x);
  dsp_setup((t_pxobject *)x, 2);

  if (!audio_queue_create(&x->audio_queue, (std::size_t)DEFAULT_SAMPLE_RATE)) {
    object_error((t_object *)x, "vassi.encoder~: audio queue allocation failed");
    object_free((t_object *)x);
    return nullptr;
  }

  if (!encoder_state_audio_atomics_are_lock_free(x)) {
    object_error((t_object *)x, "vassi.encoder~: this platform does not provide lock-free audio atomics");
    object_free((t_object *)x);
    return nullptr;
  }

  x->diagnostic_outlet = outlet_new((t_object *)x, nullptr);
  x->status_qelem = qelem_new(x, (method)vassi_encoder_publish_status);
  encoder_worker_set_status_callback(&x->worker, vassi_encoder_status_changed, x);
  vassi_encoder_reset(x);
  x->active.store(1, std::memory_order_relaxed);
  if (!encoder_worker_start(&x->worker)) {
    object_error((t_object *)x, "vassi.encoder~: worker thread creation failed");
    object_free((t_object *)x);
    return nullptr;
  }

  (void)symbol;
  (void)argc;
  (void)argv;
  return x;
}

// Cette fonction libere les ressources MSP et detruit les compteurs atomiques.
static void vassi_encoder_free(t_vassi_encoder *x) {
  x->active.store(0, std::memory_order_release);
  dsp_free((t_pxobject *)x);

  // Le thread s'arrete avant le qelem, sinon il pourrait notifier une structure liberee.
  encoder_worker_stop(&x->worker);
  if (x->status_qelem != nullptr) {
    qelem_free(x->status_qelem);
    x->status_qelem = nullptr;
  }
  audio_queue_destroy(&x->audio_queue);
  encoder_state_destruct(x);
}

// Cette fonction branche la routine audio 64 bits dans la chaine DSP de Max.
static void vassi_encoder_dsp64(
  t_vassi_encoder *x,
  t_object *dsp64,
  short *count,
  double samplerate,
  long maxvectorsize,
  long flags
) {
  if (!vassi_encoder_prepare_queue(x, samplerate)) {
    object_error((t_object *)x, "vassi.encoder~: audio queue preparation failed");
  }

  object_method(dsp64, gensym("dsp_add64"), x, vassi_encoder_perform64, 0, nullptr);

  (void)count;
  (void)maxvectorsize;
  (void)flags;
}

// Cette fonction indique si un bloc audio contient au moins un echantillon different de zero.
// Elle ne fait que lire le tampon fourni par MSP : aucune allocation, aucun appel bloquant.
// Elle sort des qu'un echantillon non nul est trouve, donc elle coute presque rien quand du son passe.
static bool block_carries_signal(const double *samples, long sampleframes) {
  for (long index = 0; index < sampleframes; index += 1) {
    if (samples[index] != 0.0) {
      return true;
    }
  }

  return false;
}

// Cette routine audio copie les samples vers la file sans allouer, logger ou acceder au reseau.
static void vassi_encoder_perform64(
  t_vassi_encoder *x,
  t_object *dsp64,
  double **ins,
  long numins,
  double **outs,
  long numouts,
  long sampleframes,
  long flags,
  void *userparam
) {
  if (x->active.load(std::memory_order_relaxed) == 0) {
    return;
  }

  if (numins < 2 || ins[0] == nullptr || ins[1] == nullptr) {
    return;
  }

  x->block_count.fetch_add(1, std::memory_order_relaxed);
  x->sample_count.fetch_add((t_counter)sampleframes, std::memory_order_relaxed);

  // Les deux compteurs par canal comptent les blocs qui portent reellement du son.
  // Un canal muet ou debranche laisse son compteur immobile : c'est la preuve directe
  // que les deux canaux du master arrivent jusqu'a l'objet.
  if (block_carries_signal(ins[0], sampleframes)) {
    x->left_block_count.fetch_add(1, std::memory_order_relaxed);
  }

  if (block_carries_signal(ins[1], sampleframes)) {
    x->right_block_count.fetch_add(1, std::memory_order_relaxed);
  }

  audio_queue_push_stereo(&x->audio_queue, ins[0], ins[1], sampleframes);

  (void)dsp64;
  (void)outs;
  (void)numouts;
  (void)flags;
  (void)userparam;
}

// Cette fonction publie les compteurs et l'etat de queue seulement quand Max envoie un bang.
static void vassi_encoder_bang(t_vassi_encoder *x) {
  t_atom block_values[4];
  t_atom queue_values[8];
  t_atom encoder_values[7];
  t_atom bridge_values[4];
  const double sample_rate = x->sample_rate.load(std::memory_order_relaxed);
  const double capacity_ms = sample_rate > 0.0
    ? ((double)x->audio_queue.capacity_frames * 1000.0) / sample_rate
    : 0.0;

  atom_setfloat(&block_values[0], (double)x->block_count.load(std::memory_order_relaxed));
  atom_setfloat(&block_values[1], (double)x->left_block_count.load(std::memory_order_relaxed));
  atom_setfloat(&block_values[2], (double)x->right_block_count.load(std::memory_order_relaxed));
  atom_setfloat(&block_values[3], (double)x->sample_count.load(std::memory_order_relaxed));

  atom_setfloat(&queue_values[0], (double)audio_queue_size(&x->audio_queue));
  atom_setfloat(&queue_values[1], (double)x->audio_queue.capacity_frames);
  atom_setfloat(&queue_values[2], capacity_ms);
  atom_setfloat(&queue_values[3], (double)x->audio_queue.overflow_count.load(std::memory_order_relaxed));
  atom_setfloat(&queue_values[4], (double)x->worker.sample_count.load(std::memory_order_relaxed));
  atom_setfloat(&queue_values[5], x->worker.last_left.load(std::memory_order_relaxed));
  atom_setfloat(&queue_values[6], x->worker.last_right.load(std::memory_order_relaxed));
  atom_setfloat(&queue_values[7], (double)x->worker.running.load(std::memory_order_relaxed));

  atom_setlong(&encoder_values[0], x->bitrate.load(std::memory_order_relaxed));
  atom_setfloat(&encoder_values[1], (double)x->worker.encoded_frame_count.load(std::memory_order_relaxed));
  atom_setfloat(&encoder_values[2], (double)x->worker.discontinuity_count.load(std::memory_order_relaxed));
  atom_setlong(&encoder_values[3], x->worker.last_payload_size.load(std::memory_order_relaxed));
  atom_setlong(&encoder_values[4], x->worker.last_flags.load(std::memory_order_relaxed));
  atom_setlong(&encoder_values[5], x->worker.error.load(std::memory_order_relaxed));
  atom_setfloat(&encoder_values[6], (double)x->worker.lost_frame_count.load(std::memory_order_relaxed));

  atom_setlong(&bridge_values[0], x->frame_sender.wanted_port.load(std::memory_order_relaxed));
  atom_setlong(&bridge_values[1], x->frame_sender.connected.load(std::memory_order_relaxed));
  atom_setfloat(&bridge_values[2], (double)x->frame_sender.sent_count.load(std::memory_order_relaxed));
  atom_setfloat(&bridge_values[3], (double)x->frame_sender.dropped_count.load(std::memory_order_relaxed));

  outlet_anything(x->diagnostic_outlet, gensym("blocks"), 4, block_values);
  outlet_anything(x->diagnostic_outlet, gensym("queue"), 8, queue_values);
  outlet_anything(x->diagnostic_outlet, gensym("encoder"), 7, encoder_values);
  outlet_anything(x->diagnostic_outlet, gensym("bridge"), 4, bridge_values);
}

// Cette fonction remet les compteurs a zero depuis le thread message de Max.
static void vassi_encoder_reset(t_vassi_encoder *x) {
  const bool worker_was_started = encoder_worker_is_started(&x->worker);
  encoder_worker_stop(&x->worker);
  audio_queue_reset(&x->audio_queue);
  x->block_count.store(0, std::memory_order_relaxed);
  x->left_block_count.store(0, std::memory_order_relaxed);
  x->right_block_count.store(0, std::memory_order_relaxed);
  x->sample_count.store(0, std::memory_order_relaxed);
  encoder_worker_reset_diagnostics(&x->worker);
  frame_sender_reset_diagnostics(&x->frame_sender);

  if (worker_was_started) {
    const bool configured = encoder_worker_configure(
      &x->worker,
      (unsigned int)std::llround(x->sample_rate.load(std::memory_order_relaxed)),
      (int)x->bitrate.load(std::memory_order_relaxed)
    );
    if (!configured || !encoder_worker_start(&x->worker)) {
      object_error((t_object *)x, "vassi.encoder~: worker reset failed");
    }
  }
}

// Cette fonction active ou suspend la copie audio vers la queue interne.
static void vassi_encoder_active(t_vassi_encoder *x, long value) {
  x->active.store(value != 0 ? 1 : 0, std::memory_order_relaxed);
}

// Cette fonction demarre le worker si aucun worker n'est deja actif.
static void vassi_encoder_start(t_vassi_encoder *x) {
  encoder_worker_stop(&x->worker);
  audio_queue_reset(&x->audio_queue);
  encoder_worker_reset_diagnostics(&x->worker);
  frame_sender_reset_diagnostics(&x->frame_sender);
  if (!encoder_worker_configure(
      &x->worker,
      (unsigned int)std::llround(x->sample_rate.load(std::memory_order_relaxed)),
      (int)x->bitrate.load(std::memory_order_relaxed)
  )) {
    object_error((t_object *)x, "vassi.encoder~: invalid encoder configuration");
    return;
  }
  if (!encoder_worker_start(&x->worker)) {
    object_error((t_object *)x, "vassi.encoder~: worker thread creation failed");
  }
}

// Cette fonction demande l'arret du worker et attend sa fin hors routine audio.
static void vassi_encoder_stop(t_vassi_encoder *x) {
  encoder_worker_stop(&x->worker);
}

// Cette fonction choisit le profil du prochain demarrage sans modifier un live actif.
static void vassi_encoder_quality(t_vassi_encoder *x, long profile) {
  int bitrate = 0;
  if (profile == 0) {
    bitrate = OPUS_BITRATE_STABLE;
  } else if (profile == 1) {
    bitrate = OPUS_BITRATE_HIGH;
  } else if (profile == 2) {
    bitrate = OPUS_BITRATE_STUDIO;
  } else {
    object_error((t_object *)x, "vassi.encoder~: quality must be 0, 1 or 2");
    return;
  }

  x->bitrate.store(bitrate, std::memory_order_relaxed);
}

// Cette fonction applique le debit decide par le regulateur du publisher, pendant un direct.
//
// Elle differe de `quality` sur trois points : elle accepte une valeur continue et non un profil,
// elle agit sur le direct en cours au lieu du prochain, et elle ne change pas la qualite choisie par
// l'utilisateur — celle-ci reste le plafond, et c'est elle que le device continue d'afficher.
//
// L'erreur n'est pas signalee a Max : ce message arrive plusieurs fois par seconde depuis Node, et
// une valeur hors bornes ne doit pas remplir la fenetre console pendant un direct. Elle laisse
// simplement le debit precedent en place.
static void vassi_encoder_bitrate(t_vassi_encoder *x, long bitrate) {
  encoder_worker_request_bitrate(&x->worker, (int)bitrate);
}

// Cette fonction enregistre le port loopback annonce par node.script.
static void vassi_encoder_port(t_vassi_encoder *x, long port) {
  if (port < 0 || port > 65535) {
    object_error((t_object *)x, "vassi.encoder~: port must be between 0 and 65535");
    return;
  }

  frame_sender_set_port(&x->frame_sender, port);
}

// Cette fonction est appelee depuis le thread du worker et differe la sortie vers Max.
static void vassi_encoder_status_changed(void *context) {
  t_vassi_encoder *x = (t_vassi_encoder *)context;
  if (x->status_qelem != nullptr) {
    qelem_set(x->status_qelem);
  }
}

// Cette fonction publie l'etat du pont et du worker depuis le thread message de Max.
// L'erreur passe avant la connexion : un worker arrete ne produit plus d'audio, meme connecte.
static void vassi_encoder_publish_status(t_vassi_encoder *x) {
  t_atom status_values[1];
  const bool failed = x->worker.error.load(std::memory_order_acquire) != 0;
  const long connected = x->frame_sender.connected.load(std::memory_order_relaxed);
  const char *label = failed ? "error" : (connected != 0 ? "connected" : "disconnected");

  atom_setsym(&status_values[0], gensym(label));
  outlet_anything(x->diagnostic_outlet, gensym("status"), 1, status_values);
}

// Cette fonction ajuste la queue au sample rate courant avant le demarrage du DSP.
static bool vassi_encoder_prepare_queue(t_vassi_encoder *x, double sample_rate) {
  if (!std::isfinite(sample_rate) || sample_rate < 1000.0 || sample_rate > (double)MAX_SUPPORTED_SAMPLE_RATE) {
    return false;
  }

  const std::size_t capacity_frames = (std::size_t)std::llround(
    sample_rate * ((double)QUEUE_CAPACITY_MS / 1000.0)
  );

  // Live reconstruit sa chaine DSP a chaque ajout de device. Sans changement de sample rate, ce
  // passage ne doit ni attendre la fin du worker ni jeter l'audio deja en attente dans la queue.
  if (sample_rate == x->sample_rate.load(std::memory_order_relaxed)
      && capacity_frames == x->audio_queue.capacity_frames) {
    return true;
  }

  x->sample_rate.store(sample_rate, std::memory_order_relaxed);

  const bool worker_was_started = encoder_worker_is_started(&x->worker);
  const long active_was_enabled = x->active.exchange(0, std::memory_order_acq_rel);
  encoder_worker_stop(&x->worker);
  const bool resized = capacity_frames == x->audio_queue.capacity_frames
    ? true
    : audio_queue_resize(&x->audio_queue, capacity_frames);
  bool worker_restarted = true;

  audio_queue_reset(&x->audio_queue);

  const bool configured = encoder_worker_configure(
    &x->worker,
    (unsigned int)std::llround(sample_rate),
    (int)x->bitrate.load(std::memory_order_relaxed)
  );
  if (worker_was_started && (!configured || !encoder_worker_start(&x->worker))) {
    object_error((t_object *)x, "vassi.encoder~: worker thread restart failed");
    worker_restarted = false;
  }
  x->active.store(active_was_enabled, std::memory_order_release);
  return resized && worker_restarted;
}
