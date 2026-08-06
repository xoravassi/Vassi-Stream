import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { decodeAudioPacket } from "../src/protocol/audio-packet.ts";
import { FakeRelay, waitFor } from "./fake-relay.ts";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { Publisher, LIVE, ERROR, RECONNECTING, MAX_QUEUE_MS, MAX_INFLIGHT_FRAMES } = require("../device/node/publisher.js");

const GOOD_TOKEN = "jeton-de-test-tres-secret";

type StateRecord = { state: string; detail: string };

// Cette fonction cree une frame identique a celle que le pont loopback remet a Node.
function makeFrame(sequence: number, flags = 0): {
  sequence: number;
  timestampMicros: bigint;
  flags: number;
  payload: Buffer;
} {
  const payload = Buffer.alloc(60);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (sequence + index) & 0xff;
  }

  return {
    sequence,
    timestampMicros: BigInt(sequence) * 40000n,
    flags,
    payload,
  };
}

// Cette fonction cree un publisher branche sur un faux relais, avec des delais courts.
// `timings` remplace les durees du protocole, trop longues pour un test.
function makePublisher(relayUrl: string, token: string, timings?: Record<string, number>) {
  const states: StateRecord[] = [];
  const encoderActions: string[] = [];
  const attempts: number[] = [];
  const publisher = new Publisher({
    onState: (state: string, detail: string) => states.push({ state, detail }),
    onEncoder: (action: string) => encoderActions.push(action),
    loadConfig: () => ({ relayUrl, publisherToken: token }),
    // Les paliers reels vont de 1 a 30 secondes : un test ne peut pas les attendre.
    // Le numero de tentative est conserve : c'est lui qui montre le recul du backoff.
    delayFor: (attempt: number) => {
      attempts.push(attempt);
      return 20;
    },
    timings,
  });

  return { publisher, states, encoderActions, attempts };
}

// Ce test couvre le chemin nominal demande par la roadmap : token accepte, `stream_start`,
// puis une frame binaire valide et identique octet pour octet au payload de l'encodeur.
test("authentifie le publisher puis envoie stream_start et une frame valide", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, states, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start({ bitrate: 256000, latencyProfile: "balanced" });
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  // L'encodeur ne demarre qu'apres l'acceptation du token : c'est la regle du bloc 6.
  assert.deepEqual(encoderActions, ["start"]);
  assert.deepEqual(states.map((entry) => entry.state), ["CONNECTING", "LIVE"]);

  const frame = makeFrame(0);
  assert.equal(publisher.sendFrame(frame), true);
  await waitFor(() => relay.received.binaryMessages.length === 1, "premiere frame recue");

  const [start] = relay.messagesOfType("stream_start");
  assert.ok(start !== undefined);
  assert.equal(start.codec, "opus");
  assert.equal(start.protocolVersion, 1);
  assert.equal(start.bitrate, 256000);
  assert.equal(start.sampleRate, 48000);
  assert.equal(start.channels, 2);
  assert.equal(start.frameDurationMs, 40);
  assert.equal(start.latencyProfile, "balanced");

  // Le relais doit voir l'ordre exact : authentification, ouverture de session, puis audio.
  assert.deepEqual(
    relay.received.jsonMessages.map((message) => message.type),
    ["publisher_auth", "stream_start"],
  );

  const packet = decodeAudioPacket(relay.received.binaryMessages[0]!);
  assert.equal(packet.header.sessionId, start.sessionId);
  assert.equal(packet.header.sequenceNumber, 0);
  assert.equal(packet.header.timestampMicros, 0n);
  assert.equal(packet.header.flags, 0);
  assert.deepEqual(Buffer.from(packet.payload), frame.payload);
});

// Ce test verifie que les numeros du pont sont ramenes a zero sur la session, avec leurs trous.
test("conserve les trous de sequence et l'avance des timestamps", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  // La premiere frame de la session ne porte pas le numero zero du pont : le publisher rebase.
  publisher.sendFrame(makeFrame(400));
  publisher.sendFrame(makeFrame(401));
  // Trois frames manquent : le trou doit rester visible pour le player.
  publisher.sendFrame(makeFrame(405, 1));
  await waitFor(() => relay.received.binaryMessages.length === 3, "trois frames recues");

  const packets = relay.received.binaryMessages.map((bytes) => decodeAudioPacket(bytes).header);
  assert.deepEqual(packets.map((header) => header.sequenceNumber), [0, 1, 5]);
  assert.deepEqual(packets.map((header) => header.timestampMicros), [0n, 40000n, 200000n]);
  assert.deepEqual(packets.map((header) => header.flags), [0, 0, 1]);
});

