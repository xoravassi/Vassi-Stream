#pragma once

#include "audio_encoder.h"

#include <atomic>
#include <cstddef>
#include <cstdint>

// Le pont interne prefixe chaque frame Opus avec cet en-tete de 20 octets en big-endian.
static const std::size_t FRAME_SENDER_HEADER_BYTES = 20;
static const std::size_t FRAME_SENDER_MAX_BYTES = FRAME_SENDER_HEADER_BYTES + OPUS_MAX_PACKET_BYTES;
// Le tampon d'envoi du noyau reste petit pour que le pont abandonne l'audio ancien au lieu de le retarder.
static const int FRAME_SENDER_SOCKET_BUFFER_BYTES = 8192;
// Un envoi bloque plus longtemps que cette duree signifie que Node ne suit plus.
static const int FRAME_SENDER_SEND_TIMEOUT_MS = 50;
// Une tentative de connexion ratee attend ce delai avant la suivante.
static const long FRAME_SENDER_RETRY_MS = 250;

using t_sender_count = unsigned long long;
using t_atomic_sender_count = std::atomic<t_sender_count>;
using t_atomic_sender_long = std::atomic<long>;

// Cette structure contient la connexion loopback vers node.script et ses compteurs.
struct t_frame_sender {
  std::uintptr_t socket_handle;
  bool socket_layer_ready;
  long open_port;
  long long next_retry_ms;
  t_atomic_sender_long wanted_port;
  t_atomic_sender_long connected;
  t_atomic_sender_long drop_pending;
  t_atomic_sender_count sent_count;
  t_atomic_sender_count dropped_count;
  unsigned char buffer[FRAME_SENDER_MAX_BYTES];
};

// Cette fonction ecrit l'en-tete VSF1 et retourne la taille totale du message.
std::size_t frame_sender_encode(unsigned char *buffer, const t_encoded_audio_frame *frame);

// Cette fonction prepare la couche socket et remet les compteurs a zero.
void frame_sender_construct(t_frame_sender *sender);

// Cette fonction ferme la connexion et libere la couche socket.
void frame_sender_destruct(t_frame_sender *sender);

// Cette fonction enregistre le port annonce par Node depuis le thread message de Max.
void frame_sender_set_port(t_frame_sender *sender, long port);

// Cette fonction ouvre ou ferme la connexion pour suivre le port demande.
void frame_sender_service(t_frame_sender *sender);

// Cette fonction envoie une frame complete et signale une perte de transmission.
bool frame_sender_send(t_frame_sender *sender, const t_encoded_audio_frame *frame);

// Cette fonction indique si une frame a ete abandonnee depuis le dernier appel.
bool frame_sender_take_drop(t_frame_sender *sender);

// Cette fonction ferme la connexion sans oublier le port demande.
void frame_sender_close(t_frame_sender *sender);

// Cette fonction remet les compteurs visibles a zero sans toucher a la connexion.
void frame_sender_reset_diagnostics(t_frame_sender *sender);
