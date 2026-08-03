#include "audio_queue.h"

#include <algorithm>
#include <cstring>
#include <new>

// Une lecture qui echoue autant de fois signifie un overflow continu : le worker reessaie plus tard.
static const int AUDIO_QUEUE_POP_ATTEMPTS = 8;

// Cette fonction transforme un sample double en entier pour un stockage atomique.
static unsigned long long audio_queue_pack_sample(double sample) {
  unsigned long long packed = 0;
  std::memcpy(&packed, &sample, sizeof(sample));
  return packed;
}

// Cette fonction transforme un entier atomique en sample double.
static double audio_queue_unpack_sample(unsigned long long packed) {
  double sample = 0.0;
  std::memcpy(&sample, &packed, sizeof(sample));
  return sample;
}

// Cette fonction avance la lecture sans jamais la faire reculer et retourne les frames sautees.
static t_queue_count audio_queue_raise_read(t_audio_queue *queue, t_queue_count wanted_read) {
  t_queue_count current_read = queue->read_frame.load(std::memory_order_acquire);

  while (current_read < wanted_read) {
    if (queue->read_frame.compare_exchange_weak(
      current_read,
      wanted_read,
      std::memory_order_acq_rel,
      std::memory_order_acquire
    )) {
      return wanted_read - current_read;
    }
  }

  return 0;
}

// Cette fonction initialise une file vide dans une memoire deja reservee.
void audio_queue_construct(t_audio_queue *queue) {
  queue->left_samples = nullptr;
  queue->right_samples = nullptr;
  queue->capacity_frames = 0;
  new (&queue->read_frame) t_atomic_queue_count(0);
  new (&queue->write_frame) t_atomic_queue_count(0);
  new (&queue->overflow_count) t_atomic_queue_count(0);
  new (&queue->dropped_frames) t_atomic_queue_count(0);
}

// Cette fonction detruit les compteurs atomiques internes de la file.
void audio_queue_destruct(t_audio_queue *queue) {
  queue->dropped_frames.~t_atomic_queue_count();
  queue->overflow_count.~t_atomic_queue_count();
  queue->write_frame.~t_atomic_queue_count();
  queue->read_frame.~t_atomic_queue_count();
}

// Cette fonction alloue les deux tableaux atomiques qui stockent les canaux gauche et droit.
bool audio_queue_create(t_audio_queue *queue, std::size_t capacity_frames) {
  if (queue->left_samples != nullptr || queue->right_samples != nullptr) {
    return false;
  }

  return audio_queue_resize(queue, capacity_frames);
}

// Cette fonction alloue d'abord les nouveaux tampons pour conserver l'ancienne queue en cas d'echec.
bool audio_queue_resize(t_audio_queue *queue, std::size_t capacity_frames) {
  if (capacity_frames == 0) {
    return false;
  }

  t_atomic_sample *new_left = new (std::nothrow) t_atomic_sample[capacity_frames];
  t_atomic_sample *new_right = new (std::nothrow) t_atomic_sample[capacity_frames];

  if (new_left == nullptr || new_right == nullptr) {
    delete[] new_right;
    delete[] new_left;
    return false;
  }

  for (std::size_t frame = 0; frame < capacity_frames; frame += 1) {
    new_left[frame].store(audio_queue_pack_sample(0.0), std::memory_order_relaxed);
    new_right[frame].store(audio_queue_pack_sample(0.0), std::memory_order_relaxed);
  }

  delete[] queue->right_samples;
  delete[] queue->left_samples;
  queue->left_samples = new_left;
  queue->right_samples = new_right;
  queue->capacity_frames = capacity_frames;
  queue->read_frame.store(0, std::memory_order_relaxed);
  queue->write_frame.store(0, std::memory_order_relaxed);
  queue->overflow_count.store(0, std::memory_order_relaxed);
  queue->dropped_frames.store(0, std::memory_order_relaxed);

  return true;
}

// Cette fonction libere la memoire de la file et remet ses champs a une valeur neutre.
void audio_queue_destroy(t_audio_queue *queue) {
  delete[] queue->right_samples;
  delete[] queue->left_samples;
  queue->right_samples = nullptr;
  queue->left_samples = nullptr;
  queue->capacity_frames = 0;
  queue->read_frame.store(0, std::memory_order_relaxed);
  queue->write_frame.store(0, std::memory_order_relaxed);
  queue->overflow_count.store(0, std::memory_order_relaxed);
  queue->dropped_frames.store(0, std::memory_order_relaxed);
}

// Cette fonction place la lecture au niveau de l'ecriture courante.
void audio_queue_reset(t_audio_queue *queue) {
  const t_queue_count write = queue->write_frame.load(std::memory_order_acquire);
  (void)audio_queue_raise_read(queue, write);
  queue->overflow_count.store(0, std::memory_order_relaxed);
  queue->dropped_frames.store(0, std::memory_order_relaxed);
}

