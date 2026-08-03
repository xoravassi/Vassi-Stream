#pragma once

#include "z_dsp.h"

#include "audio_queue.h"
#include "encoder_worker.h"
#include "frame_sender.h"

#include <atomic>

using t_counter = unsigned long long;
using t_atomic_counter = std::atomic<t_counter>;
using t_atomic_long = std::atomic<long>;
using t_atomic_double = std::atomic<double>;

// Cette structure contient l'etat partage par les messages Max, MSP et le worker.
typedef struct _vassi_encoder {
  t_pxobject object;
  void *diagnostic_outlet;
  void *status_qelem;
  t_audio_queue audio_queue;
  t_frame_sender frame_sender;
  t_encoder_worker worker;
  t_atomic_counter block_count;
  t_atomic_counter left_block_count;
  t_atomic_counter right_block_count;
  t_atomic_counter sample_count;
  t_atomic_long active;
  t_atomic_long bitrate;
  t_atomic_double sample_rate;
} t_vassi_encoder;

// Cette fonction construit les champs C++ dans la memoire fournie par Max.
void encoder_state_construct(t_vassi_encoder *state);

// Cette fonction detruit les champs C++ avant que Max libere la memoire.
void encoder_state_destruct(t_vassi_encoder *state);

// Cette fonction verifie les atomiques utilises par le callback audio.
bool encoder_state_audio_atomics_are_lock_free(const t_vassi_encoder *state);
