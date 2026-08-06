#include "frame_sender.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <chrono>
#include <cstring>
#include <iostream>
#include <vector>

// Cette fonction arrete le test avec un message precis quand une condition echoue.
static void require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "ECHEC: " << message << '\n';
    std::exit(1);
  }
}

// Cette fonction cree un socket d'ecoute local et retourne le port choisi par Windows.
static SOCKET listen_on_free_port(long *port) {
  const SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  require(listener != INVALID_SOCKET, "le socket d'ecoute doit etre cree");

  sockaddr_in address = {};
  address.sin_family = AF_INET;
  address.sin_port = 0;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  require(bind(listener, (const sockaddr *)&address, sizeof(address)) == 0, "le bind loopback doit reussir");
  require(listen(listener, 1) == 0, "l'ecoute doit reussir");

  sockaddr_in bound = {};
  int bound_size = sizeof(bound);
  require(getsockname(listener, (sockaddr *)&bound, &bound_size) == 0, "le port choisi doit etre lisible");
  *port = (long)ntohs(bound.sin_port);
  return listener;
}

// Cette fonction lit exactement le nombre d'octets demande sur le socket accepte.
static void read_exactly(SOCKET client, unsigned char *buffer, int size) {
  int read_bytes = 0;
  while (read_bytes < size) {
    const int result = recv(client, (char *)buffer + read_bytes, size - read_bytes, 0);
    require(result > 0, "la lecture du pont doit rendre des octets");
    read_bytes += result;
  }
}

// Cette fonction remplit une frame de test avec un payload reconnaissable.
static t_encoded_audio_frame make_frame(std::uint32_t sequence, unsigned char flags, std::size_t size) {
  t_encoded_audio_frame frame = {};
  frame.sequence = sequence;
  frame.timestamp_us = (std::uint64_t)sequence * 40000ULL;
  frame.flags = flags;
  frame.payload_size = size;
  for (std::size_t index = 0; index < size; index += 1) {
    frame.payload[index] = (unsigned char)((sequence + index) & 0xff);
  }
  return frame;
}

// Cette suite d'octets est la reference partagee avec le test JavaScript du lecteur.
static const unsigned char REFERENCE_FRAME[] = {
  0x56, 0x53, 0x46, 0x31,
  0x01, 0x02, 0x03, 0x04,
  0x00, 0x00, 0x00, 0x00, 0x05, 0xf5, 0xe1, 0x00,
  0x01,
  0x00,
  0x00, 0x03,
  0xaa, 0xbb, 0xcc
};

// Cette fonction verifie que l'encodage produit exactement les octets de reference.
static void test_reference_bytes() {
  unsigned char buffer[FRAME_SENDER_MAX_BYTES] = {};
  t_encoded_audio_frame frame = {};
  frame.sequence = 0x01020304;
  frame.timestamp_us = 100000000ULL;
  frame.flags = 1;
  frame.payload_size = 3;
  frame.payload[0] = 0xaa;
  frame.payload[1] = 0xbb;
  frame.payload[2] = 0xcc;

  const std::size_t size = frame_sender_encode(buffer, &frame);
  require(size == sizeof(REFERENCE_FRAME), "la frame de reference doit avoir la taille attendue");
  require(std::memcmp(buffer, REFERENCE_FRAME, size) == 0, "les octets doivent correspondre a la reference partagee");
}

// Cette fonction verifie l'en-tete VSF1 champ par champ.
static void test_encode_header() {
  unsigned char buffer[FRAME_SENDER_MAX_BYTES] = {};
  const t_encoded_audio_frame frame = make_frame(0x01020304, 1, 3);
  const std::size_t size = frame_sender_encode(buffer, &frame);

  require(size == FRAME_SENDER_HEADER_BYTES + 3, "la taille totale doit inclure l'en-tete");
  require(std::memcmp(buffer, "VSF1", 4) == 0, "le magic interne doit etre VSF1");
  require(buffer[4] == 0x01 && buffer[5] == 0x02 && buffer[6] == 0x03 && buffer[7] == 0x04, "la sequence doit etre big-endian");
  require(buffer[16] == 1, "le flag de discontinuite doit etre copie");
  require(buffer[17] == 0, "l'octet reserve doit rester nul");
  require(buffer[18] == 0 && buffer[19] == 3, "la taille du payload doit etre big-endian");
  require(buffer[20] == frame.payload[0], "le payload doit suivre l'en-tete");

  t_encoded_audio_frame empty = make_frame(1, 0, 0);
  require(frame_sender_encode(buffer, &empty) == 0, "un payload vide doit etre refuse");
}

