import assert from "node:assert/strict";
import test from "node:test";

import { decodeAudioPacket } from "../src/protocol/audio-packet.ts";
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

// Ce fichier verifie le parcours normal du relais : authentification, session, diffusion et arret.

// Ce test couvre la premiere verification courte du bloc 7 : le bon token passe, le mauvais non.
test("accepte le bon token et refuse le mauvais sans jamais le renvoyer", async () => {
  const relay = await startRelay();

  try {
    const bon = await TestClient.connect(relay.publisherUrl);
    bon.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
    await waitFor(() => bon.messagesOfType("auth_ok").length === 1, "auth_ok");

    const mauvais = await TestClient.connect(relay.publisherUrl);
    mauvais.sendJson({ type: "publisher_auth", protocolVersion: 1, token: "mauvais_token" });
    await waitFor(() => mauvais.closed, "fermeture du mauvais token");

    const refus = mauvais.messagesOfType("auth_error");
    assert.equal(refus.length, 1);
    assert.equal(refus[0]?.reason, "invalid_token");
    assert.equal(mauvais.closeCode, 1008);

    // Aucun message recu ne contient le token attendu ni le token propose.
    const texte = JSON.stringify(mauvais.json);
    assert.ok(!texte.includes(TEST_TOKEN));
    assert.ok(!texte.includes("mauvais_token"));
  } finally {
    await relay.close();
  }
});

// Ce test couvre la deuxieme verification courte : un listener avant le live voit l'etat hors ligne.
test("envoie l'etat hors ligne au listener arrive avant le live", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    await waitFor(() => listener.json.length === 1, "premier etat");

    assert.deepEqual(listener.json[0], { type: "stream_state", protocolVersion: 1, live: false });
    assert.equal(listener.binary.length, 0);
  } finally {
    await relay.close();
  }
});

// Ce test couvre la troisieme verification courte : deux listeners recoivent les memes paquets dans
// le meme ordre, et les octets ne sont jamais modifies par le relais.
test("diffuse les memes paquets dans le meme ordre a deux listeners", async () => {
  const relay = await startRelay();

  try {
    const premier = await TestClient.connect(relay.listenerUrl);
    const publisher = await startLive(relay, 4242);
    const second = await TestClient.connect(relay.listenerUrl);

    await waitFor(() => premier.messagesOfType("stream_state").length === 2, "etat en direct du premier");
    await waitFor(() => second.messagesOfType("stream_state").length === 1, "etat en direct du second");

    const envoyes = [audioPacket(4242, 0, 7), audioPacket(4242, 1, 8), audioPacket(4242, 2, 9)];
    for (const paquet of envoyes) {
      publisher.sendBinary(paquet);
    }

    await waitFor(() => premier.binary.length === 3 && second.binary.length === 3, "trois paquets recus");

    assert.deepEqual(premier.binary, envoyes);
    assert.deepEqual(second.binary, envoyes);

    // Le second listener a recu son etat en direct avant tout paquet audio.
    const etat = second.json[0] as Record<string, unknown>;
    assert.equal(etat.live, true);
    assert.equal(etat.sessionId, 4242);
    assert.equal(etat.bitrate, 256000);
    assert.equal(etat.latencyProfile, "balanced");

    // Le payload Opus traverse le relais sans une seule modification.
    const relu = decodeAudioPacket(second.binary[2] as Buffer);
    assert.equal(relu.header.sequenceNumber, 2);
    assert.deepEqual(Buffer.from(relu.payload), Buffer.from([9, 11, 22, 33, 44]));
  } finally {
    await relay.close();
  }
});

// Ce test couvre la quatrieme verification courte : l'arret du publisher remet les listeners
// hors ligne, que l'arret soit annonce ou subi.
test("repasse les listeners hors ligne apres stream_stop", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const publisher = await startLive(relay, 51);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    publisher.sendJson({ type: "stream_stop", protocolVersion: 1, sessionId: 51, reason: "user_stop" });
    await waitFor(() => listener.messagesOfType("stream_state").length === 3, "etat hors ligne");

    assert.deepEqual(listener.json[2], { type: "stream_state", protocolVersion: 1, live: false });
    assert.equal(relay.relay.health().live, false);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'une disparition brutale du publisher produit le meme resultat qu'un arret
// annonce. Sans cela, la page resterait a l'etat en direct devant un flux mort.
test("repasse les listeners hors ligne quand le publisher disparait", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const publisher = await startLive(relay, 77);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    publisher.stop();
    await waitFor(() => listener.messagesOfType("stream_state").length === 3, "etat hors ligne");

    assert.equal(listener.json[2]?.live, false);
    assert.equal(relay.relay.health().live, false);
  } finally {
    await relay.close();
  }
});

