import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { decodeAudioPacket } from "../src/protocol/audio-packet.ts";
import { startRelay, TestClient, TEST_TOKEN, waitFor } from "./relay-harness.ts";

// Ce fichier branche le vrai publisher du device sur le vrai relais. Les autres tests utilisent des
// clients de test : celui-ci verifie que les deux moities ecrites separement se comprennent.

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { Publisher, LIVE, ERROR } = require("../device/node/publisher.js");

// Cette fonction cree une frame identique a celle que le pont loopback remet a Node.
function makeFrame(sequence: number): { sequence: number; timestampMicros: bigint; flags: number; payload: Buffer } {
  const payload = Buffer.alloc(40);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (sequence * 7 + index) & 0xff;
  }

  return { sequence, timestampMicros: BigInt(sequence) * 40000n, flags: 0, payload };
}

// Cette fonction cree le publisher du device branche sur une adresse et un token donnes.
// Les paliers de reconnexion reels vont de 1 a 30 secondes : un test ne peut pas les attendre.
function makeDevicePublisher(relayUrl: string, token: string) {
  const states: { state: string; detail: string }[] = [];
  const encoderActions: string[] = [];
  const publisher = new Publisher({
    onState: (state: string, detail: string) => states.push({ state, detail }),
    onEncoder: (action: string) => encoderActions.push(action),
    loadConfig: () => ({ relayUrl, publisherToken: token }),
    delayFor: () => 20,
  });

  return { publisher, states, encoderActions };
}

// Ce test verifie la chaine complete : device authentifie, session ouverte, paquets recus par la
// page, octets identiques d'un bout a l'autre.
test("le publisher du device ouvre un direct que le listener recoit", async () => {
  const relay = await startRelay();
  const { publisher, encoderActions } = makeDevicePublisher(relay.publisherUrl, TEST_TOKEN);

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    await waitFor(() => listener.json.length === 1, "etat hors ligne");

    publisher.start({ bitrate: 192000, latencyProfile: "low" });
    await waitFor(() => publisher.state === LIVE, "publisher en direct");
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    const etat = listener.json[1] as Record<string, unknown>;
    assert.equal(etat.live, true);
    assert.equal(etat.bitrate, 192000);
    assert.equal(etat.latencyProfile, "low");
    assert.equal(etat.sampleRate, 48000);
    assert.deepEqual(encoderActions, ["start"]);

    const frames = [makeFrame(0), makeFrame(1), makeFrame(2)];
    for (const frame of frames) {
      assert.equal(publisher.sendFrame(frame), true);
    }

    await waitFor(() => listener.binary.length === 3, "trois paquets recus");

    for (let index = 0; index < frames.length; index += 1) {
      const recu = decodeAudioPacket(listener.binary[index] as Buffer);
      assert.equal(recu.header.sessionId, etat.sessionId);
      assert.equal(recu.header.sequenceNumber, index);
      assert.equal(recu.header.timestampMicros, BigInt(index) * 40000n);
      assert.deepEqual(Buffer.from(recu.payload), frames[index]?.payload);
    }

    const sante = relay.relay.health();
    assert.equal(sante.live, true);
    assert.equal(sante.framesRelayed, 3);
    assert.equal(sante.packetsRefused, 0);
  } finally {
    publisher.stop();
    await relay.close();
  }
});

// Ce test verifie que l'arret demande dans Ableton remet la page hors ligne tout de suite,
// par le `stream_stop` du device et non par l'expiration de la connexion.
test("l'arret du device remet le listener hors ligne", async () => {
  const relay = await startRelay();
  const { publisher } = makeDevicePublisher(relay.publisherUrl, TEST_TOKEN);

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    publisher.start({ bitrate: 256000, latencyProfile: "balanced" });
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    publisher.stop("user_stop");
    await waitFor(() => listener.messagesOfType("stream_state").length === 3, "retour hors ligne");

    assert.equal(listener.json[2]?.live, false);
    assert.equal(relay.relay.health().live, false);
  } finally {
    publisher.stop();
    await relay.close();
  }
});

// Ce test verifie qu'un mauvais token donne une erreur lisible dans le device, sans exposer le
// token et sans reconnexion en boucle.
test("un mauvais token arrete le publisher du device sur une erreur lisible", async () => {
  const relay = await startRelay();
  const { publisher, states, encoderActions } = makeDevicePublisher(relay.publisherUrl, "mauvais_token_de_test");

  try {
    publisher.start({ bitrate: 256000, latencyProfile: "balanced" });
    await waitFor(() => publisher.state === ERROR, "publisher en erreur");

    assert.match(publisher.detail, /invalid_token/);
    // L'encodeur n'a jamais demarre : aucun son ne part vers un relais qui refuse le token.
    assert.ok(!encoderActions.includes("start"));

    const texte = JSON.stringify(states);
    assert.ok(!texte.includes("mauvais_token_de_test"));
    assert.ok(!texte.includes(TEST_TOKEN));
  } finally {
    publisher.stop();
    await relay.close();
  }
});

// Ce test verifie le cas d'une connexion publisher restee ouverte alors qu'elle ne sert plus :
// un nouveau publisher authentifie prend la place, et le device reconnecte reprend la sienne avec
// une nouvelle session. La page suit ces changements sans rester bloquee sur un flux mort.
test("le device reprend sa place apres avoir ete remplace", async () => {
  const relay = await startRelay();
  const { publisher } = makeDevicePublisher(relay.publisherUrl, TEST_TOKEN);

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    publisher.start({ bitrate: 256000, latencyProfile: "balanced" });
    await waitFor(() => publisher.state === LIVE, "premier direct");
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    const premiereSession = listener.json[1]?.sessionId;

    const intrus = await TestClient.connect(relay.publisherUrl);
    intrus.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });

    // Le device perd sa connexion, reconnecte, reprend la place et ouvre une autre session.
    await waitFor(() => listener.messagesOfType("stream_state").length >= 4, "nouvelle session");
    await waitFor(() => publisher.state === LIVE, "device de nouveau en direct");

    const etats = listener.messagesOfType("stream_state");
    const dernier = etats[etats.length - 1] as Record<string, unknown>;
    assert.equal(dernier.live, true);
    assert.notEqual(dernier.sessionId, premiereSession);
    assert.equal(intrus.closed, true);

    publisher.sendFrame(makeFrame(0));
    await waitFor(() => listener.binary.length === 1, "paquet de la nouvelle session");
    assert.equal(decodeAudioPacket(listener.binary[0] as Buffer).header.sessionId, dernier.sessionId);
  } finally {
    publisher.stop();
    await relay.close();
  }
});
