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

// Ce test verifie qu'un creux compte une fois, et non une fois par bloc.
//
// La carte son demande un bloc toutes les 2,7 ms, et le thread principal ne relit le compteur que
// toutes les 40 ms : un seul trou entendu ajouterait une quinzaine d'unites. Le nombre affiche a
// l'auditeur ne dirait alors plus rien de la gravite, et la regle « la file s'est videe depuis le
// dernier rapport » compterait quinze fois le meme evenement.
test("compte un manque de donnees par creux, pas par bloc", () => {
  const ring = makeRing();
  const left = new Float32Array(4);
  const right = new Float32Array(4);

  // Quatre lectures de suite sur une file vide : c'est un seul creux.
  for (let lecture = 0; lecture < 4; lecture += 1) {
    ring.read(left, right);
  }

  assert.equal(ring.underruns, 1);

  // La file se remplit de nouveau et sert deux lectures completes : le creux est termine.
  const source = block(1, 8);
  ring.write(source.left, source.right);
  assert.equal(ring.read(left, right), 4);
  assert.equal(ring.read(left, right), 4);
  assert.equal(ring.underruns, 1);

  // Le creux suivant est bien un evenement nouveau.
  ring.read(left, right);
  ring.read(left, right);
  assert.equal(ring.underruns, 2);
});

// Ce test verifie qu'une lecture servie a moitie compte comme un creux : le silence ajoute en fin de
// bloc s'entend autant qu'un bloc entierement vide.
test("compte un manque de donnees des qu'un bloc n'est pas servi en entier", () => {
  const ring = makeRing();
  const source = block(1, 3);
  ring.write(source.left, source.right);

  const left = new Float32Array(4);
  const right = new Float32Array(4);
  assert.equal(ring.read(left, right), 3);
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

// Ce test verifie que vider la file resiste a un consommateur qui avance au meme instant.
//
// Le producteur lit l'index de lecture puis ecrit l'index d'ecriture : entre les deux, le thread
// audio peut avoir avance. L'index d'ecriture se retrouve alors derriere celui de lecture, et la
// file, qui compte a l'envers dans ce cas, se croit pleine. Le seuil de lecture est atteint
// immediatement et l'auditeur entend toute la memoire perimee, jusqu'a trois secondes.
//
// Ce test place cette avance exactement dans l'intervalle, en remplacant `Atomics.load` le temps
// d'un vidage.
test("vide la file meme si le consommateur avance pendant le vidage", () => {
  const ring = makeRing(16);
  const source = block(1, 10);
  ring.write(source.left, source.right);

  // Le consommateur a deja lu quatre echantillons quand le vidage commence.
  const sortie = { left: new Float32Array(4), right: new Float32Array(4) };
  ring.read(sortie.left, sortie.right);

  const vraiLoad = Atomics.load;
  let avanceFaite = false;

  // Cette version avance l'index de lecture une seule fois, juste apres que le producteur l'a lu.
  Atomics.load = ((tableau: Int32Array, index: number): number => {
    const valeur = vraiLoad(tableau, index);

    if (index === 1 && !avanceFaite) {
      avanceFaite = true;
      Atomics.store(tableau, 1, valeur + 3);
    }

    return valeur;
  }) as typeof Atomics.load;

  try {
    ring.clear();
  } finally {
    Atomics.load = vraiLoad;
  }

  assert.equal(avanceFaite, true, "le test doit avoir place une avance dans l'intervalle");
  assert.equal(ring.available, 0, "la file doit etre vide, et non pleine a l'envers");

  // Et elle reste utilisable : la place entiere est disponible pour le son neuf.
  const suivant = block(50, 15);
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

// Ce test couvre le filet du consommateur : la file bornee par celui qui la lit.
//
// Le vidage demande par la machine d'etats est un aller-retour — le niveau part du thread audio, la
// decision revient quarante millisecondes plus tard, l'ordre traverse encore le worker. Une rafale
// de paquets livree d'un coup remplit les trois secondes de la file avant que cet aller-retour
// n'aboutisse : la file bute alors sur sa capacite et compte des blocs abandonnes, qui sont du son
// perdu. C'est ce qui s'est produit pendant l'essai long de la nuit du 4 aout 2026, 178 fois.
//
// Le consommateur, lui, ne peut pas etre distance : il tourne a chaque bloc.
test("jette le son le plus ancien et garde ce qu'on lui demande", () => {
  const ring = makeRing(32);
  const source = block(1, 20);

  ring.write(source.left, source.right);
  assert.equal(ring.available, 20);
  assert.equal(ring.skips, 0);

  assert.equal(ring.dropOldest(5), true);
  assert.equal(ring.available, 5, "il ne reste que ce qui a ete demande");
  assert.equal(ring.skips, 1, "le saut est compte, donc visible dans le diagnostic");

  // Ce qui reste est bien le son le plus recent : c'est la fin du bloc ecrit, pas son debut.
  const left = new Float32Array(5);
  const right = new Float32Array(5);
  ring.read(left, right);

  assert.deepEqual(Array.from(left), [16, 17, 18, 19, 20]);
  assert.deepEqual(Array.from(right), [-16, -17, -18, -19, -20]);
});

// Ce test verifie que le filet ne se declenche pas quand la file tient dans sa borne. Un saut inutile
// couperait le son sans raison.
test("ne saute pas quand la file tient dans sa borne", () => {
  const ring = makeRing(32);
  const source = block(1, 6);

  ring.write(source.left, source.right);

  assert.equal(ring.dropOldest(10), false);
  assert.equal(ring.available, 6);
  assert.equal(ring.skips, 0);
});

// Ce test verifie que le saut fonctionne quand la file a fait le tour de sa memoire. L'index de
// lecture doit revenir au debut, sinon il sort du tableau et le son lu est du silence.
test("saute correctement quand la file a fait le tour de sa memoire", () => {
  const ring = makeRing(16);

  // Cette premiere passe amene les deux index pres de la fin de la memoire.
  const premier = block(1, 12);
  ring.write(premier.left, premier.right);
  ring.read(new Float32Array(12), new Float32Array(12));

  // Cette ecriture repasse par le debut de la memoire.
  const second = block(100, 12);
  ring.write(second.left, second.right);
  assert.equal(ring.available, 12);

  assert.equal(ring.dropOldest(4), true);
  assert.equal(ring.available, 4);

  const left = new Float32Array(4);
  const right = new Float32Array(4);
  assert.equal(ring.read(left, right), 4);
  assert.deepEqual(Array.from(left), [108, 109, 110, 111]);
});
