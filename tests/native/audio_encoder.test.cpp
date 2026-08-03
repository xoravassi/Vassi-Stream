#include "audio_encoder.h"

#include <opus.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <vector>

static const double PI = 3.14159265358979323846;

// Cette structure conserve les frames copiees pendant un test.
struct t_frame_list {
  std::vector<t_encoded_audio_frame> frames;
};

// Cette fonction arrete le test avec un message precis quand une condition echoue.
static void require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "ECHEC: " << message << '\n';
    std::exit(1);
  }
}

// Cette fonction copie une frame car sa memoire source est temporaire.
static void collect_frame(const t_encoded_audio_frame *frame, void *context) {
  t_frame_list *list = (t_frame_list *)context;
  list->frames.push_back(*frame);
}

// Cette fonction produit un signal stereo distinct et borne.
static void make_signal(
  std::vector<double> *left,
  std::vector<double> *right,
  unsigned int sample_rate,
  std::size_t frame_count,
  bool enable_left,
  bool enable_right
) {
  left->resize(frame_count);
  right->resize(frame_count);
  for (std::size_t frame = 0; frame < frame_count; frame += 1) {
    const double time = (double)frame / (double)sample_rate;
    (*left)[frame] = enable_left ? 0.7 * std::sin(2.0 * PI * 440.0 * time) : 0.0;
    (*right)[frame] = enable_right ? 0.7 * std::sin(2.0 * PI * 880.0 * time) : 0.0;
  }
}

// Cette fonction encode un signal complet avec la configuration demandee.
static t_frame_list encode_signal(
  unsigned int sample_rate,
  int bitrate,
  std::size_t frame_count,
  bool enable_left,
  bool enable_right
) {
  std::vector<double> left;
  std::vector<double> right;
  t_frame_list list;
  make_signal(&left, &right, sample_rate, frame_count, enable_left, enable_right);

  t_audio_encoder *encoder = audio_encoder_create(sample_rate, bitrate, collect_frame, &list);
  require(encoder != nullptr, "la creation de l'encodeur doit reussir");

  std::size_t start = 0;
  while (start < frame_count) {
    const std::size_t block = std::min<std::size_t>(257, frame_count - start);
    require(
      audio_encoder_process(encoder, left.data() + start, right.data() + start, block),
      "chaque bloc PCM doit etre accepte"
    );
    start += block;
  }
  audio_encoder_destroy(encoder);
  return list;
}

// Cette fonction decode les paquets et mesure l'energie de chaque canal.
static void decode_energy(const t_frame_list &list, double *left_energy, double *right_energy) {
  int error = OPUS_OK;
  OpusDecoder *decoder = opus_decoder_create(48000, 2, &error);
  require(decoder != nullptr && error == OPUS_OK, "le decodeur de verification doit etre cree");

  float pcm[OPUS_FRAME_SAMPLES * 2] = {};
  *left_energy = 0.0;
  *right_energy = 0.0;
  for (const t_encoded_audio_frame &frame : list.frames) {
    const int decoded = opus_decode_float(
      decoder,
      frame.payload,
      (opus_int32)frame.payload_size,
      pcm,
      (int)OPUS_FRAME_SAMPLES,
      0
    );
    require(decoded == (int)OPUS_FRAME_SAMPLES, "chaque paquet doit etre decodable en 960 samples");
    for (int sample = 0; sample < decoded; sample += 1) {
      *left_energy += (double)pcm[sample * 2] * (double)pcm[sample * 2];
      *right_energy += (double)pcm[(sample * 2) + 1] * (double)pcm[(sample * 2) + 1];
    }
  }
  opus_decoder_destroy(decoder);
}

// Cette fonction verifie les deux sample rates et la continuite des numeros de frame.
static void test_rates_and_sequence() {
  const t_frame_list direct = encode_signal(48000, OPUS_BITRATE_STUDIO, 48000, true, true);
  const t_frame_list resampled = encode_signal(44100, OPUS_BITRATE_STUDIO, 44100, true, true);
  require(direct.frames.size() == 50, "48 kHz doit produire exactement 50 frames par seconde");
  require(
    resampled.frames.size() >= 49 && resampled.frames.size() <= 50,
    "44,1 kHz doit produire 49 ou 50 frames par seconde"
  );

  for (std::size_t index = 0; index < direct.frames.size(); index += 1) {
    require(direct.frames[index].sequence == index, "la sequence doit avancer d'une unite");
    require(direct.frames[index].timestamp_us == index * 20000, "le timestamp doit avancer de 20 ms");
    require(direct.frames[index].payload_size > 0, "chaque payload Opus doit etre non vide");
  }
}

