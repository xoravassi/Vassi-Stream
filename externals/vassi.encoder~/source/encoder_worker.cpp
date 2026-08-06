#include "encoder_worker.h"

#include <chrono>
#include <new>

static const long WORKER_SLEEP_MS = 1;

// Cette fonction remet la frame encodee au pont Node et met a jour les diagnostics.
static void encoder_worker_receive_frame(const t_encoded_audio_frame *frame, void *context) {
  t_encoder_worker *worker = (t_encoder_worker *)context;
  worker->encoded_frame_count.fetch_add(1, std::memory_order_relaxed);
  worker->last_payload_size.store((long)frame->payload_size, std::memory_order_relaxed);
  worker->last_flags.store((long)frame->flags, std::memory_order_relaxed);

  // L'encodeur ne peut pas etre remis a zero ici : le worker traite la perte avant la frame suivante.
  frame_sender_send(worker->sender, frame);
}

// Cette fonction reveille Max pour qu'il republie l'etat visible du worker.
static void encoder_worker_notify(t_encoder_worker *worker) {
  if (worker->status_callback != nullptr) {
    worker->status_callback(worker->status_context);
  }
}

// Cette fonction previent Max quand la connexion Node s'ouvre ou se ferme.
static void encoder_worker_publish_connection(t_encoder_worker *worker, long *known_connection) {
  const long current = worker->sender->connected.load(std::memory_order_acquire);
  if (current == *known_connection) {
    return;
  }

  *known_connection = current;
  encoder_worker_notify(worker);
}

// Cette fonction previent Max quand le worker entre en erreur, sinon l'arret reste invisible.
static void encoder_worker_publish_error(t_encoder_worker *worker, long *known_error) {
  const long current = worker->error.load(std::memory_order_acquire);
  if (current == *known_error) {
    return;
  }

  *known_error = current;
  encoder_worker_notify(worker);
}

// Cette fonction traite une frame perdue par le pont comme une perte locale d'audio.
static bool encoder_worker_reset_after_send_drop(t_encoder_worker *worker, t_audio_encoder *encoder) {
  if (!frame_sender_take_drop(worker->sender)) {
    return true;
  }

  // La frame perdue a deja avance le timestamp de ses 40 ms : le trou supplementaire est nul.
  worker->discontinuity_count.fetch_add(1, std::memory_order_relaxed);
  return audio_encoder_reset_after_loss(encoder, 0);
}

// Cette fonction detecte une perte locale avant de traiter le prochain bloc.
static bool encoder_worker_reset_after_overflow(
  t_encoder_worker *worker,
  t_audio_encoder *encoder,
  t_queue_count *known_dropped
) {
  const t_queue_count current = worker->queue->dropped_frames.load(std::memory_order_acquire);
  if (current == *known_dropped) {
    return true;
  }

  // Un vidage de queue remet ce compteur a zero. La soustraction n'est faite que lorsqu'il avance,
  // sinon un compteur recule produirait une duree perdue enorme et un timestamp impossible.
  const t_queue_count lost_frames = current > *known_dropped ? current - *known_dropped : 0;
  // Les frames perdues sont comptees au sample rate d'entree, avant tout reechantillonnage.
  const long stored_rate = worker->input_rate.load(std::memory_order_relaxed);
  const std::uint64_t input_rate = stored_rate > 0 ? (std::uint64_t)stored_rate : 1ULL;
  const std::uint64_t lost_us = ((lost_frames * 1000000ULL) + (input_rate / 2)) / input_rate;

  *known_dropped = current;
  worker->lost_frame_count.fetch_add((t_worker_count)lost_frames, std::memory_order_relaxed);
  worker->discontinuity_count.fetch_add(1, std::memory_order_relaxed);
  return audio_encoder_reset_after_loss(encoder, lost_us);
}