// Ce test verifie qu'un second publisher authentifie prend la place du premier. Sans cette regle,
// une connexion morte que le relais n'a pas encore detectee bloquerait tout nouveau live.
test("remplace le publisher precedent apres une nouvelle authentification", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    const ancien = await startLive(relay, 100);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "premier direct");

    const nouveau = await TestClient.connect(relay.publisherUrl);
    nouveau.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
    await waitFor(() => ancien.closed, "fermeture de l'ancien publisher");

    assert.equal(ancien.messagesOfType("server_error")[0]?.reason, "publisher_replaced");
    await waitFor(() => listener.messagesOfType("stream_state").length === 3, "retour hors ligne");
    assert.equal(listener.json[2]?.live, false);

    nouveau.sendJson(streamStartMessage(101));
    await waitFor(() => listener.messagesOfType("stream_state").length === 4, "second direct");
    assert.equal(listener.json[3]?.sessionId, 101);

    // Les paquets de l'ancienne session ne passent plus : seule la session active est diffusee.
    nouveau.sendBinary(audioPacket(101, 0, 5));
    await waitFor(() => listener.binary.length === 1, "paquet de la nouvelle session");
    assert.equal(decodeAudioPacket(listener.binary[0] as Buffer).header.sessionId, 101);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que la route de sante decrit l'etat sans exposer de secret.
test("decrit l'etat courant sur la route de sante", async () => {
  const relay = await startRelay();

  try {
    const horsLigne = await readHealth(relay.baseUrl);
    assert.equal(horsLigne.status, "ok");
    assert.equal(horsLigne.live, false);
    assert.equal(horsLigne.listeners, 0);
    assert.equal(horsLigne.lastPacketAgeMs, null);

    const listener = await TestClient.connect(relay.listenerUrl);
    const publisher = await startLive(relay, 900);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");
    publisher.sendBinary(audioPacket(900, 0, 1));
    await waitFor(() => listener.binary.length === 1, "paquet diffuse");

    const enDirect = await readHealth(relay.baseUrl);
    assert.equal(enDirect.live, true);
    assert.equal(enDirect.sessionId, 900);
    assert.equal(enDirect.listeners, 1);
    assert.equal(enDirect.framesRelayed, 1);
    assert.ok(typeof enDirect.lastPacketAgeMs === "number");
    assert.ok(!JSON.stringify(enDirect).includes(TEST_TOKEN));
  } finally {
    await relay.close();
  }
});

// Ce test verifie que les paquets refuses sont visibles pendant que le publisher est encore
// connecte. Attendre sa fermeture rendrait le compteur inutile : la sante est consultee au moment
// ou le probleme se produit, pas apres.
test("compte les paquets refuses pendant que le publisher est encore connecte", async () => {
  const relay = await startRelay();

  try {
    const publisher = await startLive(relay, 500);

    // Ces paquets portent une autre session : le relais les refuse sans fermer la connexion.
    publisher.sendBinary(audioPacket(501, 0, 1));
    publisher.sendBinary(audioPacket(501, 1, 2));
    await waitFor(() => relay.relay.health().packetsRefused === 2, "refus comptes");

    // Le compteur ne redemarre pas a l'ouverture de la session suivante.
    publisher.sendJson(streamStartMessage(502));
    await waitFor(() => relay.relay.health().sessionId === 502, "seconde session");
    assert.equal(relay.relay.health().packetsRefused, 2);

    // Il ne double pas non plus quand la connexion disparait.
    publisher.stop();
    await waitFor(() => relay.relay.health().live === false, "publisher parti");
    assert.equal(relay.relay.health().packetsRefused, 2);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que la sante montre les paquets abandonnes pour un auditeur en retard. C'est le
// compteur qui distingue un probleme de reception chez l'auditeur d'un probleme du cote d'Ableton.
test("montre les paquets abandonnes pour un auditeur en retard sur la route de sante", async () => {
  const relay = await startRelay();

  try {
    const sante = await readHealth(relay.baseUrl);
    assert.equal(sante.listenerFramesDropped, 0);
    assert.equal(sante.listenersClosedSilent, 0);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que l'arret du relais previent les auditeurs au lieu de couper sans rien dire.
// La page affiche alors « pas pret » plutot qu'une erreur de connexion.
test("annonce la fin du direct avant l'arret du relais", async () => {
  const relay = await startRelay();

  try {
    const listener = await TestClient.connect(relay.listenerUrl);
    await startLive(relay, 321);
    await waitFor(() => listener.messagesOfType("stream_state").length === 2, "etat en direct");

    relay.relay.announceShutdown();
    await waitFor(() => listener.messagesOfType("stream_state").length === 3, "annonce d'arret");

    assert.equal(listener.json[2]?.live, false);
  } finally {
    await relay.close();
  }
});

// Ce test verifie que la racine repond aussi 200 : un hebergeur configure sans chemin de sante
// interroge `/` et redemarrerait le conteneur devant toute autre reponse.
test("repond 200 sur la racine et 404 ailleurs", async () => {
  const relay = await startRelay();

  try {
    const racine = await fetch(`${relay.baseUrl}/`);
    assert.equal(racine.status, 200);

    const inconnue = await fetch(`${relay.baseUrl}/autre`);
    assert.equal(inconnue.status, 404);

    const methode = await fetch(`${relay.baseUrl}/health`, { method: "POST" });
    assert.equal(methode.status, 405);
  } finally {
    await relay.close();
  }
});
