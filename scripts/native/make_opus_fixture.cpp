// Cet outil produit la fixture Opus utilisee par les tests du player.
//
// Il lit un fichier WAV stereo et le fait passer par `audio_encoder.cpp`, c'est-a-dire par le meme
// resampler et le meme encodeur que le device Max for Live. La fixture contient donc exactement ce
// que le navigateur recevra pendant un vrai live, et non des octets fabriques pour l'occasion.
//
// Sortie : les paquets VSA1 complets, mis bout a bout. Chaque paquet porte sa propre taille de
// payload, donc le fichier se relit sans index ni separateur.

#include "audio_encoder.h"

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// Le protocole v1 place 28 octets d'en-tete devant le payload Opus.
const std::size_t VSA1_HEADER_BYTES = 28;
// La fixture utilise une session fixe : elle est rejouee, pas negociee.
const std::uint32_t FIXTURE_SESSION_ID = 1;

// Cette structure contient le contenu utile d'un fichier WAV lu en memoire.
struct t_wave_file {
  unsigned int sample_rate;
  std::vector<double> left;
  std::vector<double> right;
};

// Cette structure suit l'ecriture de la fixture entre deux appels du callback d'encodage.
struct t_fixture_writer {
  std::FILE *output;
  std::size_t packets;
  std::size_t bytes;
};

// Cette fonction lit un entier 32 bits little-endian, l'ordre utilise par le format WAV.
std::uint32_t read_u32(const unsigned char *bytes) {
  return static_cast<std::uint32_t>(bytes[0]) | (static_cast<std::uint32_t>(bytes[1]) << 8) |
    (static_cast<std::uint32_t>(bytes[2]) << 16) | (static_cast<std::uint32_t>(bytes[3]) << 24);
}

// Cette fonction lit un entier 16 bits little-endian.
std::uint16_t read_u16(const unsigned char *bytes) {
  return static_cast<std::uint16_t>(static_cast<std::uint16_t>(bytes[0]) | (static_cast<std::uint16_t>(bytes[1]) << 8));
}

// Cette fonction convertit un echantillon entier signe vers l'intervalle -1 a 1.
double sample_to_double(const unsigned char *bytes, std::uint16_t bits) {
  if (bits == 16) {
    return static_cast<std::int16_t>(read_u16(bytes)) / 32768.0;
  }

  if (bits == 24) {
    std::int32_t value = static_cast<std::int32_t>(bytes[0]) | (static_cast<std::int32_t>(bytes[1]) << 8) |
      (static_cast<std::int32_t>(bytes[2]) << 16);

    // Le bit de signe du format 24 bits est recopie sur les huit bits de poids fort.
    if ((value & 0x800000) != 0) {
      value |= static_cast<std::int32_t>(0xff000000u);
    }

    return value / 8388608.0;
  }

  if (bits == 32) {
    return static_cast<std::int32_t>(read_u32(bytes)) / 2147483648.0;
  }

  return 0.0;
}

// Cette fonction lit un fichier WAV PCM stereo et separe ses deux canaux.
bool read_wave(const std::string &path, t_wave_file *wave) {
  std::FILE *file = std::fopen(path.c_str(), "rb");

  if (file == nullptr) {
    std::fprintf(stderr, "Fichier WAV introuvable : %s\n", path.c_str());
    return false;
  }

  std::vector<unsigned char> content;
  unsigned char chunk[4096];
  std::size_t read = 0;

  while ((read = std::fread(chunk, 1, sizeof(chunk), file)) > 0) {
    content.insert(content.end(), chunk, chunk + read);
  }

  std::fclose(file);

  if (content.size() < 44 || std::memcmp(content.data(), "RIFF", 4) != 0 ||
      std::memcmp(content.data() + 8, "WAVE", 4) != 0) {
    std::fprintf(stderr, "Ce fichier n'est pas un WAV RIFF.\n");
    return false;
  }

  std::uint16_t channels = 0;
  std::uint16_t bits = 0;
  std::size_t position = 12;

  // Les blocs d'un fichier WAV se suivent sans ordre impose : la lecture les parcourt tous.
  while (position + 8 <= content.size()) {
    const unsigned char *header = content.data() + position;
    const std::uint32_t size = read_u32(header + 4);
    const std::size_t body = position + 8;

    if (std::memcmp(header, "fmt ", 4) == 0 && size >= 16 && body + 16 <= content.size()) {
      channels = read_u16(content.data() + body + 2);
      wave->sample_rate = read_u32(content.data() + body + 4);
      bits = read_u16(content.data() + body + 14);
    } else if (std::memcmp(header, "data", 4) == 0) {
      if (channels != 2 || (bits != 16 && bits != 24 && bits != 32)) {
        std::fprintf(stderr, "Le WAV doit etre stereo en 16, 24 ou 32 bits.\n");
        return false;
      }

      const std::size_t width = bits / 8u;
      const std::size_t available = content.size() - body;
      const std::size_t usable = size < available ? size : available;
      const std::size_t frames = usable / (width * 2u);

      wave->left.reserve(frames);
      wave->right.reserve(frames);

      for (std::size_t frame = 0; frame < frames; frame += 1) {
        const unsigned char *base = content.data() + body + frame * width * 2u;
        wave->left.push_back(sample_to_double(base, bits));
        wave->right.push_back(sample_to_double(base + width, bits));
      }

      return true;
    }

    // Un bloc de taille impaire est suivi d'un octet de remplissage.
    position = body + size + (size % 2u);
  }

  std::fprintf(stderr, "Aucun bloc de donnees trouve dans le WAV.\n");
  return false;
}