// Cette fonction verifie que gauche et droite ne sont ni inversees ni melangees.
static void test_stereo_channels() {
  const unsigned int rates[] = {48000, 44100};
  for (unsigned int rate : rates) {
    const t_frame_list left_only = encode_signal(rate, OPUS_BITRATE_STUDIO, rate, true, false);
    const t_frame_list right_only = encode_signal(rate, OPUS_BITRATE_STUDIO, rate, false, true);
    double left_energy = 0.0;
    double right_energy = 0.0;

    decode_energy(left_only, &left_energy, &right_energy);
    require(left_energy > right_energy * 100.0, "le test gauche doit rester sur le canal gauche");
    decode_energy(right_only, &left_energy, &right_energy);
    require(right_energy > left_energy * 100.0, "le test droite doit rester sur le canal droit");
  }
}

// Cette fonction verifie que chaque profil produit des paquets valides.
static void test_quality_profiles() {
  const int bitrates[] = {OPUS_BITRATE_STABLE, OPUS_BITRATE_HIGH, OPUS_BITRATE_STUDIO};
  for (int bitrate : bitrates) {
    const t_frame_list list = encode_signal(48000, bitrate, 48000, true, true);
    double left_energy = 0.0;
    double right_energy = 0.0;
    require(list.frames.size() == 50, "chaque profil doit produire 50 frames par seconde");
    decode_energy(list, &left_energy, &right_energy);
    require(left_energy > 0.0 && right_energy > 0.0, "chaque profil doit decoder les deux canaux");
  }
  require(!audio_encoder_bitrate_is_valid(64000), "un bitrate hors profil doit etre refuse");
  t_frame_list invalid_list;
  require(
    audio_encoder_create(0, OPUS_BITRATE_STUDIO, collect_frame, &invalid_list) == nullptr,
    "un sample rate nul doit etre refuse"
  );
}

// Cette fonction verifie le reset de session et le reset apres perte locale.
static void test_resets() {
  t_frame_list list;
  std::vector<double> left;
  std::vector<double> right;
  make_signal(&left, &right, 48000, OPUS_FRAME_SAMPLES, true, true);
  t_audio_encoder *encoder = audio_encoder_create(48000, OPUS_BITRATE_STUDIO, collect_frame, &list);
  require(encoder != nullptr, "l'encodeur du test de reset doit etre cree");

  require(audio_encoder_process(encoder, left.data(), right.data(), left.size()), "la premiere frame doit etre encodee");
  require(audio_encoder_reset_after_loss(encoder, 500000), "le reset de discontinuite doit reussir");
  require(audio_encoder_process(encoder, left.data(), right.data(), left.size()), "la frame discontinue doit etre encodee");
  require(list.frames[1].sequence == 1, "une perte locale doit conserver la sequence de session");
  require(list.frames[1].flags == 1, "la premiere frame apres perte doit porter le flag");
  require(
    list.frames[1].timestamp_us == list.frames[0].timestamp_us + 20000 + 500000,
    "une perte locale doit avancer le timestamp de la duree abandonnee"
  );

  require(audio_encoder_reset_session(encoder), "le reset de nouveau live doit reussir");
  require(audio_encoder_process(encoder, left.data(), right.data(), left.size()), "la nouvelle session doit encoder");
  require(list.frames[2].sequence == 0, "un nouveau live doit recommencer la sequence");
  require(list.frames[2].flags == 0, "un nouveau live ne doit pas simuler une perte");
  require(list.frames[2].timestamp_us == 0, "un nouveau live doit repartir du timestamp zero");
  audio_encoder_destroy(encoder);
}

// Cette fonction verifie que la frame partielle jetee est comptee dans le trou de temps.
static void test_partial_frame_is_counted() {
  t_frame_list list;
  std::vector<double> left;
  std::vector<double> right;
  const std::size_t partial_samples = 480;
  make_signal(&left, &right, 48000, OPUS_FRAME_SAMPLES + partial_samples, true, true);
  t_audio_encoder *encoder = audio_encoder_create(48000, OPUS_BITRATE_STUDIO, collect_frame, &list);
  require(encoder != nullptr, "l'encodeur du test de frame partielle doit etre cree");

  require(
    audio_encoder_process(encoder, left.data(), right.data(), left.size()),
    "une frame complete suivie d'une frame partielle doit etre acceptee"
  );
  require(list.frames.size() == 1, "480 samples restants ne doivent pas produire de paquet");

  require(audio_encoder_reset_after_loss(encoder, 0), "le reset apres perte doit reussir");
  require(
    audio_encoder_process(encoder, left.data(), right.data(), OPUS_FRAME_SAMPLES),
    "la frame suivante doit etre encodee"
  );
  require(list.frames.size() == 2, "la frame suivante doit produire un seul paquet");
  require(
    list.frames[1].timestamp_us == 20000 + 10000,
    "les 480 samples jetes doivent ajouter 10 ms au timestamp"
  );
  audio_encoder_destroy(encoder);
}

// Cette fonction execute tous les controles natifs du bloc 4.
int main() {
  test_rates_and_sequence();
  test_stereo_channels();
  test_quality_profiles();
  test_resets();
  test_partial_frame_is_counted();
  std::cout << "OK: tous les tests natifs Opus passent\n";
  return 0;
}
