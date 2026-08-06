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

    const grown = this.targetMs(at) * UNDERRUN_GROWTH;

    if (grown > this.observedMs) {
      this.observedMs = Math.min(grown, MAX_TARGET_MS);
    }
  }

  // Cette methode rend le seuil a tenir maintenant, arrondi a son pas.
  targetMs(at: number): number {
    this.decayTo(at);

    const wanted = this.observedMs * TARGET_SAFETY;
    const bounded = Math.min(Math.max(wanted, this.floorMs), MAX_TARGET_MS);

    return Math.round(bounded / TARGET_STEP_MS) * TARGET_STEP_MS;
  }

  // Cette methode rend le plus long blocage encore en memoire, pour le journal.
  get stallMs(): number {
    return Math.round(this.observedMs);
  }

  // Cette methode efface le souvenir du pire blocage au rythme du temps qui passe.
  private decayTo(at: number): void {
    const previous = this.lastDecayAt;
    this.lastDecayAt = at;

    if (previous === null || at <= previous) {
      return;
    }

    const faded = this.observedMs - ((at - previous) * DECAY_MS_PER_SECOND) / 1000;
    this.observedMs = Math.max(0, faded);
  }
}