// Cette fonction applique le debit demande par le regulateur, s'il y en a un en attente.
//
// Elle tourne sur le thread du worker, donc sur celui qui possede l'encodeur. Un echec n'arrete pas
// le direct : un debit refuse laisse simplement l'ancien en place, ce qui reste ecoutable.
static void encoder_worker_apply_pending_bitrate(t_encoder_worker *worker, t_audio_encoder *encoder) {
  const long requested = worker->pending_bitrate.exchange(0, std::memory_order_acq_rel);
  if (requested == 0) {
    return;
  }

  if (audio_encoder_set_bitrate(encoder, (int)requested)) {
    worker->bitrate.store(requested, std::memory_order_relaxed);
  }
}

// Cette fonction consomme, reechantillonne et encode les frames hors du callback audio.
static void encoder_worker_run(t_encoder_worker *worker) {
  t_audio_encoder *encoder = audio_encoder_create(
    (unsigned int)worker->input_rate.load(std::memory_order_relaxed),
    (int)worker->bitrate.load(std::memory_order_relaxed),
    encoder_worker_receive_frame,
    worker
  );
  if (encoder == nullptr) {
    worker->error.store(1, std::memory_order_release);
    encoder_worker_notify(worker);
    return;
  }

  t_queue_count known_dropped = worker->queue->dropped_frames.load(std::memory_order_acquire);
  long known_connection = worker->sender->connected.load(std::memory_order_acquire);
  long known_error = worker->error.load(std::memory_order_acquire);
  worker->running.store(1, std::memory_order_release);

  while (worker->requested.load(std::memory_order_acquire) != 0) {
    frame_sender_service(worker->sender);
    encoder_worker_publish_connection(worker, &known_connection);
    encoder_worker_apply_pending_bitrate(worker, encoder);

    if (!encoder_worker_reset_after_overflow(worker, encoder, &known_dropped)
        || !encoder_worker_reset_after_send_drop(worker, encoder)) {
      worker->error.store(1, std::memory_order_release);
      break;
    }

    const std::size_t frames = audio_queue_pop(
      worker->queue,
      ENCODER_WORKER_READ_FRAMES,
      worker->left_samples,
      worker->right_samples
    );

    if (frames > 0) {
      if (!encoder_worker_reset_after_overflow(worker, encoder, &known_dropped)
          || !audio_encoder_process(encoder, worker->left_samples, worker->right_samples, frames)) {
        worker->error.store(1, std::memory_order_release);
        break;
      }
      worker->sample_count.fetch_add((t_worker_count)frames, std::memory_order_relaxed);
      worker->last_left.store(worker->left_samples[frames - 1], std::memory_order_relaxed);
      worker->last_right.store(worker->right_samples[frames - 1], std::memory_order_relaxed);
    } else {
      std::this_thread::sleep_for(std::chrono::milliseconds(WORKER_SLEEP_MS));
    }
  }

  audio_encoder_destroy(encoder);
  frame_sender_close(worker->sender);
  encoder_worker_publish_connection(worker, &known_connection);
  encoder_worker_publish_error(worker, &known_error);
  worker->running.store(0, std::memory_order_release);
}

// Cette fonction initialise le worker et ses diagnostics sans demarrer de thread.
void encoder_worker_construct(t_encoder_worker *worker, t_audio_queue *queue, t_frame_sender *sender) {
  worker->queue = queue;
  worker->sender = sender;
  worker->thread = nullptr;
  worker->status_callback = nullptr;
  worker->status_context = nullptr;
  new (&worker->sample_count) t_atomic_worker_count(0);
  new (&worker->encoded_frame_count) t_atomic_worker_count(0);
  new (&worker->discontinuity_count) t_atomic_worker_count(0);
  new (&worker->lost_frame_count) t_atomic_worker_count(0);
  new (&worker->requested) t_atomic_worker_long(0);
  new (&worker->running) t_atomic_worker_long(0);
  new (&worker->error) t_atomic_worker_long(0);
  new (&worker->input_rate) t_atomic_worker_long(48000);
  new (&worker->bitrate) t_atomic_worker_long(OPUS_BITRATE_STUDIO);
  new (&worker->pending_bitrate) t_atomic_worker_long(0);
  new (&worker->last_payload_size) t_atomic_worker_long(0);
  new (&worker->last_flags) t_atomic_worker_long(0);
  new (&worker->last_left) t_atomic_worker_double(0.0);
  new (&worker->last_right) t_atomic_worker_double(0.0);
}

