#pragma once

#include <atomic>
#include <cstddef>

using t_queue_count = unsigned long long;
using t_atomic_queue_count = std::atomic<t_queue_count>;
using t_atomic_sample = std::atomic<unsigned long long>;

// Cette structure contient une file audio stereo a taille fixe.
struct t_audio_queue {
  t_atomic_sample *left_samples;
  t_atomic_sample *right_samples;
  std::size_t capacity_frames;
  t_atomic_queue_count read_frame;
  t_atomic_queue_count write_frame;
  t_atomic_queue_count overflow_count;
  t_atomic_queue_count dropped_frames;
};

// Cette fonction construit les champs atomiques dans la memoire fournie par Max.
void audio_queue_construct(t_audio_queue *queue);

// Cette fonction detruit les champs atomiques avant que Max libere la memoire.
void audio_queue_destruct(t_audio_queue *queue);

// Cette fonction alloue les deux canaux de la file avant le demarrage audio.
bool audio_queue_create(t_audio_queue *queue, std::size_t capacity_frames);

// Cette fonction remplace les tampons par une nouvelle capacite hors traitement audio.
bool audio_queue_resize(t_audio_queue *queue, std::size_t capacity_frames);

// Cette fonction libere les deux canaux de la file apres l'arret du worker.
void audio_queue_destroy(t_audio_queue *queue);

// Cette fonction vide la file sans liberer sa memoire.
void audio_queue_reset(t_audio_queue *queue);

// Cette fonction ajoute un bloc stereo et abandonne l'ancien audio si la file est pleine.
void audio_queue_push_stereo(
  t_audio_queue *queue,
  const double *left,
  const double *right,
  long frame_count
);

// Cette fonction lit un groupe de samples pour le worker et avance la position de lecture.
std::size_t audio_queue_pop(
  t_audio_queue *queue,
  std::size_t max_frames,
  double *left,
  double *right
);

// Cette fonction retourne le nombre de samples stereo actuellement en attente.
t_queue_count audio_queue_size(const t_audio_queue *queue);

// Cette fonction confirme que les operations utilisees par le callback sont sans verrou.
bool audio_queue_is_lock_free(const t_audio_queue *queue);
