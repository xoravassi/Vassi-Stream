import { readFileSync } from "node:fs";

import { WebSocket } from "ws";

// Ce module rejoue la fixture Opus vers le relais local, comme le ferait le device pendant un live.
// Il sert uniquement a la page de test du player : il n'entre ni dans le device ni dans le relais.

// Le protocole place 28 octets d'en-tete devant chaque payload Opus.
const HEADER_BYTES = 28;
// Une frame porte 20 ms d'audio : la fixture est donc rejouee a cinquante paquets par seconde.
const FRAME_MS = 20;

// Cette fonction decoupe la fixture en paquets complets et garde seulement leur payload : les
// en-tetes sont reecrits a l'envoi, avec la session et la sequence du direct en cours.
function readPayloads(path) {
  const content = readFileSync(path);
  const payloads = [];
  let position = 0;

  while (position < content.length) {
    const size = content.readUInt16BE(position + 26);
    payloads.push(content.subarray(position + HEADER_BYTES, position + HEADER_BYTES + size));
    position += HEADER_BYTES + size;
  }

  return payloads;
}

// Cette fonction ecrit un paquet VSA1 autour d'un payload Opus.
function buildPacket(sessionId, sequence, payload) {
  const packet = Buffer.allocUnsafe(HEADER_BYTES + payload.length);

  packet.write("VSA1", 0, "ascii");
  packet.writeUInt8(1, 4);
  packet.writeUInt8(1, 5);
  packet.writeUInt8(0, 6);
  packet.writeUInt8(2, 7);
  packet.writeUInt32BE(sessionId, 8);
  packet.writeUInt32BE(sequence, 12);
  packet.writeBigUInt64BE(BigInt(sequence) * BigInt(FRAME_MS * 1000), 16);
  packet.writeUInt16BE(960, 24);
  packet.writeUInt16BE(payload.length, 26);
  payload.copy(packet, HEADER_BYTES);

  return packet;
}

// Cette fonction ouvre un publisher qui rejoue la fixture en boucle et sait se couper sur demande.
export function startFixturePublisher(url, token, fixturePath, latencyProfile = "balanced") {
  const payloads = readPayloads(fixturePath);
  let socket = null;
  let timer = null;
  let sessionId = 0;
  let sequence = 0;
  let index = 0;
  let stopped = false;

  // Cette fonction ouvre la connexion, s'authentifie et ouvre une nouvelle session.
  function connect() {
    if (stopped) {
      return;
    }

    sessionId = 1 + Math.floor(Math.random() * 4294967294);
    sequence = 0;
    index = 0;
    socket = new WebSocket(url, { perMessageDeflate: false });

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "publisher_auth", protocolVersion: 1, token }));
    });

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());

      if (message.type !== "auth_ok") {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "stream_start",
          protocolVersion: 1,
          sessionId,
          codec: "opus",
          bitrate: 256000,
          sampleRate: 48000,
          channels: 2,
          frameDurationMs: FRAME_MS,
          latencyProfile,
        }),
      );

      timer = setInterval(send, FRAME_MS);
    });

    socket.on("close", () => {
      clearInterval(timer);
      timer = null;

      if (!stopped) {
        setTimeout(connect, 500);
      }
    });

    socket.on("error", () => {});
  }

  // Cette fonction envoie le paquet suivant et revient au debut de la fixture a la fin.
  function send() {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(buildPacket(sessionId, sequence, payloads[index]), { binary: true });
    sequence += 1;
    index = (index + 1) % payloads.length;
  }

  connect();

  return {
    // Cette methode coupe le direct pendant une duree, pour verifier ce que fait la page devant une
    // coupure reelle. La reconnexion cree une nouvelle session, comme le prevoit le protocole.
    cut(durationMs) {
      if (socket === null) {
        return;
      }

      const current = socket;
      socket = null;
      clearInterval(timer);
      timer = null;
      current.terminate();
      setTimeout(connect, durationMs);
    },

    stop() {
      stopped = true;
      clearInterval(timer);
      socket?.terminate();
    },
  };
}
