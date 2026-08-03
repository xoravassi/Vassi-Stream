#include "frame_sender.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <chrono>
#include <cstring>
#include <new>

// Cette valeur represente l'absence de connexion dans le champ portable de la structure.
static const std::uintptr_t FRAME_SENDER_NO_SOCKET = (std::uintptr_t)INVALID_SOCKET;

// Cette fonction ecrit un entier 16 bits en big-endian comme le reste du projet.
static void frame_sender_write_uint16(unsigned char *buffer, std::uint16_t value) {
  buffer[0] = (unsigned char)((value >> 8) & 0xff);
  buffer[1] = (unsigned char)(value & 0xff);
}

// Cette fonction ecrit un entier 32 bits en big-endian.
static void frame_sender_write_uint32(unsigned char *buffer, std::uint32_t value) {
  buffer[0] = (unsigned char)((value >> 24) & 0xff);
  buffer[1] = (unsigned char)((value >> 16) & 0xff);
  buffer[2] = (unsigned char)((value >> 8) & 0xff);
  buffer[3] = (unsigned char)(value & 0xff);
}

// Cette fonction ecrit un entier 64 bits en big-endian.
static void frame_sender_write_uint64(unsigned char *buffer, std::uint64_t value) {
  frame_sender_write_uint32(buffer, (std::uint32_t)(value >> 32));
  frame_sender_write_uint32(buffer + 4, (std::uint32_t)(value & 0xffffffffULL));
}