// Ce test verifie qu'un mauvais token donne une erreur lisible et ne fuite jamais le secret.
test("refuse un mauvais token sans exposer le token", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, states, encoderActions } = makePublisher(url, "mauvais-jeton-prive");
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === ERROR, "publisher en erreur");

  const lastState = states[states.length - 1]!;
  assert.equal(lastState.state, ERROR);
  assert.match(lastState.detail, /token refuse par le relais/);
  assert.match(lastState.detail, /invalid_token/);

  // Aucun etat ne doit contenir le token, ni le bon ni celui qui a ete refuse.
  const allDetails = states.map((entry) => entry.detail).join(" ");
  assert.doesNotMatch(allDetails, /mauvais-jeton-prive/);
  assert.doesNotMatch(allDetails, new RegExp(GOOD_TOKEN));

  // L'encodeur ne doit jamais avoir demarre, et aucune reconnexion ne doit etre tentee.
  assert.equal(encoderActions.includes("start"), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(relay.connectionsSeen, 1);
  assert.equal(publisher.state, ERROR);
});

// Ce test verifie qu'une coupure du relais provoque une reconnexion et une nouvelle session.
test("reconnecte apres une coupure et cree une nouvelle session", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "premiere session en direct");
  const firstSessionId = publisher.session.sessionId;

  // Le publisher passe en direct des qu'il a ecrit `stream_start`, donc avant que le relais l'ait
  // lu. Couper la connexion a cet instant emporterait le message avec elle, et le compte de deux
  // `stream_start` plus bas ne serait jamais atteint. L'attente porte donc sur le relais.
  await waitFor(() => relay.messagesOfType("stream_start").length === 1, "premier stream_start recu");

  relay.cutCurrentConnection();
  await waitFor(() => publisher.state === RECONNECTING, "passage en reconnexion");

  // L'encodeur doit etre arrete avant toute tentative de reconnexion.
  assert.deepEqual(encoderActions, ["start", "stop"]);

  // Cette attente couvre le premier palier de l'escalier de reconnexion, une seconde plus ou moins
  // vingt pour cent, puis l'ouverture d'une connexion et l'authentification. La limite est large :
  // ce test mesure la reconnexion du publisher, pas la charge de la machine qui l'execute.
  await waitFor(() => publisher.state === LIVE, "seconde session en direct", 15000);
  const secondSessionId = publisher.session.sessionId;

  assert.notEqual(secondSessionId, firstSessionId);
  assert.equal(relay.connectionsSeen, 2);
  assert.deepEqual(encoderActions, ["start", "stop", "start"]);

  // Le publisher passe en direct des qu'il a ecrit `stream_start` : l'attente porte donc sur le
  // relais, qui recoit ce message un instant plus tard.
  await waitFor(() => relay.messagesOfType("stream_start").length === 2, "second stream_start recu");
  const starts = relay.messagesOfType("stream_start");
  assert.notEqual(starts[0]!.sessionId, starts[1]!.sessionId);

  // La nouvelle session repart de zero : le player jette proprement l'ancien flux.
  publisher.sendFrame(makeFrame(900));
  await waitFor(() => relay.received.binaryMessages.length === 1, "frame de la seconde session");
  const header = decodeAudioPacket(relay.received.binaryMessages[0]!).header;
  assert.equal(header.sessionId, secondSessionId);
  assert.equal(header.sequenceNumber, 0);
});

