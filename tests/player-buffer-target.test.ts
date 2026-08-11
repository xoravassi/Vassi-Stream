import assert from "node:assert/strict";
import test from "node:test";

import {
  BufferTarget,
  DECAY_MS_PER_SECOND,
  MAX_TARGET_MS,
  TARGET_SAFETY,
  UNDERRUN_GROWTH,
} from "../src/player/buffer-target.ts";

// Ce fichier verifie le regulateur de seuil de bufferisation. Il est pur : il recoit des dates et
// rend une duree, donc chaque scenario se joue ici en quelques microsecondes au lieu d'attendre
// plusieurs minutes de direct.

// Cette fonction fait arriver `nombre` paquets a la cadence nominale du protocole, et rend la date
// du dernier.
function fluxRegulier(regulateur: BufferTarget, depart: number, nombre: number): number {
  let at = depart;

  for (let index = 0; index < nombre; index += 1) {
    regulateur.notePacket(at);
    at += 40;
  }

  return at - 40;
}

// Ce test verifie le cas de tres loin le plus frequent : un lien sain ne doit rien changer. Le
// profil choisi par l'auditeur reste ce qu'il obtient, et le regulateur ne se paie aucune latence.
test("laisse le seuil au plancher tant que les paquets arrivent a l'heure", () => {
  const regulateur = new BufferTarget(400);

  const fin = fluxRegulier(regulateur, 1000, 200);

  assert.equal(regulateur.targetMs(fin), 400);
  assert.equal(regulateur.stallMs, 0);
});

// Ce test verifie la reponse a un blocage : le seuil monte tout de suite, parce que se tromper en
// n'ayant pas assez de tampon coute une coupure.
test("remonte le seuil des qu'un blocage a vide plus que le plancher", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 50);
  // Un blocage d'une seconde : 960 ms de tampon consommees, une fois retiree la trame attendue.
  at += 1000;
  regulateur.notePacket(at);

  assert.equal(regulateur.stallMs, 960);
  // 960 x 1,5 = 1440, arrondi au pas de 50.
  assert.equal(regulateur.targetMs(at), 1450);
});

// Ce test verifie que le seuil ne descend jamais sous le choix de l'auditeur. Le profil est un
// plancher de qualite de service : un lien parfait ne doit pas ramener la latence sous ce qu'il a
// demande, sinon le reglage ne veut plus rien dire.
test("ne descend jamais sous le plancher du profil, meme sur un lien parfait", () => {
  const regulateur = new BufferTarget(800);

  const fin = fluxRegulier(regulateur, 1000, 500);

  assert.equal(regulateur.targetMs(fin), 800);
});

// Ce test verifie la dissymetrie voulue entre la montee et la descente : le seuil retombe, mais
// lentement, pour ne pas se decouvrir au premier repit d'un lien qui hoquette encore.
test("redescend lentement apres un blocage, sans y retomber au premier repit", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1000;
  regulateur.notePacket(at);

  const hausse = regulateur.targetMs(at);
  assert.ok(hausse > 1000);

  // Dix secondes de calme ne suffisent pas a tout oublier.
  assert.ok(regulateur.targetMs(at + 10000) > 1000, "dix secondes ne doivent pas tout effacer");

  // Le souvenir s'efface a vitesse constante : 960 ms mettent donc 192 secondes a disparaitre.
  const efface = at + (960 / DECAY_MS_PER_SECOND) * 1000 + 1000;
  assert.equal(regulateur.targetMs(efface), 400, "le calme doit finir par rendre le plancher");
});

// Ce test verifie que le manque de donnees fait autorite. Il prouve directement que le seuil courant
// etait trop court, la ou la mesure des blocages ne faisait que le prevoir.
test("remonte le seuil sur un manque de donnees, meme sans blocage mesure", () => {
  const regulateur = new BufferTarget(400);

  const at = fluxRegulier(regulateur, 1000, 50);
  assert.equal(regulateur.targetMs(at), 400);

  regulateur.noteUnderrun(at);

  // 400 x 1,25 de blocage retenu, puis x 1,5 de marge : 750, deja au pas de 50.
  assert.equal(regulateur.targetMs(at), Math.round((400 * UNDERRUN_GROWTH * TARGET_SAFETY) / 50) * 50);
});

// Ce test verifie que des manques repetes font monter le seuil sans jamais l'emballer. Sans plafond,
// une rafale de manques finirait par demander plusieurs secondes de tampon, et le direct n'en serait
// plus un.
test("ne depasse jamais son plafond, meme sur une rafale de manques", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);

  for (let index = 0; index < 100; index += 1) {
    regulateur.noteUnderrun(at);
    at += 100;
  }

  assert.equal(regulateur.targetMs(at), MAX_TARGET_MS);
});