// Cette fonction lit une horloge monotone en millisecondes pour espacer les reconnexions.
static long long frame_sender_now_ms() {
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

// Cette fonction serialise une frame Opus dans le format interne VSF1.
std::size_t frame_sender_encode(unsigned char *buffer, const t_encoded_audio_frame *frame) {
  if (buffer == nullptr || frame == nullptr || frame->payload_size == 0
      || frame->payload_size > OPUS_MAX_PACKET_BYTES) {
    return 0;
  }

  buffer[0] = 'V';
  buffer[1] = 'S';
  buffer[2] = 'F';
  buffer[3] = '1';
  frame_sender_write_uint32(buffer + 4, frame->sequence);
  frame_sender_write_uint64(buffer + 8, frame->timestamp_us);
  buffer[16] = frame->flags;
  buffer[17] = 0;
  frame_sender_write_uint16(buffer + 18, (std::uint16_t)frame->payload_size);
  std::memcpy(buffer + FRAME_SENDER_HEADER_BYTES, frame->payload, frame->payload_size);
  return FRAME_SENDER_HEADER_BYTES + frame->payload_size;
}

// Cette fonction initialise Winsock une fois par objet et remet les compteurs a zero.
void frame_sender_construct(t_frame_sender *sender) {
  WSADATA winsock_data;
  // Le resultat est retenu : WSACleanup ne doit equilibrer qu'un WSAStartup reussi, sinon il
  // decrementerait le compteur d'un autre composant du processus Max.
  sender->socket_layer_ready = WSAStartup(MAKEWORD(2, 2), &winsock_data) == 0;

  sender->socket_handle = FRAME_SENDER_NO_SOCKET;
  sender->open_port = 0;
  sender->next_retry_ms = 0;
  new (&sender->wanted_port) t_atomic_sender_long(0);
  new (&sender->connected) t_atomic_sender_long(0);
  new (&sender->drop_pending) t_atomic_sender_long(0);
  new (&sender->sent_count) t_atomic_sender_count(0);
  new (&sender->dropped_count) t_atomic_sender_count(0);
}

// Cette fonction ferme la connexion puis rend sa reference a Winsock.
void frame_sender_destruct(t_frame_sender *sender) {
  frame_sender_close(sender);
  sender->dropped_count.~t_atomic_sender_count();
  sender->sent_count.~t_atomic_sender_count();
  sender->drop_pending.~t_atomic_sender_long();
  sender->connected.~t_atomic_sender_long();
  sender->wanted_port.~t_atomic_sender_long();
  if (sender->socket_layer_ready) {
    WSACleanup();
    sender->socket_layer_ready = false;
  }
}

// Cette fonction ferme le socket courant et publie l'etat deconnecte.
void frame_sender_close(t_frame_sender *sender) {
  if (sender->socket_handle != FRAME_SENDER_NO_SOCKET) {
    closesocket((SOCKET)sender->socket_handle);
    sender->socket_handle = FRAME_SENDER_NO_SOCKET;
  }

  sender->open_port = 0;
  sender->connected.store(0, std::memory_order_release);
}

// Cette fonction accepte un port valide ou zero pour demander la fermeture.
void frame_sender_set_port(t_frame_sender *sender, long port) {
  const long checked = (port > 0 && port <= 65535) ? port : 0;
  sender->wanted_port.store(checked, std::memory_order_release);
}

// Cette fonction cree un socket loopback configure pour un flux direct et borne.
static bool frame_sender_open(t_frame_sender *sender, long port) {
  const SOCKET handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (handle == INVALID_SOCKET) {
    return false;
  }

  const int timeout = FRAME_SENDER_SEND_TIMEOUT_MS;
  const int buffer_bytes = FRAME_SENDER_SOCKET_BUFFER_BYTES;
  const int no_delay = 1;
  setsockopt(handle, SOL_SOCKET, SO_SNDTIMEO, (const char *)&timeout, sizeof(timeout));
  setsockopt(handle, SOL_SOCKET, SO_SNDBUF, (const char *)&buffer_bytes, sizeof(buffer_bytes));
  setsockopt(handle, IPPROTO_TCP, TCP_NODELAY, (const char *)&no_delay, sizeof(no_delay));

  sockaddr_in address = {};
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  if (connect(handle, (const sockaddr *)&address, sizeof(address)) != 0) {
    closesocket(handle);
    return false;
  }

  sender->socket_handle = (std::uintptr_t)handle;
  sender->open_port = port;
  // Node n'a pas recu les frames precedentes : la premiere frame envoyee doit etre autonome.
  sender->drop_pending.store(1, std::memory_order_release);
  sender->connected.store(1, std::memory_order_release);
  return true;
}

// Cette fonction aligne la connexion sur le port demande sans bloquer le worker.
void frame_sender_service(t_frame_sender *sender) {
  if (!sender->socket_layer_ready) {
    return;
  }

  const long wanted = sender->wanted_port.load(std::memory_order_acquire);

  if (wanted != sender->open_port && sender->socket_handle != FRAME_SENDER_NO_SOCKET) {
    frame_sender_close(sender);
  }

  if (wanted == 0 || sender->socket_handle != FRAME_SENDER_NO_SOCKET) {
    return;
  }

  const long long now = frame_sender_now_ms();
  if (now < sender->next_retry_ms) {
    return;
  }

  sender->next_retry_ms = now + FRAME_SENDER_RETRY_MS;
  frame_sender_open(sender, wanted);
}

// Cette fonction envoie tous les octets d'une frame ou signale un echec.
static bool frame_sender_send_all(t_frame_sender *sender, std::size_t size) {
  std::size_t written = 0;

  while (written < size) {
    const int result = send(
      (SOCKET)sender->socket_handle,
      (const char *)sender->buffer + written,
      (int)(size - written),
      0
    );
    if (result <= 0) {
      return false;
    }
    written += (std::size_t)result;
  }

  return true;
}

// Cette fonction remet une frame a Node et ferme la connexion des qu'un envoi echoue.
bool frame_sender_send(t_frame_sender *sender, const t_encoded_audio_frame *frame) {
  if (sender->socket_handle == FRAME_SENDER_NO_SOCKET) {
    // Un pont volontairement ferme n'est pas une perte. Un port annonce mais injoignable en est une :
    // sans ce comptage, un Node absent laisserait le diagnostic afficher zero frame perdue.
    if (sender->wanted_port.load(std::memory_order_acquire) != 0) {
      sender->dropped_count.fetch_add(1, std::memory_order_relaxed);
    }
    return false;
  }

  const std::size_t size = frame_sender_encode(sender->buffer, frame);
  if (size == 0 || !frame_sender_send_all(sender, size)) {
    // Une frame incomplete desynchroniserait le flux : la connexion est refaite proprement.
    frame_sender_close(sender);
    sender->dropped_count.fetch_add(1, std::memory_order_relaxed);
    sender->drop_pending.store(1, std::memory_order_release);
    return false;
  }

  sender->sent_count.fetch_add(1, std::memory_order_relaxed);
  return true;
}

// Cette fonction remet les compteurs de frames a zero pour un nouveau live.
void frame_sender_reset_diagnostics(t_frame_sender *sender) {
  sender->sent_count.store(0, std::memory_order_relaxed);
  sender->dropped_count.store(0, std::memory_order_relaxed);
  sender->drop_pending.store(0, std::memory_order_relaxed);
}

// Cette fonction consomme le signal de perte lu par le worker avant la frame suivante.
bool frame_sender_take_drop(t_frame_sender *sender) {
  return sender->drop_pending.exchange(0, std::memory_order_acq_rel) != 0;
}
