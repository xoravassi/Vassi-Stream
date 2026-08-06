import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_STALL_MS,
  DECODE_SAMPLE,
  explainPlayer,
  SILENT_NETWORK_MS,
  type PlayerDiagnostics,
} from "../src/player/player-diagnostics.ts";

// Ce fichier verifie la seule chose que les compteurs doivent apporter : savoir laquelle des trois
// pannes possibles est en cours. De l'exterieur, elles se ressemblent toutes — le son ne sort pas.
//
// Chaque test decrit une panne reelle, puis verifie que le moteur la range dans la bonne famille.

// Cette base decrit un moteur en pleine lecture, sans rien a signaler. Chaque test n'en change que
// ce qui distingue sa panne.
const SAIN: PlayerDiagnostics = {
  state: "PLAYING",
  sessionId: 4242,
  sessionBitrate: 256000,
  targetBufferMs: 400,
  shared: true,

  connected: true,
  packets: 1500,
  bytes: 1500 * 668,
  sincePacketMs: 20,
  sinceLiveMs: 30000,

  accepted: 1500,
  decoded: 1500,
  refused: 0,
  lastRefusal: null,
  discontinuities: 0,
  concealedMs: 0,
  lastGapReason: null,
  lastGapMs: null,

  audio: "RUNNING",
  contextState: "running",
  bufferedMs: 410,
  underruns: 0,
  overflows: 0,
  skips: 0,
  sinceLevelMs: 40,

  errorReason: null,
  errorArea: null,
};

// Cette fonction fabrique un etat a partir de la base saine.
function etat(changes: Partial<PlayerDiagnostics>): PlayerDiagnostics {
  return { ...SAIN, ...changes };
}

test("ne signale rien quand le son sort normalement", () => {
  assert.equal(explainPlayer(SAIN).area, "ok");
});

// Panne reseau la plus simple : le relais est injoignable et le socket tente de revenir.
test("range une connexion perdue dans le reseau", () => {
  const verdict = explainPlayer(etat({ connected: false, state: "OFFLINE", sessionId: null }));

  assert.equal(verdict.area, "network");
  assert.match(verdict.message, /relais/);
});

// Panne reseau plus sournoise : la connexion tient, le relais annonce un direct, mais plus aucun
// paquet n'arrive. C'est ce que produit un publisher fige ou un chemin reseau coupe en aval.
test("range un direct annonce mais muet dans le reseau", () => {
  const verdict = explainPlayer(etat({ sincePacketMs: SILENT_NETWORK_MS + 1000 }));

  assert.equal(verdict.area, "network");
  assert.match(verdict.message, /aucun paquet/);
});

test("ne s'alarme pas d'un silence plus court que le seuil", () => {
  assert.equal(explainPlayer(etat({ sincePacketMs: SILENT_NETWORK_MS - 100 })).area, "ok");
});

// Panne de decodage : les paquets arrivent et sont acceptes, mais aucune frame n'en sort. C'est
// exactement ce que produisait le defaut de session du bloc 8, et la page restait muette sans rien
// dire.
test("range des paquets acceptes sans frame decodee dans le decodage", () => {
  const verdict = explainPlayer(
    etat({
      state: "BUFFERING",
      accepted: DECODE_SAMPLE + 10,
      decoded: 0,
      refused: 60,
      lastRefusal: "session_mismatch",
      bufferedMs: 0,
    }),
  );

  assert.equal(verdict.area, "decode");
  assert.match(verdict.message, /session_mismatch/);
});

test("laisse le decodeur demarrer avant de conclure a une panne", () => {
  const verdict = explainPlayer(etat({ state: "BUFFERING", accepted: 3, decoded: 0, bufferedMs: 0 }));

  assert.notEqual(verdict.area, "decode");
});

// Panne de contexte audio : le thread audio ne demande plus de blocs, donc il n'annonce plus de
// niveau. Rien d'autre ne le signale, et la page continuerait d'afficher `PLAYING`.
test("range un thread audio arrete dans le contexte audio", () => {
  const verdict = explainPlayer(etat({ sinceLevelMs: AUDIO_STALL_MS + 1500 }));

  assert.equal(verdict.area, "audio");
  assert.match(verdict.message, /thread audio/);
});

test("range un contexte suspendu dans le contexte audio", () => {
  const verdict = explainPlayer(etat({ contextState: "suspended" }));

  assert.equal(verdict.area, "audio");
  assert.match(verdict.message, /suspended/);
});

// Safari annonce `interrupted` la ou les autres annoncent `suspended` : la famille doit etre la
// meme, et le mot exact doit apparaitre pour que la cause soit reconnaissable.
test("reconnait l'interruption annoncee par Safari", () => {
  const verdict = explainPlayer(etat({ contextState: "interrupted" }));

  assert.equal(verdict.area, "audio");
  assert.match(verdict.message, /interrupted/);
});

// La cause la plus en amont l'emporte : un relais muet produit forcement une file vide, donc il ne
// faut pas conclure a une panne de decodage.
test("prefere la cause en amont quand deux symptomes coexistent", () => {
  const verdict = explainPlayer(
    etat({
      connected: false,
      sincePacketMs: 9000,
      accepted: 500,
      decoded: 0,
      sinceLevelMs: 9000,
    }),
  );

  assert.equal(verdict.area, "network");
});

// Ces trois etats ne sont pas des pannes : le moteur attend quelque chose qui ne depend pas de lui.
test("distingue l'attente d'une panne", () => {
  assert.equal(explainPlayer(etat({ state: "OFFLINE", sessionId: null })).area, "idle");
  assert.equal(explainPlayer(etat({ state: "READY", audio: "IDLE" })).area, "idle");
  assert.equal(explainPlayer(etat({ state: "PAUSED" })).area, "idle");
  assert.equal(explainPlayer(etat({ audio: "STARTING", contextState: null })).area, "idle");
});

// Une panne definitive garde la famille d'ou elle venait : c'est la seule information que le
// message d'erreur seul ne donne pas toujours.
test("garde la famille d'une panne definitive", () => {
  const decodage = explainPlayer(etat({ state: "ERROR", errorReason: "opus_start_failed", errorArea: "decode" }));
  assert.equal(decodage.area, "decode");
  assert.match(decodage.message, /opus_start_failed/);

  const audio = explainPlayer(etat({ state: "ERROR", errorReason: "NotAllowedError", errorArea: "audio" }));
  assert.equal(audio.area, "audio");
});