// Cette fonction calcule combien d'emplacements doivent etre abandonnes avant l'ecriture.
static void audio_queue_make_room(t_audio_queue *queue, t_queue_count write, std::size_t frame_count) {
  const t_queue_count read = queue->read_frame.load(std::memory_order_acquire);
  const t_queue_count used = write > read ? write - read : 0;

  if (used + frame_count <= queue->capacity_frames) {
    return;
  }

  // Le compteur de frames perdues sert au worker pour avancer le timestamp de la duree abandonnee.
  const t_queue_count wanted_read = write + frame_count - queue->capacity_frames;
  const t_queue_count skipped = audio_queue_raise_read(queue, wanted_read);
  queue->dropped_frames.fetch_add(skipped, std::memory_order_relaxed);
  queue->overflow_count.fetch_add(1, std::memory_order_relaxed);
}

// Cette fonction copie le bloc stereo dans le tampon circulaire prealloue.
void audio_queue_push_stereo(
  t_audio_queue *queue,
  const double *left,
  const double *right,
  long frame_count
) {
  if (queue->capacity_frames == 0 || frame_count <= 0) {
    return;
  }

  std::size_t source_start = 0;
  std::size_t frames_to_write = (std::size_t)frame_count;

  if (frames_to_write > queue->capacity_frames) {
    source_start = frames_to_write - queue->capacity_frames;
    frames_to_write = queue->capacity_frames;
  }

  const t_queue_count write = queue->write_frame.load(std::memory_order_relaxed);
  audio_queue_make_room(queue, write, frames_to_write);

  for (std::size_t frame = 0; frame < frames_to_write; frame += 1) {
    const std::size_t source_frame = source_start + frame;
    const std::size_t target_frame = (std::size_t)((write + frame) % queue->capacity_frames);
    const double left_sample = left != nullptr ? left[source_frame] : 0.0;
    const double right_sample = right != nullptr ? right[source_frame] : 0.0;

    queue->left_samples[target_frame].store(audio_queue_pack_sample(left_sample), std::memory_order_relaxed);
    queue->right_samples[target_frame].store(audio_queue_pack_sample(right_sample), std::memory_order_relaxed);
  }

  queue->write_frame.store(write + frames_to_write, std::memory_order_release);
}

// Cette fonction copie toutes les frames disponibles dans les buffers stereo du worker.
// Un overflow pendant la copie invalide les samples lus : l'echange atomique echoue alors et la
// lecture recommence. Le nombre de tentatives reste borne pour que ce thread ne bloque jamais
// l'arret du worker, que Max attend par un join.
std::size_t audio_queue_pop(
  t_audio_queue *queue,
  std::size_t max_frames,
  double *left,
  double *right
) {
  if (queue->capacity_frames == 0 || max_frames == 0 || left == nullptr || right == nullptr) {
    return 0;
  }

  for (int attempt = 0; attempt < AUDIO_QUEUE_POP_ATTEMPTS; attempt += 1) {
    t_queue_count read = queue->read_frame.load(std::memory_order_acquire);
    const t_queue_count write = queue->write_frame.load(std::memory_order_acquire);

    if (write <= read) {
      return 0;
    }

    const t_queue_count available = write - read;
    const std::size_t frames_to_read = (std::size_t)std::min<t_queue_count>(available, max_frames);

    for (std::size_t frame = 0; frame < frames_to_read; frame += 1) {
      const std::size_t source_frame = (std::size_t)((read + frame) % queue->capacity_frames);
      left[frame] = audio_queue_unpack_sample(queue->left_samples[source_frame].load(std::memory_order_relaxed));
      right[frame] = audio_queue_unpack_sample(queue->right_samples[source_frame].load(std::memory_order_relaxed));
    }

    if (queue->read_frame.compare_exchange_strong(
      read,
      read + frames_to_read,
      std::memory_order_acq_rel,
      std::memory_order_acquire
    )) {
      return frames_to_read;
    }
  }

  return 0;
}

// Cette fonction mesure la quantite d'audio en attente sans modifier la file.
t_queue_count audio_queue_size(const t_audio_queue *queue) {
  const t_queue_count read = queue->read_frame.load(std::memory_order_acquire);
  const t_queue_count write = queue->write_frame.load(std::memory_order_acquire);

  if (write <= read) {
    return 0;
  }

  const t_queue_count size = write - read;
  return std::min<t_queue_count>(size, (t_queue_count)queue->capacity_frames);
}

// Cette fonction verifie les types atomiques qui sont touches dans la routine audio.
bool audio_queue_is_lock_free(const t_audio_queue *queue) {
  if (queue->capacity_frames == 0) {
    return false;
  }

  return queue->read_frame.is_lock_free()
    && queue->write_frame.is_lock_free()
    && queue->overflow_count.is_lock_free()
    && queue->dropped_frames.is_lock_free()
    && queue->left_samples[0].is_lock_free()
    && queue->right_samples[0].is_lock_free();
}
