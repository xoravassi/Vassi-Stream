#include "audio_encoder.h"

#include <opus.h>

#define OUTSIDE_SPEEX
#define RANDOM_PREFIX vassi_stream
#include <speex_resampler.h>

#include <algorithm>
#include <cstring>
#include <new>

static const unsigned int OUTPUT_RATE = 48000;
static const unsigned int MIN_INPUT_RATE = 8000;
static const unsigned int MAX_INPUT_RATE = 384000;
static const int OUTPUT_CHANNELS = 2;
static const int RESAMPLER_QUALITY = 10;
static const std::size_t CONVERT_BUFFER_FRAMES = 960;
static const std::size_t RESAMPLE_BUFFER_FRAMES = 2048;
static const std::uint64_t FRAME_DURATION_US = 20000;

// Cette structure conserve les etats persistants du resampler et d'Opus.
struct t_audio_encoder {
  unsigned int input_rate;
  int bitrate;
  SpeexResamplerState *resampler;
  OpusEncoder *opus;
  t_encoded_frame_callback callback;
  void *context;
  std::uint32_t sequence;
  std::uint64_t timestamp_us;
  bool discontinuity_pending;
  std::size_t opus_frame_fill;
  float convert_buffer[CONVERT_BUFFER_FRAMES * OUTPUT_CHANNELS];
  float resample_buffer[RESAMPLE_BUFFER_FRAMES * OUTPUT_CHANNELS];
  float opus_frame[OPUS_FRAME_SAMPLES * OUTPUT_CHANNELS];
};

// Cette fonction limite un sample Max a l'intervalle accepte par l'encodeur flottant.
static float audio_encoder_to_float(double sample) {
  return (float)std::max(-1.0, std::min(1.0, sample));
}

// Cette fonction valide les trois profils fixes de la version 1.
bool audio_encoder_bitrate_is_valid(int bitrate) {
  return bitrate == OPUS_BITRATE_STABLE
    || bitrate == OPUS_BITRATE_HIGH
    || bitrate == OPUS_BITRATE_STUDIO;
}

// Cette fonction valide un debit demande pendant un direct. Le regulateur le fait varier de facon
// continue : toute valeur entre le plancher et la qualite Studio est legitime.
bool audio_encoder_live_bitrate_is_valid(int bitrate) {
  return bitrate >= OPUS_BITRATE_FLOOR && bitrate <= OPUS_BITRATE_STUDIO;
}

// Cette fonction change le debit d'un encodeur en marche.
//
// Le champ `bitrate` de la structure et le reglage d'Opus portent toujours la meme valeur, et cette
// fonction est le seul endroit qui les fait bouger ensemble apres la creation.
// `audio_encoder_reset_audio_state` reapplique ce champ apres chaque `OPUS_RESET_STATE` : c'est lui
// qui fait autorite des qu'une discontinuite survient.
bool audio_encoder_set_bitrate(t_audio_encoder *encoder, int bitrate) {
  if (encoder == nullptr || encoder->opus == nullptr || !audio_encoder_live_bitrate_is_valid(bitrate)) {
    return false;
  }

  if (bitrate == encoder->bitrate) {
    return true;
  }

  if (opus_encoder_ctl(encoder->opus, OPUS_SET_BITRATE(bitrate)) != OPUS_OK) {
    return false;
  }

  encoder->bitrate = bitrate;
  return true;
}

// Cette fonction encode une frame complete et la remet immediatement au consommateur.
static bool audio_encoder_emit_frame(t_audio_encoder *encoder) {
  t_encoded_audio_frame frame = {};
  const int payload_size = opus_encode_float(
    encoder->opus,
    encoder->opus_frame,
    (int)OPUS_FRAME_SAMPLES,
    frame.payload,
    (opus_int32)OPUS_MAX_PACKET_BYTES
  );

  if (payload_size < 0) {
    return false;
  }

  frame.sequence = encoder->sequence;
  frame.timestamp_us = encoder->timestamp_us;
  frame.flags = encoder->discontinuity_pending ? 1 : 0;
  frame.payload_size = (std::size_t)payload_size;
  encoder->callback(&frame, encoder->context);
  encoder->sequence += 1;
  encoder->timestamp_us += FRAME_DURATION_US;
  encoder->discontinuity_pending = false;
  encoder->opus_frame_fill = 0;
  return true;
}