// Cette fonction verifie qu'un vrai socket local recoit exactement les octets produits.
static void test_send_over_loopback() {
  long port = 0;
  const SOCKET listener = listen_on_free_port(&port);

  t_frame_sender sender;
  frame_sender_construct(&sender);
  frame_sender_set_port(&sender, port);
  frame_sender_service(&sender);
  require(sender.connected.load(std::memory_order_relaxed) == 1, "le pont doit se connecter au port annonce");
  require(frame_sender_take_drop(&sender), "une connexion neuve doit demander une frame autonome");

  const SOCKET client = accept(listener, nullptr, nullptr);
  require(client != INVALID_SOCKET, "la connexion du pont doit etre acceptee");

  for (std::uint32_t sequence = 0; sequence < 3; sequence += 1) {
    const t_encoded_audio_frame frame = make_frame(sequence, sequence == 1 ? 1 : 0, 40 + sequence);
    require(frame_sender_send(&sender, &frame), "chaque frame doit partir sans erreur");

    unsigned char header[FRAME_SENDER_HEADER_BYTES] = {};
    read_exactly(client, header, (int)FRAME_SENDER_HEADER_BYTES);
    const std::size_t payload_size = ((std::size_t)header[18] << 8) | (std::size_t)header[19];
    require(payload_size == frame.payload_size, "la taille annoncee doit correspondre");

    std::vector<unsigned char> payload(payload_size, 0);
    read_exactly(client, payload.data(), (int)payload_size);
    require(std::memcmp(payload.data(), frame.payload, payload_size) == 0, "les octets recus doivent etre identiques");
    require(header[16] == frame.flags, "le flag transmis doit etre identique");
  }

  require(sender.sent_count.load(std::memory_order_relaxed) == 3, "les trois frames doivent etre comptees");
  require(!frame_sender_take_drop(&sender), "aucune perte ne doit etre signalee");

  closesocket(client);
  frame_sender_destruct(&sender);
  closesocket(listener);
}

// Cette fonction verifie qu'une coupure de Node est signalee comme une perte locale.
static void test_disconnect_marks_drop() {
  long port = 0;
  const SOCKET listener = listen_on_free_port(&port);

  t_frame_sender sender;
  frame_sender_construct(&sender);
  frame_sender_set_port(&sender, port);
  frame_sender_service(&sender);
  require(frame_sender_take_drop(&sender), "la connexion initiale signale deja une frame autonome");

  const SOCKET client = accept(listener, nullptr, nullptr);
  require(client != INVALID_SOCKET, "la connexion doit etre acceptee avant la coupure");
  closesocket(client);
  closesocket(listener);

  // Le premier envoi apres la fermeture peut reussir : le noyau ne detecte la coupure qu'ensuite.
  bool failed = false;
  for (int attempt = 0; attempt < 20 && !failed; attempt += 1) {
    const t_encoded_audio_frame frame = make_frame((std::uint32_t)attempt, 0, 40);
    failed = !frame_sender_send(&sender, &frame);
  }

  require(failed, "un envoi doit finir par echouer apres la coupure");
  require(sender.connected.load(std::memory_order_relaxed) == 0, "la coupure doit fermer la connexion");
  require(frame_sender_take_drop(&sender), "la coupure doit signaler une perte a l'encodeur");
  require(!frame_sender_take_drop(&sender), "le signal de perte doit etre consomme une seule fois");

  frame_sender_destruct(&sender);
}

