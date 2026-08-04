import assert from "node:assert/strict";
import test from "node:test";

import { readStreamState, type StreamState } from "../src/player/player-protocol.ts";
import { LATE_MARGIN_MS, PlayerStateMachine, type PlayerState } from "../src/player/player-state.ts";

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

// Ce test verifie qu'un underrun bref ne provoque pas un rebuffering si la file reste suffisante.
test("ne rebufferise pas sur un underrun bref quand la file reste au-dessus du seuil", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.reportLevel(450, 1);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().playing, true);
  assert.equal(machine.status().accepting, true);
});

// Ce test verifie qu'une petite baisse locale autour du seuil ne provoque pas de bascule continue.
test("ne bascule pas en boucle autour du seuil de buffer", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.reportLevel(360, 1);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().playing, true);

  machine.reportLevel(380, 2);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().playing, true);
});

// Ce test verifie qu'une reprise trop courte depuis une baisse de buffer n'annule pas la phase de
// rebufferisation si le thread audio a ete bloque un moment. Le retour a la lecture doit attendre un
// niveau suffisamment proche du seuil, sinon la machine oscille entre REBUFFERING et PLAYING.
test("attend un niveau plus robuste avant de sortir de rebufferisation", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  machine.reportLevel(300, 1);
  assert.equal(machine.status().state, "REBUFFERING");
  assert.equal(machine.status().playing, false);

  machine.reportLevel(360, 2);
  assert.equal(machine.status().state, "REBUFFERING");
  assert.equal(machine.status().playing, false);

  machine.reportLevel(400, 2);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().playing, true);
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

// Ce test verifie la sortie d'erreur. Une panne passagere ne doit pas bloquer la page jusqu'au
// rechargement : l'appelant rebatit le contexte audio, puis la machine repart de ce que le relais
// annonce.
test("sort de l'erreur sur demande et repart du direct annonce", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.fail("audio_start_failed");
  assert.equal(machine.status().state, "ERROR");

  machine.recover();
  assert.equal(machine.status().state, "READY");
  assert.equal(machine.status().errorReason, null);

  machine.play();
  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "PLAYING");
});

// Ce test verifie que la sortie d'erreur ne touche a rien quand il n'y a pas d'erreur.
test("ignore une sortie d'erreur demandee hors erreur", () => {
  const { machine, etats } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  const avant = etats.length;
  machine.recover();

  assert.equal(machine.status().state, "PLAYING");
  assert.equal(etats.length, avant);
});

// Ce test couvre la derive de retard, la panne que rien d'autre ne rattrape.
//
// Un onglet mis en arriere-plan, un contexte suspendu par le systeme ou un peripherique debranche
// arretent le thread audio sans arreter le decodeur. La file grossit alors bien au-dela du seuil,
// et le son qu'elle contient est vieux d'autant. Sans cette limite, la lecture reprendrait sur ce
// son ancien et l'auditeur resterait en retard sur le direct jusqu'a la fin.
test("jette le son en attente quand la file a grossi bien au-dela du seuil", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "PLAYING");

  const vidages = machine.status().flushId;

  // Un depassement ordinaire ne declenche rien : le niveau varie normalement autour du seuil.
  machine.reportLevel(400 + LATE_MARGIN_MS - 50, 0);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().flushId, vidages);

  // Au-dela de la marge, le thread audio n'a pas consomme : le son en attente est jete.
  machine.reportLevel(400 + LATE_MARGIN_MS + 50, 0);
  assert.equal(machine.status().state, "REBUFFERING");
  assert.equal(machine.status().flushId, vidages + 1);

  // La reprise se fait sur le son neuf, au seuil habituel.
  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "PLAYING");
});

// Ce test verifie que le seuil de derive suit le profil de latence annonce, et non une valeur fixe.
test("mesure la derive a partir du seuil du profil", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1, "stable"));
  machine.play();
  machine.reportLevel(800, 0);
  assert.equal(machine.status().state, "PLAYING");

  // Cette valeur depasserait la marge du profil equilibre, pas celle du profil stable.
  machine.reportLevel(1500, 0);
  assert.equal(machine.status().state, "PLAYING");

  machine.reportLevel(1900, 0);
  assert.equal(machine.status().state, "REBUFFERING");
});