// Ce test verifie le cas ou l'objet natif repart de zero au milieu d'un live, par exemple apres
// un `reset` dans Max. Un numero de sequence ne doit jamais reculer pour un listener : le publisher
// ouvre donc une nouvelle session, sans relancer l'encodeur, ce qui bouclerait sans fin.
test("ouvre une nouvelle session quand l'encodeur repart de zero", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");
  const firstSessionId = publisher.session.sessionId;

  publisher.sendFrame(makeFrame(500));
  publisher.sendFrame(makeFrame(501));
  // L'encodeur redemarre : ses numeros et ses timestamps repartent de zero.
  publisher.sendFrame(makeFrame(0));
  publisher.sendFrame(makeFrame(1));

  await waitFor(() => relay.received.binaryMessages.length === 4, "quatre frames recues");

  const secondSessionId = publisher.session.sessionId;
  assert.notEqual(secondSessionId, firstSessionId);

  // L'encodeur n'est pas relance : sinon sa numerotation repartirait encore de zero.
  assert.deepEqual(encoderActions, ["start"]);
  assert.equal(publisher.stats.sessions, 2);

  const headers = relay.received.binaryMessages.map((bytes) => decodeAudioPacket(bytes).header);
  assert.deepEqual(headers.map((header) => header.sessionId), [
    firstSessionId,
    firstSessionId,
    secondSessionId,
    secondSessionId,
  ]);
  assert.deepEqual(headers.map((header) => header.sequenceNumber), [0, 1, 0, 1]);
  assert.deepEqual(headers.map((header) => header.flags), [0, 0, 1, 0]);

  // L'ancienne session est fermee proprement avant l'ouverture de la nouvelle.
  const stops = relay.messagesOfType("stream_stop");
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.sessionId, firstSessionId);
});

// Ce test verifie que l'arret envoie `stream_stop` avant de fermer la connexion.
test("ferme la session avec stream_stop", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");
  const sessionId = publisher.session.sessionId;

  publisher.stop("user_stop");
  await waitFor(() => relay.messagesOfType("stream_stop").length === 1, "stream_stop recu");

  const stop = relay.messagesOfType("stream_stop")[0]!;
  assert.equal(stop.sessionId, sessionId);
  assert.equal(stop.reason, "user_stop");
  assert.equal(publisher.state, "STOPPED");

  // L'encodeur est arrete avant l'envoi de `stream_stop` : plus rien ne peut arriver apres.
  assert.equal(encoderActions[encoderActions.length - 1], "stop");
});

// Ce test verifie qu'aucune frame n'est envoyee tant que la session n'est pas ouverte.
test("jette les frames recues hors session", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  // Le pont loopback tourne des l'ouverture du device : des frames arrivent avant tout live.
  assert.equal(publisher.sendFrame(makeFrame(1)), false);
  assert.equal(publisher.stats.framesDropped, 1);

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  // La premiere frame de la session porte le bit de discontinuite pose par les frames jetees ?
  // Non : une nouvelle session impose deja la remise a zero du player, le bit repart a zero.
  publisher.sendFrame(makeFrame(2));
  await waitFor(() => relay.received.binaryMessages.length === 1, "frame recue");
  assert.equal(decodeAudioPacket(relay.received.binaryMessages[0]!).header.flags, 0);
});

// Ce test verifie que la fenetre d'envoi borne ce qui est confie au systeme d'un seul coup.
//
// Sans elle, tout partirait vers le noyau, dont Node ne sait ni regler la taille ni lire le retard :
// une seconde d'audio pourrait y attendre sans que rien ne le montre, et la file applicative
// resterait vide pendant que la latence grandit.
test("ne confie a la socket que ce que la fenetre d'envoi autorise", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  // Les rappels d'ecriture de `ws` sont asynchrones : tant que ce tour de boucle dure, aucune place
  // ne se libere. Ces envois successifs remplissent donc la fenetre puis la file, sans rien attendre.
  for (let sequence = 0; sequence < MAX_INFLIGHT_FRAMES + 3; sequence += 1) {
    assert.equal(publisher.sendFrame(makeFrame(sequence)), true);
  }

  assert.equal(publisher.stats.framesSent, MAX_INFLIGHT_FRAMES, "la fenetre borne ce qui part");
  assert.equal(publisher.queue.length, 3, "le reste attend dans la file, pas dans le noyau");
  assert.equal(publisher.stats.framesDropped, 0, "rien n'est jete tant que la file n'est pas pleine");

  // Le tour de boucle suivant libere la fenetre, et tout finit par partir.
  await waitFor(
    () => relay.received.binaryMessages.length === MAX_INFLIGHT_FRAMES + 3,
    "toutes les frames finissent par partir",
  );
});