// Cette fonction verifie qu'un port absent laisse le pont ferme sans bloquer.
static void test_missing_listener() {
  t_frame_sender sender;
  frame_sender_construct(&sender);

  frame_sender_set_port(&sender, 0);
  frame_sender_service(&sender);
  require(sender.connected.load(std::memory_order_relaxed) == 0, "sans port le pont reste ferme");

  const t_encoded_audio_frame frame = make_frame(0, 0, 40);
  require(!frame_sender_send(&sender, &frame), "sans connexion l'envoi doit echouer");
  require(sender.dropped_count.load(std::memory_order_relaxed) == 0, "un pont ferme ne compte pas de perte de transmission");

  frame_sender_destruct(&sender);
}

// Cette fonction verifie qu'un port annonce mais injoignable compte bien ses frames perdues.
static void test_unreachable_port_counts_drops() {
  long port = 0;
  const SOCKET listener = listen_on_free_port(&port);
  // Le port est libere avant l'annonce : plus personne n'ecoute, mais le pont reste attendu.
  closesocket(listener);

  t_frame_sender sender;
  frame_sender_construct(&sender);
  frame_sender_set_port(&sender, port);
  frame_sender_service(&sender);
  require(sender.connected.load(std::memory_order_relaxed) == 0, "un port injoignable ne doit pas se connecter");

  for (std::uint32_t sequence = 0; sequence < 3; sequence += 1) {
    const t_encoded_audio_frame frame = make_frame(sequence, 0, 40);
    require(!frame_sender_send(&sender, &frame), "l'envoi doit echouer sans connexion");
  }

  require(
    sender.dropped_count.load(std::memory_order_relaxed) == 3,
    "chaque frame jetee vers un port attendu doit etre comptee"
  );

  frame_sender_destruct(&sender);
}

// Cette fonction attend une echeance precise malgre la granularite de Sleep sous Windows.
static void wait_until(std::chrono::steady_clock::time_point deadline) {
  for (;;) {
    const auto remaining = deadline - std::chrono::steady_clock::now();
    if (remaining <= std::chrono::milliseconds(0)) {
      return;
    }
    if (remaining > std::chrono::milliseconds(5)) {
      Sleep(1);
    }
  }
}

// Cette fonction envoie un flux regulier vers un port deja ouvert par Node.
static int stream_to_port(long port, int frame_count, int interval_ms) {
  t_frame_sender sender;
  frame_sender_construct(&sender);
  frame_sender_set_port(&sender, port);
  frame_sender_service(&sender);

  if (sender.connected.load(std::memory_order_relaxed) == 0) {
    std::cerr << "ECHEC: la connexion au port " << port << " a echoue\n";
    frame_sender_destruct(&sender);
    return 1;
  }

  auto deadline = std::chrono::steady_clock::now();
  for (int index = 0; index < frame_count; index += 1) {
    const std::size_t size = (std::size_t)(40 + (index % 100));
    const t_encoded_audio_frame frame = make_frame((std::uint32_t)index, (index % 50) == 0 ? 1 : 0, size);
    if (!frame_sender_send(&sender, &frame)) {
      std::cerr << "ECHEC: envoi interrompu a la frame " << index << '\n';
      frame_sender_destruct(&sender);
      return 1;
    }
    if (interval_ms > 0) {
      deadline += std::chrono::milliseconds(interval_ms);
      wait_until(deadline);
    }
  }

  frame_sender_destruct(&sender);
  return 0;
}

// Cette fonction execute tous les controles du pont interne.
int main(int argc, char **argv) {
  // Le test cree ses propres sockets d'ecoute : il initialise Winsock pour lui-meme.
  WSADATA winsock_data;
  require(WSAStartup(MAKEWORD(2, 2), &winsock_data) == 0, "Winsock doit demarrer pour le test");

  // Ce mode sert au test de bout en bout pilote par Node et a la mesure longue manuelle.
  if (argc >= 4 && std::strcmp(argv[1], "--stream") == 0) {
    const int result = stream_to_port(std::atol(argv[2]), std::atoi(argv[3]), argc >= 5 ? std::atoi(argv[4]) : 0);
    WSACleanup();
    return result;
  }

  test_reference_bytes();
  test_encode_header();
  test_send_over_loopback();
  test_disconnect_marks_drop();
  test_missing_listener();
  test_unreachable_port_counts_drops();
  WSACleanup();
  std::cout << "OK: tous les tests natifs du pont loopback passent\n";
  return 0;
}
