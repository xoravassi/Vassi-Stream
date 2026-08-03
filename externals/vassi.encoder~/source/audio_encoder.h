#pragma once

#include <cstddef>
#include <cstdint>

static const std::size_t OPUS_FRAME_SAMPLES = 960;
// Le protocole v1 reserve 1276 octets : un octet TOC suivi d'une frame Opus de 1275 octets au maximum.
static const std::size_t OPUS_MAX_PACKET_BYTES = 1276;
static const int OPUS_BITRATE_STABLE = 128000;
static const int OPUS_BITRATE_HIGH = 192000;
static const int OPUS_BITRATE_STUDIO = 256000;

// Cette structure decrit une frame Opus produite par le worker.
struct t_encoded_audio_frame {
  std::uint32_t sequence;
  std::uint64_t timestamp_us;
  unsigned char flags;
  std::size_t payload_size;
  unsigned char payload[OPUS_MAX_PACKET_BYTES];
};

using t_encoded_frame_callback = void (*)(const t_encoded_audio_frame *frame, void *context);

struct t_audio_encoder;

// Cette fonction valide les trois bitrates exposes par le device.
bool audio_encoder_bitrate_is_valid(int bitrate);

// Cette fonction cree le resampler et l'encodeur Opus pour un nouveau live.
t_audio_encoder *audio_encoder_create(
  unsigned int input_rate,
  int bitrate,
  t_encoded_frame_callback callback,
  void *context
);

// Cette fonction libere toutes les ressources du moteur d'encodage.
void audio_encoder_destroy(t_audio_encoder *encoder);

// Cette fonction prepare un nouveau live : etats audio vides, sequence et timestamp a zero.
bool audio_encoder_reset_session(t_audio_encoder *encoder);

// Cette fonction traite une perte locale : elle vide les etats audio, conserve la sequence,
// avance le timestamp de la duree perdue et marque la prochaine frame comme discontinue.
bool audio_encoder_reset_after_loss(t_audio_encoder *encoder, std::uint64_t lost_us);

// Cette fonction reechantillonne puis encode un bloc stereo hors du callback MSP.
bool audio_encoder_process(
  t_audio_encoder *encoder,
  const double *left,
  const double *right,
  std::size_t frame_count
);