// Cette fonction ecrit un entier sur un nombre d'octets donne, en big-endian comme le protocole.
void write_be(unsigned char *target, std::uint64_t value, std::size_t width) {
  for (std::size_t index = 0; index < width; index += 1) {
    target[width - 1 - index] = static_cast<unsigned char>((value >> (index * 8)) & 0xffu);
  }
}

// Cette fonction ecrit un paquet VSA1 complet a chaque frame produite par l'encodeur.
void on_frame(const t_encoded_audio_frame *frame, void *context) {
  t_fixture_writer *writer = static_cast<t_fixture_writer *>(context);
  unsigned char header[VSA1_HEADER_BYTES];

  std::memcpy(header, "VSA1", 4);
  header[4] = 1;
  header[5] = 1;
  header[6] = frame->flags;
  header[7] = 2;
  write_be(header + 8, FIXTURE_SESSION_ID, 4);
  write_be(header + 12, frame->sequence, 4);
  write_be(header + 16, frame->timestamp_us, 8);
  write_be(header + 24, OPUS_FRAME_SAMPLES, 2);
  write_be(header + 26, frame->payload_size, 2);

  std::fwrite(header, 1, sizeof(header), writer->output);
  std::fwrite(frame->payload, 1, frame->payload_size, writer->output);

  writer->packets += 1;
  writer->bytes += sizeof(header) + frame->payload_size;
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 3) {
    std::fprintf(stderr, "Usage : make_opus_fixture <entree.wav> <sortie.vsa1> [bitrate]\n");
    return 1;
  }

  const int bitrate = argc > 3 ? std::atoi(argv[3]) : OPUS_BITRATE_STUDIO;

  if (!audio_encoder_bitrate_is_valid(bitrate)) {
    std::fprintf(stderr, "Bitrate refuse : %d\n", bitrate);
    return 1;
  }

  t_wave_file wave;
  wave.sample_rate = 0;

  if (!read_wave(argv[1], &wave)) {
    return 1;
  }

  std::FILE *output = std::fopen(argv[2], "wb");

  if (output == nullptr) {
    std::fprintf(stderr, "Ecriture impossible : %s\n", argv[2]);
    return 1;
  }

  t_fixture_writer writer;
  writer.output = output;
  writer.packets = 0;
  writer.bytes = 0;

  t_audio_encoder *encoder = audio_encoder_create(wave.sample_rate, bitrate, on_frame, &writer);

  if (encoder == nullptr) {
    std::fprintf(stderr, "Encodeur indisponible.\n");
    std::fclose(output);
    return 1;
  }

  // Les blocs de 512 echantillons imitent une taille de bloc audio ordinaire : la fixture passe par
  // le meme chemin d'accumulation que pendant un live.
  const std::size_t block = 512;

  for (std::size_t position = 0; position < wave.left.size(); position += block) {
    const std::size_t count = wave.left.size() - position < block ? wave.left.size() - position : block;

    if (!audio_encoder_process(encoder, wave.left.data() + position, wave.right.data() + position, count)) {
      std::fprintf(stderr, "Encodage interrompu a %zu echantillons.\n", position);
      audio_encoder_destroy(encoder);
      std::fclose(output);
      return 1;
    }
  }

  audio_encoder_destroy(encoder);
  std::fclose(output);

  std::printf(
    "Fixture ecrite : %zu paquets, %zu octets, %d bit/s, entree %u Hz.\n",
    writer.packets,
    writer.bytes,
    bitrate,
    wave.sample_rate
  );

  return 0;
}
