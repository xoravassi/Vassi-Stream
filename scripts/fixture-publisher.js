import { readFileSync } from "node:fs";

import { WebSocket } from "ws";

// Ce module rejoue la fixture Opus vers le relais local, comme le ferait le device pendant un live.
// Il sert uniquement a la page de test du player : il n'entre ni dans le device ni dans le relais.

// Le protocole place 28 octets d'en-tete devant chaque payload Opus.
const HEADER_BYTES = 28;
// Une frame porte 20 ms d'audio : la fixture est donc rejouee a cinquante paquets par seconde.
const FRAME_MS = 20;

// Le rythme est repris a chaque reveil du minuteur, pas a chaque frame. Windows n'accorde pas mieux
// que 15,6 ms a un minuteur ordinaire : demander 20 ms donne en realite un reveil toutes les
// 31,2 ms, soit 32 paquets par seconde au lieu de 50. Un reveil rapide qui envoie ce qui est du
// rend le debit moyen exact malgre la granularite du systeme.
const TICK_MS = 5;

// Au-dela de ce retard, la machine a reellement dormi : le publisher repart du direct au lieu de
// deverser d'un coup les paquets manquants. C'est ce que ferait un vrai direct.
const MAX_CATCHUP_PACKETS = 50;

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
  let reconnect = null;
  let sessionId = 0;
  let sequence = 0;
  let index = 0;
  let startedAt = 0;
  let stopped = false;

  // Cette fonction arrete l'envoi sans toucher a la connexion.
  function stopSending() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Cette fonction programme une seule reconnexion. Une reconnexion deja prevue est annulee : deux
  // publishers vivants a la fois se remplaceraient l'un l'autre sans fin chez le relais, qui donne
  // la place au dernier authentifie.
  function scheduleConnect(delayMs) {
    if (reconnect !== null) {
      clearTimeout(reconnect);
    }

    reconnect = setTimeout(() => {
      reconnect = null;
      connect();
    }, delayMs);
  }

  // Cette fonction ferme la connexion courante sans laisser ses evenements programmer quoi que ce
  // soit. C'est ce detachement qui distingue une coupure demandee d'une coupure subie.
  function dropSocket() {
    stopSending();

    const current = socket;
    socket = null;

    if (current !== null) {
      current.removeAllListeners();
      current.on("error", () => {});
      current.terminate();
    }
  }

  // Cette fonction ouvre la connexion, s'authentifie et ouvre une nouvelle session.
  function connect() {
    if (stopped) {
      return;
    }

    dropSocket();

    sessionId = 1 + Math.floor(Math.random() * 4294967294);
    sequence = 0;
    index = 0;

    const current = new WebSocket(url, { perMessageDeflate: false });
    socket = current;

    current.on("open", () => {
      current.send(JSON.stringify({ type: "publisher_auth", protocolVersion: 1, token }));
    });

    current.on("message", (data) => {
      const message = JSON.parse(data.toString());

      if (message.type !== "auth_ok" || current !== socket) {
        return;
      }

      current.send(
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

      startedAt = Date.now();
      stopSending();
      timer = setInterval(pump, TICK_MS);
    });

    // Une coupure subie, elle, doit revenir seule. Le test verifie que cette connexion n'est plus
    // la connexion courante : une connexion deja remplacee n'a plus rien a programmer.
    current.on("close", () => {
      if (current !== socket) {
        return;
      }

      stopSending();
      socket = null;

      if (!stopped) {
        scheduleConnect(500);
      }
    });

    current.on("error", () => {});
  }

  // Cette fonction envoie tous les paquets dus depuis le debut de la session. Le rythme suit
  // l'horloge, pas le minuteur : c'est la seule facon d'obtenir cinquante paquets par seconde sur
  // un systeme qui ne reveille pas un minuteur plus souvent que toutes les 15,6 ms.
  function pump() {
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const due = Math.floor((Date.now() - startedAt) / FRAME_MS);

    if (due - sequence > MAX_CATCHUP_PACKETS) {
      sequence = due;
      return;
    }

    while (sequence < due) {
      socket.send(buildPacket(sessionId, sequence, payloads[index]), { binary: true });
      sequence += 1;
      index = (index + 1) % payloads.length;
    }
  }

  connect();

  return {
    // Cette methode coupe le direct pendant une duree, pour verifier ce que fait la page devant une
    // coupure reelle. La reconnexion cree une nouvelle session, comme le prevoit le protocole.
    cut(durationMs) {
      dropSocket();
      scheduleConnect(durationMs);
    },

    stop() {
      stopped = true;

      if (reconnect !== null) {
        clearTimeout(reconnect);
        reconnect = null;
      }

      dropSocket();
    },
  };
}