// Cette fonction libere uniquement un worker deja retire de la chaine DSP.
void encoder_worker_destruct(t_encoder_worker *worker) {
  encoder_worker_stop(worker);
  worker->last_right.~t_atomic_worker_double();
  worker->last_left.~t_atomic_worker_double();
  worker->last_flags.~t_atomic_worker_long();
  worker->last_payload_size.~t_atomic_worker_long();
  worker->pending_bitrate.~t_atomic_worker_long();
  worker->bitrate.~t_atomic_worker_long();
  worker->input_rate.~t_atomic_worker_long();
  worker->error.~t_atomic_worker_long();
  worker->running.~t_atomic_worker_long();
  worker->requested.~t_atomic_worker_long();
  worker->lost_frame_count.~t_atomic_worker_count();
  worker->discontinuity_count.~t_atomic_worker_count();
  worker->encoded_frame_count.~t_atomic_worker_count();
  worker->sample_count.~t_atomic_worker_count();
}

// Cette fonction cree le thread si aucun thread n'est deja possede.
bool encoder_worker_start(t_encoder_worker *worker) {
  if (worker->thread != nullptr) {
    return true;
  }

  worker->error.store(0, std::memory_order_relaxed);
  worker->requested.store(1, std::memory_order_release);
  try {
    worker->thread = new (std::nothrow) std::thread(encoder_worker_run, worker);
  } catch (...) {
    worker->thread = nullptr;
  }

  if (worker->thread == nullptr) {
    worker->requested.store(0, std::memory_order_release);
    return false;
  }

  return true;
}

// Cette fonction rejoint le thread avant de liberer son objet C++.
void encoder_worker_stop(t_encoder_worker *worker) {
  std::thread *thread = worker->thread;
  if (thread == nullptr) {
    return;
  }

  worker->requested.store(0, std::memory_order_release);
  if (thread->joinable()) {
    thread->join();
  }
  delete thread;
  worker->thread = nullptr;
}

// Cette fonction lit l'etat de possession depuis le thread message de Max.
bool encoder_worker_is_started(const t_encoder_worker *worker) {
  return worker->thread != nullptr;
}

// Cette fonction refuse une configuration incoherente avant la creation du thread.
bool encoder_worker_configure(t_encoder_worker *worker, unsigned int input_rate, int bitrate) {
  if (worker->thread != nullptr || input_rate == 0 || !audio_encoder_bitrate_is_valid(bitrate)) {
    return false;
  }

  worker->input_rate.store((long)input_rate, std::memory_order_relaxed);
  worker->bitrate.store((long)bitrate, std::memory_order_relaxed);
  return true;
}

// Cette fonction depose un debit a appliquer, sans jamais toucher a l'encodeur elle-meme.
bool encoder_worker_request_bitrate(t_encoder_worker *worker, int bitrate) {
  if (!audio_encoder_live_bitrate_is_valid(bitrate)) {
    return false;
  }

  // Un debit depose et pas encore lu est simplement remplace : seule la derniere valeur compte, et
  // le regulateur en produit plusieurs par seconde.
  worker->pending_bitrate.store((long)bitrate, std::memory_order_release);
  return true;
}

// Cette fonction enregistre la notification appelee depuis le thread du worker.
void encoder_worker_set_status_callback(
  t_encoder_worker *worker,
  t_worker_status_callback callback,
  void *context
) {
  worker->status_callback = callback;
  worker->status_context = context;
}

// Cette fonction remet les compteurs visibles a zero sans toucher au thread.
void encoder_worker_reset_diagnostics(t_encoder_worker *worker) {
  worker->sample_count.store(0, std::memory_order_relaxed);
  worker->encoded_frame_count.store(0, std::memory_order_relaxed);
  worker->discontinuity_count.store(0, std::memory_order_relaxed);
  worker->lost_frame_count.store(0, std::memory_order_relaxed);
  worker->last_payload_size.store(0, std::memory_order_relaxed);
  worker->last_flags.store(0, std::memory_order_relaxed);
  worker->last_left.store(0.0, std::memory_order_relaxed);
  worker->last_right.store(0.0, std::memory_order_relaxed);
}
