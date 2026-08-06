// Ce module decide combien de son le player doit garder d'avance. Il ne connait ni navigateur, ni
// file PCM, ni machine d'etats : il recoit des dates d'arrivee de paquets et rend une duree. C'est
// ce qui le rend verifiable sous Node, seconde par seconde, sans attendre.
//
// Il existe parce que le seuil etait fixe par l'auditeur, et que l'auditeur ne sait rien du lien.
// Les journaux du 6 aout 2026 le montrent des deux cotes : a 400 ms, un lien noye par un appel Meet
// produit 46 rebufferisations en deux minutes et demie ; a 800 ms sur un lien sain, il en reste
// encore 27 en vingt-neuf minutes, parce que la 4G bloque parfois plus longtemps que ca. Aucune
// valeur fixe ne convient aux deux, et seule l'arrivee des paquets sait laquelle il faut.
//
// Le choix de l'auditeur ne disparait pas : il devient le plancher. C'est la meme conversion que
// celle deja faite cote device, ou la qualite choisie est devenue un plafond de debit plutot qu'une
// valeur figee. Dans les deux cas le reglage humain borne le regulateur au lieu de le remplacer.

import { RATE_DEADBAND } from "./pcm-worklet.js";

// Duree nominale entre deux paquets, en millisecondes : la duree d'une trame du protocole v1.1.
const FRAME_MS = 40;

// Seuil le plus haut que le regulateur puisse demander.
//
// Au-dela, le direct cesse d'en etre un. Un lien qui bloque plus de deux secondes ne se rattrape pas
// avec du tampon : il faut le reparer.
export const MAX_TARGET_MS = 2000;

// Marge appliquee au plus long blocage observe.
//
// Un seuil egal au pire blocage vu ne survivrait qu'a un blocage identique, jamais a un blocage un
// peu pire. La moitie en plus laisse de quoi encaisser la variation ordinaire sans gonfler la
// latence pour rien.
export const TARGET_SAFETY = 1.5;

// Vitesse a laquelle le souvenir du pire blocage s'efface, en millisecondes de seuil par seconde.
//
// La montee est immediate et la descente est lente, et cette dissymetrie est voulue : se tromper en
// gardant trop de tampon coute de la latence, se tromper en n'en gardant pas assez coute une
// coupure. A cinq millisecondes par seconde, un seuil monte a 1200 ms revient a 500 ms en un peu
// plus de deux minutes de calme — assez lent pour ne pas retomber au premier repit d'un lien qui
// hoquette encore.
export const DECAY_MS_PER_SECOND = 5;

// La decroissance ne s'applique que lorsque la file a rejoint le seuil, et cette condition n'est pas
// un raffinement : sans elle le regulateur ment.
//
// Le seuil descend de `DECAY_MS_PER_SECOND` x `TARGET_SAFETY`, soit 7,5 ms par seconde. Le processeur
// audio, lui, ne peut resorber un exces qu'a `RATE_MAX`, soit 5 ms par seconde au maximum absolu, et
// bien moins tant que l'ecart reste dans la partie proportionnelle de sa pente. **Le seuil fuit donc
// plus vite que la lecture ne court**, et l'ecart entre les deux ne se referme jamais : il grandit.
//
// Le journal du 6 aout 2026 a 23h18 le montre sur trois minutes — seuil 2000 -> 900 pendant que le
// tampon ne descendait que de 2023 a 1641, un ecart passe de +23 a +741 ms. Le seuil affichait 900 ms
// quand l'auditeur en entendait 1641 : il ne decrivait plus rien.
//
// Attendre que la file ait rejoint le seuil fait descendre celui-ci au rythme que la lecture sait
// reellement tenir, par construction et sans aucune constante a accorder. La comparaison se fait a la
// zone morte du processeur audio, et c'est le bon point : a l'interieur, il ne corrige plus, donc la
// file est arrivee. Ces deux modules doivent partager cette valeur, d'ou l'import plutot qu'une
// seconde constante qui pourrait diverger.
//
// La porte n'est fermee que par le haut. Une file plus maigre que le seuil ne bloque rien : le seuil
// et elle se rapprochent alors, ce qui est exactement ce qu'on veut, et tout nouveau blocage le
// releve de toute facon aussitot.
export const DECAY_GATE = RATE_DEADBAND;

// Pas de quantification du seuil rendu.
//
// Sans lui, le seuil bougerait de quelques millisecondes a chaque paquet, et chaque mouvement
// ferait travailler le regulateur de vitesse du processeur audio pour un gain nul.
export const TARGET_STEP_MS = 50;

// Part dont le seuil augmente quand un manque de donnees survient malgre lui.
//
// Un manque de donnees est la preuve directe que le seuil courant etait trop court : la mesure des
// blocages ne l'avait pas vu venir, donc c'est ce constat-la qui doit decider, et non elle.
export const UNDERRUN_GROWTH = 1.25;

