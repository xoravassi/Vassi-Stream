#include "encoder_state.h"

#include <new>

static const long DEFAULT_SAMPLE_RATE = 48000;

// Cette fonction construit les atomiques et les modules dans une memoire deja allouee.
void encoder_state_construct(t_vassi_encoder *state) {
  state->diagnostic_outlet = nullptr;
  state->status_qelem = nullptr;
  audio_queue_construct(&state->audio_queue);
  frame_sender_construct(&state->frame_sender);
  encoder_worker_construct(&state->worker, &state->audio_queue, &state->frame_sender);
  new (&state->block_count) t_atomic_counter(0);
  new (&state->left_block_count) t_atomic_counter(0);
  new (&state->right_block_count) t_atomic_counter(0);
  new (&state->sample_count) t_atomic_counter(0);
  new (&state->active) t_atomic_long(0);
  new (&state->bitrate) t_atomic_long(OPUS_BITRATE_STUDIO);
  new (&state->sample_rate) t_atomic_double((double)DEFAULT_SAMPLE_RATE);
}

// Cette fonction detruit les modules puis les atomiques dans l'ordre inverse.
void encoder_state_destruct(t_vassi_encoder *state) {
  state->sample_rate.~t_atomic_double();
  state->bitrate.~t_atomic_long();
  state->active.~t_atomic_long();
  state->sample_count.~t_atomic_counter();
  state->right_block_count.~t_atomic_counter();
  state->left_block_count.~t_atomic_counter();
  state->block_count.~t_atomic_counter();
  encoder_worker_destruct(&state->worker);
  frame_sender_destruct(&state->frame_sender);
  audio_queue_destruct(&state->audio_queue);
}

// Cette fonction refuse une plateforme ou le callback audio utiliserait des verrous.
bool encoder_state_audio_atomics_are_lock_free(const t_vassi_encoder *state) {
  return audio_queue_is_lock_free(&state->audio_queue)
    && state->block_count.is_lock_free()
    && state->left_block_count.is_lock_free()
    && state->right_block_count.is_lock_free()
    && state->sample_count.is_lock_free()
    && state->active.is_lock_free();
}