// Ce test verifie le choix qui justifie a lui seul l'existence de cette file : quand le lien ne suit
// plus, c'est l'audio **le plus ancien** qui part.
//
// Le publisher faisait l'inverse jusqu'ici. Il jetait la frame qui venait d'etre encodee et gardait
// celles d'avant, ce qui est le bon reflexe pour un fichier et le mauvais pour un direct : le son
// garde etait deja perime au moment ou il partait. Le journal du 6 aout 2026 en montre le resultat,
// un trou de 2920 ms d'un seul tenant.
test("jette l'audio le plus ancien, jamais le plus recent, quand le lien ne suit plus", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  const capacite = Math.floor(MAX_QUEUE_MS / 40);
  const total = MAX_INFLIGHT_FRAMES + capacite + 5;

  for (let sequence = 0; sequence < total; sequence += 1) {
    publisher.sendFrame(makeFrame(sequence));
  }

  assert.equal(publisher.stats.framesDropped, 5, "seul le surplus est jete");
  assert.equal(publisher.queue.length, capacite, "la file reste bornee");
  // La derniere trame encodee est encore la : c'est tout l'objet du changement.
  assert.equal(publisher.queue[publisher.queue.length - 1]!.frame.sequence, total - 1);

  await waitFor(
    () => relay.received.binaryMessages.length === total - 5,
    "tout ce qui n'a pas ete jete finit par partir",
  );

  const paquets = relay.received.binaryMessages.map((bytes) => decodeAudioPacket(bytes).header);
  const marques = paquets.filter((header) => header.flags === 1);

  assert.equal(marques.length, 1, "un seul bit de discontinuite pour un seul trou");
  // Le trou se voit aussi dans les numeros : la premiere trame apres l'abandon est celle qui porte
  // le bit, et son numero saute exactement des cinq trames jetees.
  assert.equal(marques[0]!.sequenceNumber, MAX_INFLIGHT_FRAMES + 5);
});

// Ce test verifie qu'un relais qui repete `auth_ok` pendant un live ne relance rien. Sans cette
// regle, chaque repetition ouvrirait une session de plus et redemarrerait l'objet natif.
test("ignore une reponse d'authentification repetee pendant un live", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");
  const sessionId = publisher.session.sessionId;

  relay.sendToCurrentConnection({ type: "auth_ok", protocolVersion: 1 });
  relay.sendToCurrentConnection({ type: "auth_error", protocolVersion: 1, reason: "invalid_token" });
  // Un message qui arrive apres celui-ci prouve que les deux precedents ont ete traites.
  relay.sendToCurrentConnection({ type: "server_error", protocolVersion: 1, reason: "invalid_packet" });
  await waitFor(() => publisher.detail.includes("invalid_packet"), "server_error traite");

  assert.equal(publisher.state, LIVE);
  assert.equal(publisher.session.sessionId, sessionId);
  assert.equal(publisher.stats.sessions, 1);
  assert.deepEqual(encoderActions, ["start"]);
  assert.equal(relay.messagesOfType("stream_start").length, 1);
});

// Ce test verifie que le device teste lui-meme la liaison. Le faux relais n'envoie aucun ping :
// sans le ping du publisher et le pong qui lui repond, le compte a rebours du silence couperait
// une connexion pourtant vivante.
test("garde la connexion vivante avec son propre ping", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  // Le silence est plus court que la duree du test : seuls les pongs peuvent le repousser.
  const { publisher } = makePublisher(url, GOOD_TOKEN, { heartbeatMs: 20, silenceMs: 200 });
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  await waitFor(() => relay.pingsSeen >= 3, "pings recus par le relais");
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(publisher.state, LIVE);
  assert.equal(relay.connectionsSeen, 1);
});

// Ce test verifie qu'un relais qui accepte le token puis coupe aussitot n'est pas rappele en
// boucle a la seconde. Le compteur de paliers ne repart de zero qu'apres une connexion stable.
test("espace les tentatives quand le relais coupe juste apres l'authentification", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  relay.cutAfterAuth = true;
  // Aucune connexion ne tiendra une seconde : le seuil de stabilite ne sera jamais atteint.
  const { publisher, attempts } = makePublisher(url, GOOD_TOKEN, { stableMs: 1000 });
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => attempts.length >= 4, "quatre tentatives programmees");

  // Chaque coupure fait monter le palier au lieu de le remettre a zero.
  assert.deepEqual(attempts.slice(0, 4), [0, 1, 2, 3]);
});

