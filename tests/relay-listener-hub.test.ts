import assert from "node:assert/strict";
import test from "node:test";

import { CLOSE_BYTES, DROP_BYTES, ListenerHub, MISSED_PONG_LIMIT } from "../relay/listener-hub.ts";
import type { SessionConfig } from "../relay/protocol.ts";
import { asSocket, FakeSocket } from "./relay-harness.ts";

// Ce fichier verifie la gestion des auditeurs avec de faux sockets. Un vrai socket TCP local ne
// prend jamais assez de retard pour declencher les limites de file d'envoi : seul un faux socket
// permet de verifier ce que fait le relais devant un auditeur bloque.

const SESSION: SessionConfig = { sessionId: 77, bitrate: 256000, latencyProfile: "balanced" };

// Cette fonction cree un hub vide avec une limite d'auditeurs choisie.
function makeHub(maxListeners = 10): ListenerHub {
  return new ListenerHub({ maxListeners });
}

// Ce test verifie qu'un auditeur recoit l'etat courant avant tout paquet audio, meme s'il arrive
// au milieu d'un direct. Sans cette regle, la page recevrait de l'audio sans savoir quoi en faire.
test("envoie l'etat courant avant d'inscrire un auditeur", () => {
  const hub = makeHub();
  hub.setSession(SESSION);

  const socket = new FakeSocket();
  hub.add(asSocket(socket));
  hub.broadcast(Buffer.from([1, 2, 3]));

  assert.equal(socket.texts.length, 1);
  const etat = JSON.parse(socket.texts[0] as string) as Record<string, unknown>;
  assert.equal(etat.live, true);
  assert.equal(etat.sessionId, 77);
  assert.equal(socket.binaries.length, 1);
});

// Ce test verifie qu'un auditeur en retard perd des paquets au lieu d'accumuler de l'audio ancien.
test("abandonne les paquets d'un auditeur en retard", () => {
  const hub = makeHub();
  const socket = new FakeSocket();
  hub.add(asSocket(socket));

  socket.bufferedAmount = DROP_BYTES + 1;
  hub.broadcast(Buffer.from([1]));
  assert.equal(socket.binaries.length, 0);
  assert.equal(hub.stats.framesDropped, 1);
  assert.equal(socket.terminated, false);

  // La connexion se rattrape : la diffusion reprend sans intervention.
  socket.bufferedAmount = 0;
  hub.broadcast(Buffer.from([2]));
  assert.equal(socket.binaries.length, 1);
  assert.equal(hub.size, 1);
});

// Ce test verifie qu'un auditeur bloque est coupe : sa file d'envoi grandirait sans fin.
test("coupe un auditeur dont la file d'envoi est bloquee", () => {
  const hub = makeHub();
  const socket = new FakeSocket();
  hub.add(asSocket(socket));

  socket.bufferedAmount = CLOSE_BYTES + 1;
  hub.broadcast(Buffer.from([1]));

  assert.equal(socket.terminated, true);
  assert.equal(hub.size, 0);
  assert.equal(hub.stats.closedSlow, 1);
});

// Ce test verifie qu'un auditeur muet finit par etre coupe, et qu'un auditeur qui repond reste.
test("coupe un auditeur qui ne repond plus a deux pings", () => {
  const hub = makeHub();
  const muet = new FakeSocket();
  const vivant = new FakeSocket();
  hub.add(asSocket(muet));
  hub.add(asSocket(vivant));

  for (let tour = 0; tour <= MISSED_PONG_LIMIT; tour += 1) {
    hub.pingRound();
    vivant.emit("pong");
  }

  assert.equal(muet.terminated, true);
  assert.equal(vivant.terminated, false);
  assert.equal(hub.size, 1);
  assert.equal(hub.stats.closedSilent, 1);
});

// Ce test verifie qu'un auditeur qui envoie des donnees est ferme et retire de la diffusion.
test("ferme un auditeur qui envoie des donnees", () => {
  const hub = makeHub();
  const socket = new FakeSocket();
  hub.add(asSocket(socket));

  socket.emit("message", Buffer.from("bonjour"), false);

  assert.equal(socket.closedWith?.code, 1003);
  assert.equal(hub.size, 0);
});

// Ce test verifie qu'une connexion fermee ne recoit plus rien et disparait de la liste.
test("oublie un auditeur ferme", () => {
  const hub = makeHub();
  const socket = new FakeSocket();
  hub.add(asSocket(socket));

  socket.readyState = 3;
  socket.emit("close");
  hub.setSession(SESSION);
  hub.broadcast(Buffer.from([1]));

  assert.equal(hub.size, 0);
  assert.equal(socket.binaries.length, 0);
  assert.equal(socket.texts.length, 1);
});

// Ce test verifie qu'une connexion partie pendant l'envoi de l'etat n'entre pas dans la liste.
// Sans cette regle, le compteur d'auditeurs resterait faux jusqu'a l'arrivee de sa fermeture.
test("n'inscrit pas un auditeur parti pendant l'envoi de l'etat", () => {
  const hub = makeHub();
  const socket = new FakeSocket();
  socket.readyState = 3;

  hub.add(asSocket(socket));

  assert.equal(hub.size, 0);
  assert.equal(hub.stats.accepted, 0);
});

// Ce test verifie que la limite d'auditeurs est visible avant l'acceptation d'une connexion.
test("annonce la place restante", () => {
  const hub = makeHub(1);
  assert.equal(hub.hasRoom, true);

  hub.add(asSocket(new FakeSocket()));
  assert.equal(hub.hasRoom, false);
});

// Ce test verifie que la liste elle-meme refuse un auditeur de trop. Le serveur refuse deja avant
// l'ouverture de la connexion, mais c'est cette liste qui porte la limite : elle doit tenir seule.
test("refuse un auditeur quand la liste est pleine", () => {
  const hub = makeHub(1);
  hub.add(asSocket(new FakeSocket()));

  const surnumeraire = new FakeSocket();
  hub.add(asSocket(surnumeraire));

  assert.equal(hub.size, 1);
  assert.equal(hub.stats.refused, 1);
  assert.equal(surnumeraire.closedWith?.code, 1013);
  assert.equal(surnumeraire.texts.length, 0);
});

// Ce test verifie que l'arret du relais ferme proprement chaque auditeur.
test("ferme tous les auditeurs a l'arret", () => {
  const hub = makeHub();
  const premier = new FakeSocket();
  const second = new FakeSocket();
  hub.add(asSocket(premier));
  hub.add(asSocket(second));

  hub.closeAll();

  assert.equal(premier.closedWith?.code, 1001);
  assert.equal(second.closedWith?.code, 1001);
  assert.equal(hub.size, 0);
});
