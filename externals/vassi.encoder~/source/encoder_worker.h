#pragma once

#include "audio_queue.h"
#include "audio_encoder.h"
#include "frame_sender.h"

#include <atomic>
#include <cstddef>
#include <thread>

static const std::size_t ENCODER_WORKER_READ_FRAMES = 960;

// Cette fonction previent Max qu'un etat visible a change, depuis n'importe quel thread.
using t_worker_status_callback = void (*)(void *context);

using t_worker_count = unsigned long long;
using t_atomic_worker_count = std::atomic<t_worker_count>;
using t_atomic_worker_long = std::atomic<long>;
using t_atomic_worker_double = std::atomic<double>;

// Cette structure contient le thread de lecture et ses buffers stereo prealloues.
struct t_encoder_worker {
  t_audio_queue *queue;
  t_frame_sender *sender;
  std::thread *thread;
  t_worker_status_callback status_callback;
  void *status_context;
  t_atomic_worker_count sample_count;
  t_atomic_worker_count encoded_frame_count;
  t_atomic_worker_count discontinuity_count;
  t_atomic_worker_count lost_frame_count;
  t_atomic_worker_long requested;
  t_atomic_worker_long running;
  t_atomic_worker_long error;
  t_atomic_worker_long input_rate;
  t_atomic_worker_long bitrate;
  t_atomic_worker_long last_payload_size;
  t_atomic_worker_long last_flags;
  t_atomic_worker_double last_left;
  t_atomic_worker_double last_right;
  double left_samples[ENCODER_WORKER_READ_FRAMES];
  double right_samples[ENCODER_WORKER_READ_FRAMES];
};

// Cette fonction construit le worker dans la memoire fournie par Max.
void encoder_worker_construct(t_encoder_worker *worker, t_audio_queue *queue, t_frame_sender *sender);

// Cette fonction enregistre la notification utilisee quand la connexion Node change.
void encoder_worker_set_status_callback(
  t_encoder_worker *worker,
  t_worker_status_callback callback,
  void *context
);

// Cette fonction arrete puis detruit les champs C++ du worker.
void encoder_worker_destruct(t_encoder_worker *worker);

// Cette fonction demarre le thread une seule fois et signale un echec de creation.
bool encoder_worker_start(t_encoder_worker *worker);

// Cette fonction demande l'arret puis attend la fin du thread.
void encoder_worker_stop(t_encoder_worker *worker);

// Cette fonction indique si une instance de thread est actuellement possedee.
bool encoder_worker_is_started(const t_encoder_worker *worker);

// Cette fonction prepare le sample rate et le profil du prochain live.
bool encoder_worker_configure(t_encoder_worker *worker, unsigned int input_rate, int bitrate);

// Cette fonction remet les diagnostics du worker a zero.
void encoder_worker_reset_diagnostics(t_encoder_worker *worker);
