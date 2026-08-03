import assert from "node:assert/strict";
import test from "node:test";

import { readStreamState, targetBufferMs } from "../src/player/player-protocol.ts";

// Ce fichier verifie la lecture des messages recus par un auditeur. La page est publique : elle doit
// rester utilisable devant n'importe quel message, y compris un message abime.

// Cette fonction construit un etat en direct conforme au protocole v1.
function liveState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "stream_state",
    protocolVersion: 1,
    live: true,
    sessionId: 4242,
    codec: "opus",
    bitrate: 256000,
    sampleRate: 48000,
    channels: 2,
    frameDurationMs: 20,
    latencyProfile: "balanced",
    ...overrides,
  });
}

// Ce test verifie qu'un etat en direct est lu avec son seuil de bufferisation.
test("lit un etat en direct et son seuil de latence", () => {
  const etat = readStreamState(liveState());

  assert.equal(etat?.live, true);
  assert.equal(etat?.session?.sessionId, 4242);
  assert.equal(etat?.session?.bitrate, 256000);
  assert.equal(etat?.session?.latencyProfile, "balanced");
  assert.equal(etat?.session?.targetBufferMs, 400);
});

// Ce test verifie l'etat hors ligne, celui que la page voit avant le premier live.
test("lit l'etat hors ligne", () => {
  const etat = readStreamState(JSON.stringify({ type: "stream_state", protocolVersion: 1, live: false }));

  assert.deepEqual(etat, { live: false, session: null });
});

// Ce test verifie les trois seuils normatifs du protocole. Le player ne choisit pas d'autre valeur
// pour un nom donne : c'est le contrat entre le device et la page.
test("applique les trois seuils de latence du protocole", () => {
  assert.equal(targetBufferMs("low"), 200);
  assert.equal(targetBufferMs("balanced"), 400);
  assert.equal(targetBufferMs("stable"), 800);
});

// Ce test verifie qu'un profil inconnu ne bloque pas le direct. Mieux vaut un demarrage un peu long
// qu'une page qui refuse de jouer parce qu'un nom a change.
test("traite un profil inconnu comme equilibre", () => {
  const etat = readStreamState(liveState({ latencyProfile: "inconnu" }));

  assert.equal(etat?.live, true);
  assert.equal(etat?.session?.targetBufferMs, 400);
});

// Ce test verifie qu'un direct impossible a decrire est traite comme un etat hors ligne. La page
// affiche alors « pas pret » au lieu de tenter de jouer un flux qu'elle ne sait pas lire.
test("traite un direct hors de la v1 comme un etat hors ligne", () => {
  for (const invalide of [
    liveState({ codec: "mp3" }),
    liveState({ channels: 1 }),
    liveState({ sampleRate: 44100 }),
    liveState({ frameDurationMs: 40 }),
    liveState({ sessionId: 0 }),
  ]) {
    assert.deepEqual(readStreamState(invalide), { live: false, session: null }, invalide);
  }
});

// Ce test verifie qu'un message illisible est ignore sans faire planter la page.
test("ignore un message illisible ou etranger", () => {
  assert.equal(readStreamState("pas du json"), null);
  assert.equal(readStreamState("[1,2,3]"), null);
  assert.equal(readStreamState(JSON.stringify({ type: "autre", protocolVersion: 1 })), null);
  assert.equal(readStreamState(JSON.stringify({ type: "stream_state", protocolVersion: 2, live: false })), null);
});
