import assert from "node:assert/strict";
import test from "node:test";

import { readStreamState, type StreamState } from "../src/player/player-protocol.ts";
import { PlayerStateMachine, type PlayerState } from "../src/player/player-state.ts";

// Ce fichier verifie la machine d'etats du player. C'est elle qui decide ce que l'auditeur voit, si
// le decodeur remplit la file et si le processeur audio la consomme.

// Cette fonction construit l'etat en direct annonce par le relais.
function live(sessionId: number, latencyProfile = "balanced"): StreamState {
  const state = readStreamState(
    JSON.stringify({
      type: "stream_state",
      protocolVersion: 1,
      live: true,
      sessionId,
      codec: "opus",
      bitrate: 256000,
      sampleRate: 48000,
      channels: 2,
      frameDurationMs: 20,
      latencyProfile,
    }),
  );

  assert.ok(state !== null);
  return state;
}

const OFFLINE: StreamState = { live: false, session: null };

// Cette fonction cree une machine qui garde la suite des etats traverses.
function makeMachine(): { machine: PlayerStateMachine; etats: PlayerState[] } {
  const etats: PlayerState[] = [];
  const machine = new PlayerStateMachine((status) => etats.push(status.state));

  return { machine, etats };
}

// Ce test verifie le parcours normal : direct annonce, clic sur Play, bufferisation puis lecture.
test("passe de hors ligne a la lecture apres le seuil de buffer", () => {
  const { machine } = makeMachine();

  assert.equal(machine.status().state, "OFFLINE");

  machine.setStream(live(1));
  assert.equal(machine.status().state, "READY");
  // Rien n'est decode tant que l'auditeur n'a pas demande le son.
  assert.equal(machine.status().accepting, false);

  machine.play();
  assert.equal(machine.status().state, "BUFFERING");
  assert.equal(machine.status().accepting, true);
  // Le processeur audio ne consomme pas encore : sinon la file ne se remplirait jamais.
  assert.equal(machine.status().playing, false);

  machine.reportLevel(399, 0);
  assert.equal(machine.status().state, "BUFFERING");

  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().playing, true);
});

// Ce test verifie que le seuil vient bien du profil annonce par la session.
test("attend le seuil du profil annonce", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1, "stable"));
  machine.play();

  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "BUFFERING");

  machine.reportLevel(800, 0);
  assert.equal(machine.status().state, "PLAYING");
});

// Ce test verifie que Pause coupe reellement le son et arrete de remplir la file. Sans cela, une
// pause d'une minute produirait une minute de retard a la reprise.
test("arrete le son et jette les paquets pendant une pause", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.pause();
  assert.equal(machine.status().state, "PAUSED");
  assert.equal(machine.status().playing, false);
  assert.equal(machine.status().accepting, false);

  machine.play();
  assert.equal(machine.status().state, "BUFFERING");
});

// Ce test verifie qu'un manque de donnees fait rebufferiser au lieu de laisser le son hacher.
test("rebufferise quand la file se vide pendant la lecture", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.reportLevel(0, 1);
  assert.equal(machine.status().state, "REBUFFERING");
  assert.equal(machine.status().playing, false);
  // Le decodeur continue de remplir : c'est ce qui permet de repartir.
  assert.equal(machine.status().accepting, true);

  machine.reportLevel(400, 1);
  assert.equal(machine.status().state, "PLAYING");
});

// Ce test verifie qu'une discontinuite fait rebufferiser. Elle vient soit du bit pose par le device,
// soit d'un trou de sequence cree par le relais devant un auditeur en retard.
test("rebufferise apres une discontinuite", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.discontinuity();
  assert.equal(machine.status().state, "REBUFFERING");
});

// Ce test verifie qu'une coupure reseau n'annule pas la demande de l'auditeur. Une coupure de deux
// secondes ne doit pas obliger le professeur a revenir cliquer sur le bouton.
test("repart seul apres une coupure quand le son etait demande", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.connectionLost();
  assert.equal(machine.status().state, "OFFLINE");
  assert.equal(machine.status().accepting, false);

  machine.setStream(live(2));
  assert.equal(machine.status().state, "BUFFERING");
});

// Ce test verifie qu'une coupure pendant une pause ne relance pas le son toute seule.
test("reste en pause apres une coupure quand l'auditeur avait coupe le son", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);
  machine.pause();

  machine.connectionLost();
  machine.setStream(live(2));

  assert.equal(machine.status().state, "READY");
  assert.equal(machine.status().accepting, false);
});

// Ce test verifie que le meme etat recu deux fois n'interrompt pas la lecture. Le relais renvoie
// l'etat courant a chaque nouvel auditeur, et un doublon ne doit rien casser.
test("ignore un etat identique recu deux fois", () => {
  const { machine, etats } = makeMachine();

  machine.setStream(live(7));
  machine.play();
  machine.reportLevel(400, 0);

  machine.setStream(live(7));

  assert.equal(machine.status().state, "PLAYING");
  assert.deepEqual(etats, ["READY", "BUFFERING", "PLAYING"]);
});

// Ce test verifie qu'une nouvelle session repart en bufferisation sans demander un nouveau clic.
test("repart en bufferisation quand la session change", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.setStream(live(2));
  assert.equal(machine.status().state, "BUFFERING");
  assert.equal(machine.status().session?.sessionId, 2);
});

// Ce test verifie que la fin du direct ramene la page hors ligne.
test("revient hors ligne quand le direct s'arrete", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.setStream(OFFLINE);
  assert.equal(machine.status().state, "OFFLINE");
  assert.equal(machine.status().session, null);
  assert.equal(machine.status().playing, false);
});

// Ce test verifie qu'une panne definitive bloque la machine : elle ne doit pas repartir toute seule
// sur un etat recu apres coup.
test("reste en erreur apres une panne definitive", () => {
  const { machine } = makeMachine();

  machine.fail("audio_start_failed");
  assert.equal(machine.status().state, "ERROR");
  assert.equal(machine.status().errorReason, "audio_start_failed");

  machine.setStream(live(1));
  machine.play();
  assert.equal(machine.status().state, "ERROR");
});