// Cette fonction accumule les samples 48 kHz jusqu'a une frame Opus de 20 ms.
static bool audio_encoder_append_output(
  t_audio_encoder *encoder,
  const float *samples,
  std::size_t frame_count
) {
  std::size_t source_frame = 0;

  while (source_frame < frame_count) {
    const std::size_t room = OPUS_FRAME_SAMPLES - encoder->opus_frame_fill;
    const std::size_t copied = std::min(room, frame_count - source_frame);
    std::memcpy(
      encoder->opus_frame + (encoder->opus_frame_fill * OUTPUT_CHANNELS),
      samples + (source_frame * OUTPUT_CHANNELS),
      copied * OUTPUT_CHANNELS * sizeof(float)
    );
    encoder->opus_frame_fill += copied;
    source_frame += copied;

    if (encoder->opus_frame_fill == OPUS_FRAME_SAMPLES && !audio_encoder_emit_frame(encoder)) {
      return false;
    }
  }

  return true;
}

// Cette fonction cree des etats neufs pour un sample rate et un bitrate valides.
t_audio_encoder *audio_encoder_create(
  unsigned int input_rate,
  int bitrate,
  t_encoded_frame_callback callback,
  void *context
) {
  if (input_rate < MIN_INPUT_RATE
      || input_rate > MAX_INPUT_RATE
      || !audio_encoder_bitrate_is_valid(bitrate)
      || callback == nullptr) {
    return nullptr;
  }

  t_audio_encoder *encoder = new (std::nothrow) t_audio_encoder();
  if (encoder == nullptr) {
    return nullptr;
  }

  encoder->input_rate = input_rate;
  encoder->bitrate = bitrate;
  encoder->callback = callback;
  encoder->context = context;
  encoder->resampler = nullptr;
  encoder->opus = nullptr;

  int error = RESAMPLER_ERR_SUCCESS;
  if (input_rate != OUTPUT_RATE) {
    encoder->resampler = speex_resampler_init(
      OUTPUT_CHANNELS,
      input_rate,
      OUTPUT_RATE,
      RESAMPLER_QUALITY,
      &error
    );
    if (encoder->resampler == nullptr || error != RESAMPLER_ERR_SUCCESS) {
      audio_encoder_destroy(encoder);
      return nullptr;
    }
  }

  encoder->opus = opus_encoder_create(OUTPUT_RATE, OUTPUT_CHANNELS, OPUS_APPLICATION_AUDIO, &error);
  if (encoder->opus == nullptr || error != OPUS_OK) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }

  if (opus_encoder_ctl(encoder->opus, OPUS_SET_BITRATE(bitrate)) != OPUS_OK) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }

  // Ces trois reglages rendent la descente en debit sure. Sans eux, un debit qui baisse ne fait pas
  // que perdre en finesse : il change de nature, et cela s'entend.
  //
  // La stereo est forcee. Sous 17,3 kbit/s libopus passe seul en mono (`stereo_music_threshold`), ce
  // qui sur un mix s'entend comme une panne. Le regulateur ne descend jamais si bas, mais un reglage
  // qui depend d'un autre reglage est un piege : celui-ci ferme la question.
  if (opus_encoder_ctl(encoder->opus, OPUS_SET_FORCE_CHANNELS(OUTPUT_CHANNELS)) != OPUS_OK) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }

  // Le signal est declare musical. A defaut, libopus suppose un contenu a moitie vocal et garde
  // ouverte la possibilite de basculer en mode SILK sur un passage de voix seule. Ce qui sort d'une
  // piste Master n'est jamais de la parole, et une bascule de mode est un artefact evitable.
  if (opus_encoder_ctl(encoder->opus, OPUS_SET_SIGNAL(OPUS_SIGNAL_MUSIC)) != OPUS_OK) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }

  // Le VBR contraint borne la taille de chaque paquet autour du debit demande. Le VBR libre laisse
  // passer des pointes que le lien montant doit absorber d'un coup, ce qui est exactement ce qu'un
  // lien sature ne sait pas faire. Le CBR, lui, couterait 8 % de qualite.
  if (opus_encoder_ctl(encoder->opus, OPUS_SET_VBR_CONSTRAINT(1)) != OPUS_OK) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }

  if (!audio_encoder_reset_session(encoder)) {
    audio_encoder_destroy(encoder);
    return nullptr;
  }
  return encoder;
}

// Cette fonction libere les bibliotheques dans l'ordre inverse de leur creation.
void audio_encoder_destroy(t_audio_encoder *encoder) {
  if (encoder == nullptr) {
    return;
  }

  if (encoder->opus != nullptr) {
    opus_encoder_destroy(encoder->opus);
  }
  if (encoder->resampler != nullptr) {
    speex_resampler_destroy(encoder->resampler);
  }
  delete encoder;
}