// Ce test verifie qu'une connexion saine efface l'historique des paliers : la premiere coupure
// apres un long direct est retentee tout de suite, sans heriter d'un incident ancien.
test("repart du premier palier apres une connexion stable", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  // Toute connexion etablie est jugee stable : c'est le cas normal d'un live qui dure.
  const { publisher, attempts } = makePublisher(url, GOOD_TOKEN, { stableMs: 0 });
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "premiere session en direct");
  relay.cutCurrentConnection();
  await waitFor(() => publisher.state === LIVE && relay.connectionsSeen === 2, "seconde session");
  relay.cutCurrentConnection();
  await waitFor(() => attempts.length >= 2, "deux tentatives programmees");

  assert.deepEqual(attempts.slice(0, 2), [0, 0]);
});

// Ce test verifie qu'un arret n'annonce qu'une seule fois l'arret de l'encodeur et de l'etat.
// La fermeture de la connexion arrive apres coup : elle ne doit plus rien decider.
test("n'annonce l'arret qu'une seule fois", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, states, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  publisher.stop("user_stop");
  await waitFor(() => relay.messagesOfType("stream_stop").length === 1, "stream_stop recu");
  // La fermeture reelle de la connexion arrive apres le `stream_stop` : ce delai la couvre.
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(encoderActions, ["start", "stop"]);
  assert.deepEqual(states.map((entry) => entry.state), ["CONNECTING", "LIVE", "STOPPED"]);
});

// Ce test verifie qu'une frame impossible a encoder ne coute que cette frame. Le pont remet ses
// frames depuis un evenement de socket : une exception y arreterait tout le processus Node.
test("jette une frame impossible a encoder sans couper le live", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start();
  await waitFor(() => publisher.state === LIVE, "publisher en direct");

  // Un payload vide, et un payload plus grand qu'une frame Opus, n'existent pas en protocole v1.
  const empty = makeFrame(20);
  empty.payload = Buffer.alloc(0);
  assert.equal(publisher.sendFrame(empty), false);

  const huge = makeFrame(21);
  huge.payload = Buffer.alloc(3000, 7);
  assert.equal(publisher.sendFrame(huge), false);

  assert.equal(publisher.stats.framesDropped, 2);
  assert.equal(publisher.state, LIVE);

  // La frame suivante part normalement et signale l'audio perdu. Elle ouvre la chronologie de la
  // session : les frames refusees ne l'ont pas ancree, donc elle porte bien la sequence zero.
  assert.equal(publisher.sendFrame(makeFrame(22)), true);
  await waitFor(() => relay.received.binaryMessages.length === 1, "frame suivante recue");

  const header = decodeAudioPacket(relay.received.binaryMessages[0]!).header;
  assert.equal(header.flags, 1);
  assert.equal(header.sequenceNumber, 0);
  assert.equal(header.timestampMicros, 0n);
});

// Ce test verifie qu'un double clic sur Lancer ne cree qu'une seule session.
//
// Le bouton du device est un interrupteur : deux clics rapides donnent 1 puis 0 puis 1. Mais un
// clic maintenu, une commande MIDI repetee ou une automation peuvent aussi envoyer deux fois la
// meme demande. Une seconde session ouverte par erreur ferait perdre sa place a la premiere sur
// le relais, qui donne la place au dernier publisher authentifie.
test("un second Lancer ne cree pas de seconde session", async (t) => {
  const relay = new FakeRelay(GOOD_TOKEN);
  const url = await relay.listen();
  const { publisher, states, encoderActions } = makePublisher(url, GOOD_TOKEN);
  t.after(async () => {
    publisher.stop();
    await relay.close();
  });

  publisher.start({ bitrate: 256000, latencyProfile: "balanced" });
  publisher.start({ bitrate: 128000, latencyProfile: "low" });
  await waitFor(() => publisher.state === LIVE, "publisher en direct");
  publisher.start({ bitrate: 128000, latencyProfile: "low" });

  await waitFor(() => relay.messagesOfType("stream_start").length === 1, "une seule ouverture");

  // La demande ignoree ne doit rien changer : ni la qualite, ni l'encodeur, ni l'etat affiche.
  const [start] = relay.messagesOfType("stream_start");
  assert.equal(start!.bitrate, 256000);
  assert.deepEqual(encoderActions, ["start"]);
  assert.deepEqual(states.map((entry) => entry.state), ["CONNECTING", "LIVE"]);
  assert.equal(publisher.stats.sessions, 1);
});
