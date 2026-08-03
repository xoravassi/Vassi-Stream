import assert from "node:assert/strict";
import test from "node:test";

import { createPcmBuffer, PcmRing } from "../src/player/pcm-worklet.js";

// Ce fichier verifie la file PCM qui relie le worker de decodage au processeur audio. C'est la
// seule piece du bloc 8 traversee par chaque echantillon : une erreur ici s'entend tout de suite.

// Cette fonction cree une petite file, assez courte pour que les tests atteignent ses limites.
function makeRing(capacityFrames = 16): PcmRing {
  return new PcmRing(createPcmBuffer(false, capacityFrames), capacityFrames);
}

// Cette fonction cree un bloc stereo dont chaque echantillon est reconnaissable.
function block(start: number, count: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(count);
  const right = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    left[index] = start + index;
    right[index] = -(start + index);
  }

  return { left, right };
}

// Ce test verifie que les echantillons ressortent dans l'ordre et sur le bon canal. Une inversion
// gauche/droite ou un decalage d'un echantillon passerait inapercu autrement.
test("rend les echantillons dans l'ordre et sur le bon canal", () => {
  const ring = makeRing();
  const source = block(1, 5);

  assert.equal(ring.write(source.left, source.right), true);
  assert.equal(ring.available, 5);

  const left = new Float32Array(5);
  const right = new Float32Array(5);
  assert.equal(ring.read(left, right), 5);

  assert.deepEqual(Array.from(left), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(right), [-1, -2, -3, -4, -5]);
  assert.equal(ring.available, 0);
});

// Ce test verifie que la file revient au debut de sa memoire sans perdre l'ordre. Sans ce
// comportement, la file ne servirait qu'une fois.
test("continue au debut de la memoire quand elle arrive au bout", () => {
  const ring = makeRing(8);
  const premier = block(1, 6);
  ring.write(premier.left, premier.right);

  const sortie = { left: new Float32Array(6), right: new Float32Array(6) };
  ring.read(sortie.left, sortie.right);

  // Cette ecriture depasse la fin de la memoire et reprend a son debut.
  const second = block(10, 5);
  assert.equal(ring.write(second.left, second.right), true);

  const relu = { left: new Float32Array(5), right: new Float32Array(5) };
  assert.equal(ring.read(relu.left, relu.right), 5);
  assert.deepEqual(Array.from(relu.left), [10, 11, 12, 13, 14]);
});

// Ce test verifie qu'une file pleine refuse le bloc entier au lieu d'en garder la moitie. Un demi
// bloc laisserait un canal decale par rapport a l'autre pour le reste du direct.
test("refuse un bloc entier quand la place manque", () => {
  const ring = makeRing(8);
  const premier = block(1, 7);
  assert.equal(ring.write(premier.left, premier.right), true);

  const second = block(100, 4);
  assert.equal(ring.write(second.left, second.right), false);
  assert.equal(ring.overflows, 1);
  assert.equal(ring.available, 7);

  const sortie = { left: new Float32Array(7), right: new Float32Array(7) };
  ring.read(sortie.left, sortie.right);
  assert.deepEqual(Array.from(sortie.left), [1, 2, 3, 4, 5, 6, 7]);
});

// Ce test verifie qu'une lecture sans donnees produit du silence et compte le manque. Le processeur
// audio ne doit jamais repeter le dernier bloc : une repetition s'entend plus qu'un court silence.
test("produit du silence et compte le manque quand la file est vide", () => {
  const ring = makeRing();
  const source = block(1, 2);
  ring.write(source.left, source.right);

  const left = new Float32Array(4);
  const right = new Float32Array(4);
  assert.equal(ring.read(left, right), 2);

  assert.deepEqual(Array.from(left), [1, 2, 0, 0]);
  assert.deepEqual(Array.from(right), [-1, -2, 0, 0]);
  assert.equal(ring.underruns, 1);
});

// Ce test verifie que vider la file laisse toute la place disponible. C'est ce qui se passe a chaque
// nouvelle session et a chaque discontinuite.
test("libere toute la place quand la file est videe", () => {
  const ring = makeRing(8);
  const source = block(1, 7);
  ring.write(source.left, source.right);

  ring.clear();

  assert.equal(ring.available, 0);
  const suivant = block(50, 7);
  assert.equal(ring.write(suivant.left, suivant.right), true);
});

// Ce test verifie la conversion en millisecondes utilisee par les seuils de latence. Un facteur faux
// ferait attendre le player dix fois trop longtemps ou pas du tout.
test("convertit la quantite disponible en millisecondes", () => {
  const ring = new PcmRing(createPcmBuffer(false, 48000), 48000);
  const source = block(0, 960);

  ring.write(source.left, source.right);

  assert.equal(ring.available, 960);
  assert.equal(ring.availableMs, 20);
});