// Ce test verifie qu'une bufferisation ne se termine jamais sur du son deja trop vieux.
//
// C'est le cas vu pendant l'essai long, apres la mise en veille du portable. La machine etait en
// rebufferisation, le thread audio est revenu avec trois secondes de son en attente, et la seule
// regle de cet etat — « la file atteint le seuil, donc on joue » — a repris la lecture sur ce son
// ancien. Quarante millisecondes plus tard, la regle de derive concluait au retard et rebufferisait.
// Le journal montrait REBUFFERING, PLAYING, REBUFFERING, PLAYING pour un seul incident, et
// l'auditeur entendait le son perime pendant l'aller-retour.
test("ne sort pas de rebufferisation sur du son deja en retard", () => {
  const { machine, etats } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);
  machine.reportLevel(0, 1);
  assert.equal(machine.status().state, "REBUFFERING");

  const vidages = machine.status().flushId;
  const transitions = etats.length;

  // Le thread audio revient : la file porte trois secondes que personne n'a consommees.
  machine.reportLevel(3000, 1);

  assert.equal(machine.status().state, "REBUFFERING", "la bufferisation continue sur du son neuf");
  assert.equal(machine.status().playing, false);
  assert.equal(machine.status().flushId, vidages + 1, "le son en attente est jete");
  assert.equal(etats.length, transitions + 1, "l'ordre de vidage doit atteindre le decodeur");

  // La reprise se fait une seule fois, au seuil habituel.
  machine.reportLevel(400, 1);
  assert.equal(machine.status().state, "PLAYING");
  assert.equal(machine.status().flushId, vidages + 1, "un seul vidage pour un seul retard");
});

// Ce test verifie la meme regle pendant la toute premiere bufferisation, celle qui suit le clic sur
// Play ou une coupure : elle non plus ne doit pas demarrer sur du son ancien.
test("ne demarre pas la lecture sur une file remplie pendant un arret du thread audio", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  assert.equal(machine.status().state, "BUFFERING");

  const vidages = machine.status().flushId;
  machine.reportLevel(2500, 0);

  assert.equal(machine.status().state, "BUFFERING");
  assert.equal(machine.status().flushId, vidages + 1);

  machine.reportLevel(400, 0);
  assert.equal(machine.status().state, "PLAYING");
});

// Ce test verifie qu'un manque de donnees reste prioritaire sur la derive : les deux ne peuvent pas
// se produire ensemble, et le manque de donnees ne demande aucun vidage puisque la file est vide.
test("ne demande pas de vidage pour un simple manque de donnees", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.reportLevel(400, 0);

  const vidages = machine.status().flushId;
  machine.reportLevel(0, 1);

  assert.equal(machine.status().state, "REBUFFERING");
  assert.equal(machine.status().flushId, vidages);
});

// Ce test verifie que le relais reste ecoute pendant une panne.
//
// Le relais n'annonce un direct qu'au moment ou il change. Une machine qui ignorerait ces annonces
// tant qu'elle est en panne repartirait sur la session precedente, et le decodeur refuserait chaque
// paquet pour session etrangere : la page resterait muette, en bufferisation, sans rien annoncer, et
// aucune nouvelle annonce ne viendrait la debloquer.
test("enregistre la session annoncee pendant une panne", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.fail("worker_failed");
  assert.equal(machine.status().state, "ERROR");

  // Le direct change pendant que la machine est en panne.
  machine.setStream(OFFLINE);
  assert.equal(machine.status().state, "ERROR", "l'etat de panne ne bouge pas");
  assert.equal(machine.status().session, null);

  machine.setStream(live(2));
  assert.equal(machine.status().state, "ERROR");

  machine.recover();
  assert.equal(machine.status().state, "READY");
  assert.equal(machine.status().session?.sessionId, 2, "la reprise part du direct en cours");
});

// Ce test verifie le meme point pour une coupure de connexion : la reprise ne doit pas croire a un
// direct termine depuis longtemps.
test("oublie la session quand la connexion tombe pendant une panne", () => {
  const { machine } = makeMachine();

  machine.setStream(live(1));
  machine.play();
  machine.fail("worker_failed");

  machine.connectionLost();
  assert.equal(machine.status().state, "ERROR");

  machine.recover();
  assert.equal(machine.status().state, "OFFLINE");
  assert.equal(machine.status().session, null);
});