// Cette classe suit l'arrivee des paquets et rend le seuil de bufferisation a tenir.
export class BufferTarget {
  // Plancher demande par le profil de latence choisi dans le device.
  private floorMs: number;
  // Plus long blocage retenu, deja diminue de la duree nominale entre deux paquets. C'est la duree
  // de tampon que ce blocage aurait consommee.
  private observedMs = 0;
  private lastPacketAt: number | null = null;
  private lastDecayAt: number | null = null;
  // Dernier niveau de la file annonce par le processeur audio, ou `null` tant qu'aucun n'est arrive.
  // Il ne sert qu'a la porte de decroissance : le regulateur ne decide rien d'autre avec.
  private levelMs: number | null = null;

  constructor(floorMs = 400) {
    this.floorMs = floorMs;
  }

  // Cette methode repart de zero pour un nouveau direct, et prend son plancher.
  //
  // Le lien d'un direct n'apprend rien sur celui du suivant, et une reconnexion passe souvent par
  // un autre chemin reseau. Garder le souvenir du precedent ferait demarrer le nouveau avec une
  // latence qu'il n'a peut-etre aucune raison de payer.
  reset(floorMs: number): void {
    this.floorMs = floorMs;
    this.observedMs = 0;
    this.lastPacketAt = null;
    this.lastDecayAt = null;
    this.levelMs = null;
  }

  // Cette methode enregistre le niveau de la file, qui ouvre ou ferme la porte de decroissance.
  noteLevel(availableMs: number): void {
    this.levelMs = availableMs;
  }

  // Cette methode enregistre l'arrivee d'un paquet.
  //
  // L'ecart avec le paquet precedent est la seule mesure qui compte ici. En regime normal il vaut la
  // duree d'une trame, et le tampon n'en souffre pas ; tout ce qui depasse est du temps pendant
  // lequel la file s'est videe sans etre remplie, donc exactement la duree de tampon qu'il fallait
  // avoir.
  notePacket(at: number): void {
    const previous = this.lastPacketAt;
    this.lastPacketAt = at;
    this.decayTo(at);

    if (previous === null) {
      return;
    }

    const drained = at - previous - FRAME_MS;

    if (drained > this.observedMs) {
      this.observedMs = Math.min(drained, MAX_TARGET_MS);
    }
  }

  // Cette methode enregistre un manque de donnees, qui prouve que le seuil courant etait trop court.
  noteUnderrun(at: number): void {
    this.decayTo(at);

    const grown = this.boundedTarget() * UNDERRUN_GROWTH;

    if (grown > this.observedMs) {
      this.observedMs = Math.min(grown, MAX_TARGET_MS);
    }
  }

  // Cette methode rend le seuil a tenir maintenant, arrondi a son pas.
  targetMs(at: number): number {
    this.decayTo(at);

    return Math.round(this.boundedTarget() / TARGET_STEP_MS) * TARGET_STEP_MS;
  }

  // Cette methode rend le seuil brut, sans arrondi et sans faire avancer le temps.
  //
  // Elle est separee de `targetMs` pour une raison precise : la porte de decroissance a besoin du
  // seuil, et `targetMs` declenche la decroissance. Les faire passer l'une par l'autre serait une
  // recursion.
  private boundedTarget(): number {
    const wanted = this.observedMs * TARGET_SAFETY;

    return Math.min(Math.max(wanted, this.floorMs), MAX_TARGET_MS);
  }

  // Cette methode rend le plus long blocage encore en memoire, pour le journal.
  get stallMs(): number {
    return Math.round(this.observedMs);
  }

  // Cette methode efface le souvenir du pire blocage au rythme du temps qui passe.
  //
  // L'horloge avance meme quand la porte est fermee, et c'est indispensable : garder le temps ecoule
  // pour plus tard ferait retomber tout le retard accumule d'un seul coup a la reouverture, soit
  // exactement la marche que ce module existe pour eviter.
  private decayTo(at: number): void {
    const previous = this.lastDecayAt;
    this.lastDecayAt = at;

    if (previous === null || at <= previous || this.levelIsBehind()) {
      return;
    }

    const faded = this.observedMs - ((at - previous) * DECAY_MS_PER_SECOND) / 1000;
    this.observedMs = Math.max(0, faded);
  }

  // Cette methode dit si la file est encore au-dessus du seuil, donc si baisser celui-ci ne ferait
  // que creuser un ecart que la lecture ne sait pas rattraper. Voir `DECAY_GATE`.
  private levelIsBehind(): boolean {
    if (this.levelMs === null) {
      return false;
    }

    return this.levelMs > this.boundedTarget() * (1 + DECAY_GATE);
  }
}
