import assert from "node:assert/strict";
import test from "node:test";

import {
  audioPacket,
  readHealth,
  startLive,
  startRelay,
  streamStartMessage,
  TestClient,
  TEST_TOKEN,
  waitFor,
} from "./relay-harness.ts";

// Ce fichier verifie les refus du relais : ce qu'il rejette, ce qu'il ferme, et surtout ce qui ne
// doit jamais couper un direct en cours.

// Ce test verifie qu'aucun octet audio ne passe avant l'authentification.
test("ferme une connexion qui envoie de l'audio avant son token", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const inconnu = await TestClient.connect(relay.publisherUrl);

    inconnu.sendBinary(audioPacket(1, 0, 1));
    await waitFor(() => inconnu.closed, "fermeture de la connexion sans token");

    assert.equal(inconnu.messagesOfType("server_error")[0]?.reason, "not_authenticated");
    assert.equal(inconnu.closeCode, 1008);
    assert.equal(listener.binary.length, 0);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un `stream_start` sans authentification est refuse.
test("ferme une connexion qui ouvre une session sans token", async () => {
  const relay = await startRelay();

  try {
    const inconnu = await TestClient.connect(relay.publisherUrl);
    inconnu.sendJson(streamStartMessage(12));
    await waitFor(() => inconnu.closed, "fermeture de la session sans token");

    assert.equal(inconnu.messagesOfType("server_error")[0]?.reason, "not_authenticated");
    assert.equal(relay.relay.health().live, false);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'une frame recue avant `stream_start` est refusee sans fermer la connexion :
// le publisher doit pouvoir ouvrir sa session juste apres.
test("refuse une frame avant stream_start sans couper la connexion", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const publisher = await TestClient.connect(relay.publisherUrl);

    publisher.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
    await waitFor(() => publisher.messagesOfType("auth_ok").length === 1, "auth_ok");

    publisher.sendBinary(audioPacket(5, 0, 1));
    await waitFor(() => publisher.messagesOfType("server_error").length === 1, "refus de la frame");
    assert.equal(publisher.messagesOfType("server_error")[0]?.reason, "no_active_session");
    assert.equal(publisher.closed, false);
    assert.equal(listener.binary.length, 0);

    publisher.sendJson(streamStartMessage(5));
    await waitFor(() => relay.relay.health().live, "direct ouvert");
    publisher.sendBinary(audioPacket(5, 0, 1));
    await waitFor(() => listener.binary.length === 1, "premier paquet diffuse");
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un paquet abime ou d'une autre session ne coupe pas le direct.
test("refuse un paquet invalide sans interrompre le direct", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const publisher = await startLive(relay, 3000);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    // En-tete tronque, magic invalide, puis session etrangere.
    publisher.sendBinary(audioPacket(3000, 0, 1).subarray(0, 12));
    publisher.sendBinary(Buffer.alloc(40, 9));
    publisher.sendBinary(audioPacket(1234, 0, 1));

    await waitFor(() => publisher.messagesOfType("server_error").length >= 1, "premier refus");

    publisher.sendBinary(audioPacket(3000, 0, 1));
    await waitFor(() => listener.binary.length === 1, "paquet valide diffuse");

    assert.equal(publisher.closed, false);
    assert.equal(relay.relay.health().live, true);
    assert.equal(relay.relay.health().framesRelayed, 1);
    // Les refus sont limites a un message par seconde : trois paquets invalides donnent un seul
    // message d'erreur, ce qui evite de repondre cinquante fois par seconde a un publisher casse.
    assert.equal(publisher.messagesOfType("server_error").length, 1);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un `stream_start` hors des valeurs du protocole n'ouvre pas de direct.
test("refuse un stream_start hors des valeurs du protocole", async () => {
  const relay = await startRelay();

  try {
    const publisher = await TestClient.connect(relay.publisherUrl);
    publisher.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
    await waitFor(() => publisher.messagesOfType("auth_ok").length === 1, "auth_ok");

    publisher.sendJson(streamStartMessage(9, { bitrate: 320000 }));
    await waitFor(() => publisher.closed, "fermeture apres stream_start invalide");

    assert.equal(publisher.messagesOfType("server_error")[0]?.reason, "invalid_bitrate");
    assert.equal(publisher.closeCode, 1002);
    assert.equal(relay.relay.health().live, false);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un `stream_stop` en retard ne coupe pas la session courante.
test("refuse un stream_stop qui vise une autre session", async () => {
  const relay = await startRelay();

  try {
    const publisher = await startLive(relay, 600);

    publisher.sendJson({ type: "stream_stop", protocolVersion: 1, sessionId: 599, reason: "user_stop" });
    await waitFor(() => publisher.messagesOfType("server_error").length === 1, "refus du stop");

    assert.equal(publisher.messagesOfType("server_error")[0]?.reason, "unknown_session");
    assert.equal(relay.relay.health().live, true);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un message hors protocole est signale sans fermer une connexion authentifiee.
test("signale un message inconnu sans fermer le direct", async () => {
  const relay = await startRelay();

  try {
    const publisher = await startLive(relay, 12345);

    publisher.sendJson({ type: "quelque_chose", protocolVersion: 1 });
    await waitFor(() => publisher.messagesOfType("server_error").length === 1, "refus du message");

    assert.equal(publisher.messagesOfType("server_error")[0]?.reason, "unsupported_message");
    assert.equal(publisher.closed, false);
    assert.equal(relay.relay.health().live, true);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un message d'une autre version du protocole ferme la connexion.
test("ferme une connexion qui parle une autre version du protocole", async () => {
  const relay = await startRelay();

  try {
    const publisher = await TestClient.connect(relay.publisherUrl);
    publisher.sendJson({ type: "publisher_auth", protocolVersion: 2, token: TEST_TOKEN });
    await waitFor(() => publisher.closed, "fermeture de la version inconnue");

    assert.equal(publisher.messagesOfType("server_error")[0]?.reason, "unsupported_protocol_version");
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un listener qui envoie des donnees est ferme : la page ne parle jamais.
test("ferme un listener qui envoie des donnees", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    await waitFor(() => listener.json.length === 1, "premier etat");

    listener.sendJson({ type: "bonjour", protocolVersion: 1 });
    await waitFor(() => listener.closed, "fermeture du listener bavard");

    assert.equal(listener.closeCode, 1003);
    assert.equal(relay.relay.hub.size, 0);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que la limite d'auditeurs refuse la connexion de trop avant meme de l'ouvrir.
test("refuse un auditeur au-dela de la limite", async () => {
  const relay = await startRelay({ maxListeners: 1 });

  try {
    const accepte = await TestClient.connect(relay.listenerUrl);
    await waitFor(() => accepte.json.length === 1, "premier etat");

    await assert.rejects(() => TestClient.connect(relay.listenerUrl), /Unexpected server response: 503/);
    assert.equal(relay.relay.hub.stats.refused, 1);
    assert.equal(relay.relay.hub.size, 1);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que les connexions publisher sans token ne peuvent pas s'accumuler.
test("refuse trop de connexions publisher en attente de token", async () => {
  const relay = await startRelay();

  try {
    const attentes: TestClient[] = [];
    for (let index = 0; index < 4; index += 1) {
      attentes.push(await TestClient.connect(relay.publisherUrl));
    }

    await assert.rejects(() => TestClient.connect(relay.publisherUrl), /Unexpected server response: 503/);
    assert.equal(attentes.length, 4);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un chemin inconnu ne devient jamais une connexion WebSocket.
test("refuse une connexion sur un chemin inconnu", async () => {
  const relay = await startRelay();

  try {
    await assert.rejects(
      () => TestClient.connect(`${relay.listenerUrl.replace("/listener", "/autre")}`),
      /Unexpected server response: 404/,
    );
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'une trame plus grande que le plus grand paquet du protocole est refusee sans
// mettre le relais en panne.
test("survit a une trame plus grande que le protocole", async () => {
  const relay = await startRelay();

  try {
    const publisher = await TestClient.connect(relay.publisherUrl);
    publisher.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
    await waitFor(() => publisher.messagesOfType("auth_ok").length === 1, "auth_ok");

    publisher.sendBinary(Buffer.alloc(8192, 3));
    await waitFor(() => publisher.closed, "fermeture de la trame trop grande");

    const sante = await readHealth(relay.baseUrl);
    assert.equal(sante.status, "ok");
    assert.equal(sante.live, false);
  } finally {
    await relay.close();
  }
});
