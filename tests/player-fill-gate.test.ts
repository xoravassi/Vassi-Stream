import assert from "node:assert/strict";
import test from "node:test";

import { FillGate } from "../src/player/fill-gate.ts";
import { AUDIO_STALL_MS } from "../src/player/player-diagnostics.ts";

// Ce fichier verifie la question « le decodeur doit-il remplir la file PCM ? ».
//
// Une seule reponse fausse ici suffit a rendre le moteur muet — le decodeur jette tout ce qu'il
// recoit — ou a le laisser remplir une file que personne ne vide, ce qui gonfle la file d'attente du
// port sans aucune limite en mode messages. Aucune piece de navigateur n'intervient : les trois
// signaux se posent a la main.

// Cette fonction cree un portail deja ouvert, comme apres un clic sur Play suivi d'un premier niveau
// annonce par le processeur audio.
function portailOuvert(): FillGate {
  const gate = new FillGate();

  gate.setWanted(true);
  gate.noteLevel(1000);

  return gate;
}

test("reste ferme tant que le son n'est pas demande", () => {
  const gate = new FillGate();

  assert.equal(gate.open, false);
  assert.equal(gate.wanted, false);

  gate.setWanted(true);
  assert.equal(gate.open, true);
});

test("se ferme quand le contexte audio n'est plus running", () => {
  const gate = portailOuvert();

  gate.setContextRunning(false);
  assert.equal(gate.open, false);
  assert.equal(gate.wanted, true, "la demande de l'auditeur ne change pas pour autant");

  gate.setContextRunning(true);
  assert.equal(gate.open, true);
});

// Ce test couvre l'arret que le contexte n'annonce pas : mise en veille de la machine, onglet gele,
// peripherique de sortie qui bafouille. Le contexte se dit `running`, et seul le silence du
// processeur audio le trahit.
test("se ferme quand le thread audio cesse de rendre la main", () => {
  const gate = portailOuvert();

  // Un retard ordinaire ne ferme rien : le niveau arrive toutes les quarante millisecondes.
  gate.checkStall(1000 + AUDIO_STALL_MS);
  assert.equal(gate.open, true);

  gate.checkStall(1000 + AUDIO_STALL_MS + 1);
  assert.equal(gate.open, false);

  // Le premier niveau annonce prouve le retour du thread audio.
  gate.noteLevel(5000);
  assert.equal(gate.open, true);
});

// Ce test verifie qu'un moteur qui n'a encore rien annonce n'est pas pris pour un moteur en panne.
// Sans niveau connu, il n'y a aucune duree a comparer, et fermer le portail empecherait la toute
// premiere bufferisation.
test("fait credit au thread audio tant qu'aucun niveau n'est arrive", () => {
  const gate = new FillGate();
  gate.setWanted(true);

  gate.checkStall(999999);
  assert.equal(gate.open, true);
});

// Ce test verifie que les trois signaux valent ensemble : le dernier revenu ne suffit pas a rouvrir.
test("demande les trois signaux a la fois", () => {
  const gate = portailOuvert();

  gate.setContextRunning(false);
  gate.checkStall(1000 + AUDIO_STALL_MS + 1);
  assert.equal(gate.open, false);

  gate.noteLevel(9000);
  assert.equal(gate.open, false, "le contexte ne tourne toujours pas");

  gate.setContextRunning(true);
  assert.equal(gate.open, true);
});

// Ce test couvre la remise a neuf qui accompagne la destruction des pieces du navigateur. Un portail
// qui garderait l'arret constate du thread precedent laisserait le moteur suivant muet.
test("repart a neuf quand les pieces sont detruites", () => {
  const gate = portailOuvert();

  gate.checkStall(1000 + AUDIO_STALL_MS + 1);
  gate.reset();

  assert.equal(gate.open, false, "le son n'est pas demande a un moteur qui vient de naitre");

  gate.setWanted(true);
  assert.equal(gate.open, true, "et rien de l'arret precedent ne subsiste");
});
