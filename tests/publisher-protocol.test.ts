import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { decodeAudioPacket, encodeAudioPacket } from "../src/protocol/audio-packet.ts";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const protocol = require("../device/node/publisher-protocol.js");

// Ce test verifie que les deux implementations produisent exactement les memes octets.
// Le device ecrit l'en-tete en CommonJS et le reste du projet le lit en TypeScript :
// sans cette comparaison, les deux pourraient diverger sans que rien ne le signale.
test("produit le meme paquet binaire que le module TypeScript de reference", () => {
  const payload = Buffer.from([1, 2, 3, 250, 255, 0, 128]);
  const input = {
    sessionId: 3735928559,
    sequenceNumber: 123456,
    timestampMicros: 2469135800n,
    flags: 1,
    payload,
  };

  const fromDevice: Buffer = protocol.encodeAudioPacket(input);
  const fromReference = encodeAudioPacket({ ...input, payload: new Uint8Array(payload) });

  assert.deepEqual(new Uint8Array(fromDevice), fromReference);
  assert.equal(fromDevice.length, protocol.HEADER_SIZE + payload.length);
});

// Ce test verifie que le paquet du device se relit avec les memes champs.
test("relit un paquet du device avec les memes champs", () => {
  const payload = Buffer.alloc(protocol.MAX_PAYLOAD_SIZE, 7);
  const packet = protocol.encodeAudioPacket({
    sessionId: 1,
    sequenceNumber: protocol.MAX_UINT32,
    timestampMicros: 0n,
    flags: 0,
    payload,
  });

  const decoded = decodeAudioPacket(packet);
  assert.equal(decoded.header.sessionId, 1);
  assert.equal(decoded.header.sequenceNumber, protocol.MAX_UINT32);
  assert.equal(decoded.header.sampleCount, 960);
  assert.equal(decoded.header.channelCount, 2);
  assert.equal(decoded.header.payloadSize, protocol.MAX_PAYLOAD_SIZE);
  assert.deepEqual(Buffer.from(decoded.payload), payload);
});

// Ce test verifie que le payload Opus n'est jamais modifie, meme s'il vient d'une vue partielle.
test("recopie le payload sans le modifier depuis une vue partielle", () => {
  const storage = Buffer.from([9, 9, 11, 22, 33, 9, 9]);
  const payload = storage.subarray(2, 5);
  const packet = protocol.encodeAudioPacket({
    sessionId: 42,
    sequenceNumber: 0,
    timestampMicros: 0n,
    flags: 0,
    payload,
  });

  assert.deepEqual(Buffer.from(decodeAudioPacket(packet).payload), Buffer.from([11, 22, 33]));
});

// Ce test verifie les valeurs hors limites refusees avant toute ecriture binaire.
test("refuse les entrees impossibles", () => {
  const payload = Buffer.from([1]);
  const base = { sessionId: 1, sequenceNumber: 0, timestampMicros: 0n, flags: 0, payload };

  assert.throws(() => protocol.encodeAudioPacket({ ...base, sessionId: 0 }), /session_id_invalide/);
  assert.throws(() => protocol.encodeAudioPacket({ ...base, sequenceNumber: -1 }), /sequence_hors_limites/);
  assert.throws(() => protocol.encodeAudioPacket({ ...base, flags: 2 }), /flags_invalides/);
  assert.throws(() => protocol.encodeAudioPacket({ ...base, payload: Buffer.alloc(0) }), /payload_taille_invalide/);
  assert.throws(
    () => protocol.encodeAudioPacket({ ...base, payload: Buffer.alloc(protocol.MAX_PAYLOAD_SIZE + 1) }),
    /payload_taille_invalide/,
  );
});

// Ce test verifie la forme des trois messages JSON envoyes par le publisher.
test("construit les messages JSON du protocole v1", () => {
  const auth = JSON.parse(protocol.buildAuthMessage("secret"));
  assert.deepEqual(auth, { type: "publisher_auth", protocolVersion: 1, token: "secret" });

  const start = JSON.parse(protocol.buildStreamStart({
    sessionId: 7,
    bitrate: 192000,
    latencyProfile: "low",
  }));
  assert.deepEqual(start, {
    type: "stream_start",
    protocolVersion: 1,
    sessionId: 7,
    codec: "opus",
    bitrate: 192000,
    sampleRate: 48000,
    channels: 2,
    frameDurationMs: 20,
    latencyProfile: "low",
  });

  const stop = JSON.parse(protocol.buildStreamStop(7, "user_stop"));
  assert.deepEqual(stop, { type: "stream_stop", protocolVersion: 1, sessionId: 7, reason: "user_stop" });

  assert.throws(() => protocol.buildStreamStart({ sessionId: 7, bitrate: 64000, latencyProfile: "low" }), /bitrate_invalide/);
  assert.throws(() => protocol.buildStreamStart({ sessionId: 7, bitrate: 192000, latencyProfile: "rapide" }), /profil_latence_invalide/);
  assert.throws(() => protocol.buildStreamStop(7, "panique"), /stream_stop_raison_invalide/);
});

// Ce test verifie que les reponses du relais hors protocole sont refusees.
test("refuse un message serveur hors protocole v1", () => {
  assert.deepEqual(protocol.parseServerMessage('{"type":"auth_ok","protocolVersion":1}'), {
    type: "auth_ok",
    protocolVersion: 1,
  });

  assert.throws(() => protocol.parseServerMessage("pas du json"), /message_json_invalide/);
  assert.throws(() => protocol.parseServerMessage("[1,2]"), /message_json_invalide/);
  assert.throws(() => protocol.parseServerMessage('{"protocolVersion":1}'), /message_type_absent/);
  assert.throws(() => protocol.parseServerMessage('{"type":"auth_ok","protocolVersion":2}'), /message_version_invalide/);
});

// Ce test verifie que chaque session recoit un identifiant utilisable et different du precedent.
test("cree un identifiant de session valide et jamais repete", () => {
  let previous = 0;

  for (let index = 0; index < 200; index += 1) {
    const sessionId: number = protocol.createSessionId(previous);
    assert.ok(Number.isInteger(sessionId));
    assert.ok(sessionId >= 1 && sessionId <= protocol.MAX_UINT32);
    assert.notEqual(sessionId, previous);
    previous = sessionId;
  }
});

// Ce test verifie que la version de `ws` du device est aussi celle utilisee par les tests.
// Deux versions differentes rendraient les tests inutiles : ils ne verifieraient pas le device.
test("verrouille la meme version de ws des deux cotes", () => {
  const deviceManifest = require("../device/node/package.json");
  const rootManifest = require("../package.json");

  assert.equal(deviceManifest.dependencies.ws, rootManifest.devDependencies.ws);
  assert.match(deviceManifest.dependencies.ws, /^\d+\.\d+\.\d+$/);
});