// Cette fonction convertit un nombre de samples 48 kHz en microsecondes arrondies.
static std::uint64_t audio_encoder_samples_to_us(std::size_t samples) {
  return (((std::uint64_t)samples * 1000000ULL) + (OUTPUT_RATE / 2)) / OUTPUT_RATE;
}

// Cette fonction remet le resampler, le codec et l'accumulation partielle a zero.
static bool audio_encoder_reset_audio_state(t_audio_encoder *encoder) {
  if (encoder == nullptr || encoder->opus == nullptr) {
    return false;
  }

  if (encoder->resampler != nullptr
      && speex_resampler_reset_mem(encoder->resampler) != RESAMPLER_ERR_SUCCESS) {
    return false;
  }
  if (opus_encoder_ctl(encoder->opus, OPUS_RESET_STATE) != OPUS_OK) {
    return false;
  }
  if (opus_encoder_ctl(encoder->opus, OPUS_SET_BITRATE(encoder->bitrate)) != OPUS_OK) {
    return false;
  }

  encoder->opus_frame_fill = 0;
  return true;
}

// Cette fonction demarre une chronologie neuve pour un nouveau live.
bool audio_encoder_reset_session(t_audio_encoder *encoder) {
  if (!audio_encoder_reset_audio_state(encoder)) {
    return false;
  }

  encoder->sequence = 0;
  encoder->timestamp_us = 0;
  encoder->discontinuity_pending = false;
  return true;
}

// Cette fonction conserve la session et decale la chronologie de tout l'audio abandonne.
bool audio_encoder_reset_after_loss(t_audio_encoder *encoder, std::uint64_t lost_us) {
  if (encoder == nullptr) {
    return false;
  }

  // Les samples deja accumules sont jetes avec le reste : leur duree fait partie du trou.
  const std::uint64_t discarded_us = audio_encoder_samples_to_us(encoder->opus_frame_fill);
  if (!audio_encoder_reset_audio_state(encoder)) {
    return false;
  }

  encoder->timestamp_us += lost_us + discarded_us;
  encoder->discontinuity_pending = true;
  return true;
}

// Cette fonction convertit un bloc Max en float stereo entrelace.
static void audio_encoder_interleave(
  t_audio_encoder *encoder,
  const double *left,
  const double *right,
  std::size_t source_start,
  std::size_t frame_count
) {
  for (std::size_t frame = 0; frame < frame_count; frame += 1) {
    encoder->convert_buffer[frame * OUTPUT_CHANNELS] = audio_encoder_to_float(left[source_start + frame]);
    encoder->convert_buffer[(frame * OUTPUT_CHANNELS) + 1] = audio_encoder_to_float(right[source_start + frame]);
  }
}

// Cette fonction traite un bloc par morceaux fixes sans allocation temporaire.
bool audio_encoder_process(
  t_audio_encoder *encoder,
  const double *left,
  const double *right,
  std::size_t frame_count
) {
  if (encoder == nullptr || left == nullptr || right == nullptr) {
    return false;
  }

  std::size_t source_start = 0;
  while (source_start < frame_count) {
    const std::size_t converted = std::min(CONVERT_BUFFER_FRAMES, frame_count - source_start);
    audio_encoder_interleave(encoder, left, right, source_start, converted);
    source_start += converted;

    if (encoder->resampler == nullptr) {
      if (!audio_encoder_append_output(encoder, encoder->convert_buffer, converted)) {
        return false;
      }
      continue;
    }

    spx_uint32_t input_start = 0;
    while (input_start < converted) {
      spx_uint32_t input_frames = (spx_uint32_t)(converted - input_start);
      spx_uint32_t output_frames = (spx_uint32_t)RESAMPLE_BUFFER_FRAMES;
      const int result = speex_resampler_process_interleaved_float(
        encoder->resampler,
        encoder->convert_buffer + (input_start * OUTPUT_CHANNELS),
        &input_frames,
        encoder->resample_buffer,
        &output_frames
      );
      if (result != RESAMPLER_ERR_SUCCESS || input_frames == 0) {
        return false;
      }
      input_start += input_frames;
      if (!audio_encoder_append_output(encoder, encoder->resample_buffer, output_frames)) {
        return false;
      }
    }
  }
  return true;
}
