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

// Debit le plus bas que le regulateur peut demander. En dessous de 17,3 kbit/s libopus abandonne la
// stereo pour du mono, ce qui s'entend brutalement sur un mix ; sous 32 kbit/s il retrecit deja
// l'image stereo. Ce plancher garde donc la bande pleine et l'image intactes.
static const int OPUS_BITRATE_FLOOR = 32000;

// Cette fonction valide les trois bitrates de depart exposes par le device.
bool audio_encoder_bitrate_is_valid(int bitrate);

// Cette fonction valide un debit demande en cours de direct par le regulateur. Contrairement au
// debit de depart, il varie de facon continue entre le plancher et la qualite Studio.
bool audio_encoder_live_bitrate_is_valid(int bitrate);

// Cette fonction change le debit d'un encodeur en marche.
//
// `OPUS_SET_BITRATE` ne fait qu'affecter une valeur bornee : aucune reallocation, aucune remise a
// zero, donc aucune coupure ni discontinuite dans le flux produit. Elle doit etre appelee depuis le
// thread qui possede l'encodeur, libopus n'etant pas reentrant sur un meme etat.
bool audio_encoder_set_bitrate(t_audio_encoder *encoder, int bitrate);

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