// Ce test verifie qu'un nouveau direct repart a neuf. Une reconnexion passe souvent par un autre
// chemin reseau, et faire payer au direct suivant la latence du precedent n'a aucune justification.
test("oublie tout et reprend son plancher a chaque nouveau direct", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1500;
  regulateur.notePacket(at);
  assert.ok(regulateur.targetMs(at) > 1000);

  regulateur.reset(200);

  assert.equal(regulateur.stallMs, 0);
  assert.equal(regulateur.targetMs(at), 200);
});

// Ce test verifie que le seuil ne bouge que par pas visibles. Sans quantification, chaque paquet le
// deplacerait de quelques millisecondes, et chaque deplacement ferait travailler le regulateur de
// vitesse du processeur audio pour rien.
test("ne rend que des seuils au pas de cinquante millisecondes", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);

  for (const blocage of [317, 511, 823, 1279]) {
    at += blocage;
    regulateur.notePacket(at);
    assert.equal(regulateur.targetMs(at) % 50, 0, `seuil non quantifie apres un blocage de ${blocage} ms`);
  }
});

// Ce test couvre la regle qui empeche le seuil de mentir, mesuree sur le journal du 6 aout 2026 a
// 23h18.
//
// Le seuil descend de 7,5 ms par seconde ; le processeur audio ne sait resorber un exces qu'a 5 ms
// par seconde au mieux. Un seuil qui descend pendant que la file est encore au-dessus creuse donc un
// ecart qui ne se referme jamais : sur trois minutes de ce journal, le seuil est passe de 2000 a
// 900 ms pendant que le tampon ne descendait que de 2023 a 1641. Le seuil affichait 900 quand
// l'auditeur en entendait 1641.
test("ne baisse pas le seuil tant que la file est restee au-dessus", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1200;
  regulateur.notePacket(at);

  const hausse = regulateur.targetMs(at);
  assert.ok(hausse > 1000, "un blocage d'une seconde doit relever le seuil");

  // La file est restee loin au-dessus du seuil pendant une minute entiere.
  regulateur.noteLevel(hausse * 2);
  assert.equal(regulateur.targetMs(at + 60000), hausse, "le seuil ne doit pas avoir bouge");
});

// Ce test verifie que la porte se rouvre : le seuil reprend sa descente des que la file l'a rejoint.
// Sans cette descente, le seuil resterait gele en haut pour toujours.
test("reprend la descente des que la file a rejoint le seuil", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1200;
  regulateur.notePacket(at);

  const hausse = regulateur.targetMs(at);
  regulateur.noteLevel(hausse * 2);
  at += 60000;
  assert.equal(regulateur.targetMs(at), hausse);

  regulateur.noteLevel(hausse);
  assert.ok(regulateur.targetMs(at + 30000) < hausse, "le seuil doit repartir vers le bas");
});

// Ce test verifie que le temps passe porte fermee n'est pas garde pour plus tard. Le rendre d'un coup
// a la reouverture produirait exactement la marche que ce module existe pour eviter.
test("n'accumule pas la decroissance suspendue", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1200;
  regulateur.notePacket(at);
  const hausse = regulateur.targetMs(at);

  // Une minute porte fermee, puis la file rejoint le seuil et une seconde s'ecoule.
  regulateur.noteLevel(hausse * 2);
  at += 60000;
  regulateur.targetMs(at);
  regulateur.noteLevel(hausse);

  const apresUneSeconde = regulateur.targetMs(at + 1000);

  // Une seconde de decroissance vaut 7,5 ms de seuil, bien en dessous du pas de quantification :
  // le seuil ne doit donc pas encore avoir bouge, et surtout pas s'etre effondre d'un coup.
  assert.equal(apresUneSeconde, hausse);
});

// Ce test verifie que la porte ne bloque que par le haut. Une file plus maigre que le seuil doit
// laisser celui-ci redescendre : les deux se rapprochent alors, ce qui est le but, et tout nouveau
// blocage le releve de toute facon aussitot.
test("laisse le seuil redescendre quand la file est sous lui", () => {
  const regulateur = new BufferTarget(400);

  let at = fluxRegulier(regulateur, 1000, 10);
  at += 1200;
  regulateur.notePacket(at);
  const hausse = regulateur.targetMs(at);

  regulateur.noteLevel(0);

  assert.ok(regulateur.targetMs(at + 30000) < hausse);
});
