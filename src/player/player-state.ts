import type { LiveSession, StreamState } from "./player-protocol.ts";

// Ce module contient la machine d'etats du player, sans aucune dependance au navigateur. Il decide
// ce que la page affiche, si le decodeur doit remplir la file PCM, et si le processeur audio doit
// la consommer. Il ne touche jamais a un echantillon.

// Ces sept etats sont ceux demandes par la roadmap.
export type PlayerState =
  | "OFFLINE"
  | "READY"
  | "BUFFERING"
  | "PLAYING"
  | "REBUFFERING"
  | "PAUSED"
  | "ERROR";

// Ce type decrit ce que la machine demande au reste du moteur.
export type PlayerCommands = {
  // `accepting` dit au decodeur d'ecrire dans la file. Il est faux des que le son n'est pas
  // souhaite : les paquets recus sont alors jetes au lieu d'etre empiles.
  accepting: boolean;
  // `playing` dit au processeur audio de consommer la file. Il reste faux pendant la bufferisation,
  // sinon le processeur reviderait la file aussi vite qu'elle se remplit.
  playing: boolean;
  // Ce numero augmente chaque fois que le son en attente doit etre jete. Le moteur compare la
  // valeur recue a la derniere appliquee : il n'a donc besoin ni d'evenement ni de file d'ordres.
  flushId: number;
};

// Au-dela de cette marge au-dessus du seuil, la file contient du son que personne n'a consomme :
// le thread audio s'est arrete un moment. Un onglet mis en arriere-plan, un contexte suspendu par
// le systeme ou un peripherique de sortie qui disparait produisent tous le meme resultat.
//
// Sans cette limite, la lecture reprendrait sur ce son vieux de plusieurs secondes et l'auditeur
// resterait en retard sur le direct jusqu'a la fin, sans que rien ne le signale.
export const LATE_MARGIN_MS = 1000;

// Part du seuil qu'une rebufferisation doit reconstituer avant de rendre le son.
//
// Une rebufferisation attendait le seuil **complet**, et c'est ce qui la rendait chere. Le 11 aout
// 2026, seuil colle a son plafond de 2000 ms, chacune des quarante coupures a dure 2,3 s en moyenne :
// la file se remplit a environ 0,8 fois le temps reel, donc reconstituer deux secondes en coute plus
// de deux. Sur 41 minutes cela faisait 93 s de silence — 3,8 % du cours.
//
// Attendre la moitie divise l'attente par deux sans rouvrir la porte au va-et-vient que le seuil
// complet fermait : a la moitie de deux secondes, la file reste plus fournie que le seuil entier
// d'un profil court, et le regulateur de vitesse finit de la remonter pendant la lecture. Le
// plancher du profil borne le tout par le bas, parce que descendre sous la latence que l'auditeur a
// choisie n'aurait aucun sens.
export const RESUME_RATIO = 0.5;

// Un rattrapage apres un vrai decrochage arrive parfois par rafale, sur plusieurs rapports au lieu
// d'un seul bloc : un rapport correct peut se glisser entre deux rapports encore au-dessus de la
// marge. Repartir en lecture sur ce seul rapport la ferait aussitot rebufferiser au rapport suivant,
// et le journal montrerait REBUFFERING, PLAYING, REBUFFERING, PLAYING pour un seul incident. Deux
// rapports propres d'affilee suffisent a distinguer une rafale qui se calme d'une rafale qui continue.
export const RECOVERY_CONFIRM_REPORTS = 2;

// Cette confirmation s'allonge a chaque vidage de la meme rafale, et voici pourquoi.
//
// Une valeur fixe de deux rapports suppose une rafale courte. L'essai long de la nuit du 4 aout 2026
// a montre l'autre cas : au reveil, les paquets accumules pendant le gel du thread principal sont
// livres d'un coup, le decodeur les ecrit plus vite que le temps reel, et la file repasse au-dessus
// de la marge pendant deux secondes entieres. Le motif recu n'est pas une rafale unique mais une dent
// de scie — deux rapports trop pleins, deux rapports propres, et ainsi de suite. Deux rapports
// propres suffisaient a repartir, la dent suivante refaisait rebufferiser : quinze allers-retours
// pour un seul incident, la ou la fiche de validation n'en tolere qu'un.
//
// Exiger deux rapports propres de plus a chaque vidage rend la reprise impossible tant que la rafale
// insiste, et la laisse immediate quand elle ne se produit qu'une fois : le premier vidage demande
// toujours deux rapports, comme avant.
export const RECOVERY_CONFIRM_STEP = 2;

// Au-dela d'une seconde de rapports propres, la rafale est finie quelle qu'ait ete son insistance.
// Sans ce plafond, une rafale de trente vidages demanderait soixante rapports propres, soit deux
// secondes et demie de silence apres que tout est rentre dans l'ordre.
export const RECOVERY_CONFIRM_MAX_REPORTS = 25;

// Les trois constantes suivantes rejouent le meme principe pour les rebufferisations declenchees
// par une discontinuite (`discontinuity()`), pas par une derive (`reportLevel()`). Un lien
// descendant degrade produit des trous rapproches — c'est ce que le journal du 6 aout 2026 montre
// sous un throttle 3G, plusieurs cycles REBUFFERING/PLAYING en une poignee de secondes — et une
// reprise a deux rapports fixes a chaque fois laisse le player flapper au lieu d'attendre que la
// rafale de trous se calme.
//
// Ce compteur reste volontairement separe de celui de la derive (`driftFlushes`) : les deux causes
// ne se ressemblent pas. Un vidage de derive signale un backlog physique — le thread audio s'est
// arrete, la file a grossi sans etre consommee — et sa confirmation attend que ce backlog ait eu le
// temps de se resorber, ce qui justifie une escalade longue (jusqu'a 25 rapports). Une discontinuite
// ne laisse rien de tel derriere elle : le trou est deja comble ou deja rebufferise, rien ne dit
// qu'un vidage de derive en cours ait une cause commune avec elle, et partager le meme compteur
// ferait payer a une discontinuite isolee la confirmation deja allongee par une rafale de derive
// sans rapport. D'ou des constantes propres, avec un plafond bien plus bas : une discontinuite
// comblee ne devrait normalement produire aucun manque perceptible, la confirmation n'a donc pas a
// s'etirer aussi longtemps qu'une derive reelle.
export const GAP_RECOVERY_CONFIRM_REPORTS = 2;
export const GAP_RECOVERY_CONFIRM_STEP = 2;
export const GAP_RECOVERY_CONFIRM_MAX_REPORTS = 6;

// Ce type regroupe tout ce que la page a besoin de connaitre.
export type PlayerStatus = {
  state: PlayerState;
  session: LiveSession | null;
  errorReason: string | null;
} & PlayerCommands;

// Cette classe applique les transitions du player. Un seul appelant la pilote, un seul rappel en
// sort : la page ne lit jamais d'etat intermediaire.
export class PlayerStateMachine {
  private state: PlayerState = "OFFLINE";
  private session: LiveSession | null = null;
  private errorReason: string | null = null;
  // Cette valeur retient la demande de l'auditeur, pas l'etat courant. Une coupure reseau ne
  // l'annule pas : seul un clic sur Pause l'annule.
  private wantsSound = false;
  private lastUnderruns = 0;
  private flushId = 0;
  // Ces trois champs suivent une reprise en cours apres un vidage par derive : `recoveringFromDrift`
  // dit qu'un vidage a eu lieu et qu'une reprise doit encore se confirmer, `stableReports` compte les
  // rapports propres recus d'affilee depuis, et `driftFlushes` compte les vidages de la rafale en
  // cours — c'est lui qui allonge la confirmation quand la rafale insiste. Un manque de donnees
  // ordinaire ne les touche pas : sa reprise reste immediate, comme avant.
  private recoveringFromDrift = false;
  private stableReports = 0;
  private driftFlushes = 0;
  // Ces trois champs rejouent les memes trois roles pour la rafale de discontinuites, en parallele
  // et independamment de la rafale de derive ci-dessus : voir `GAP_RECOVERY_CONFIRM_STEP`.
  private recoveringFromGap = false;
  private gapStableReports = 0;
  private gapFlushes = 0;
  // Seuil decide par le regulateur de tampon, ou `null` tant qu'il n'a rien dit. Le profil de la
  // session en est alors le plancher, jamais l'inverse.
  private adaptiveTargetMs: number | null = null;
  private onChange: (status: PlayerStatus) => void;

  constructor(onChange: (status: PlayerStatus) => void = () => {}) {
    this.onChange = onChange;
  }

  // Cette methode rend l'etat complet, tel que la page l'affiche.
  status(): PlayerStatus {
    return {
      state: this.state,
      session: this.session,
      errorReason: this.errorReason,
      accepting: this.state === "BUFFERING" || this.state === "PLAYING" || this.state === "REBUFFERING",
      playing: this.state === "PLAYING",
      flushId: this.flushId,
    };
  }

  // Cette methode applique l'etat annonce par le relais.
  setStream(stream: StreamState): void {
    // Une panne n'arrete pas l'ecoute du relais. L'etat reste `ERROR` jusqu'a `recover()`, mais la
    // session annoncee est enregistree quand meme : le relais n'annonce un direct qu'au moment ou il
    // change, et un moteur en panne pendant ce changement repartirait sinon sur l'ancienne session,
    // dont le decodeur refuserait chaque paquet, sans qu'aucun message ne l'annonce.
    if (this.state === "ERROR") {
      this.session = stream.live ? stream.session : null;
      return;
    }

    if (!stream.live || stream.session === null) {
      this.session = null;
      this.lastUnderruns = 0;
      this.resetDriftRecovery();
      this.resetGapRecovery();
      this.moveTo("OFFLINE");
      return;
    }

    const known = this.session;
    this.session = stream.session;

    // Une session identique ne change rien : le relais renvoie le meme etat a chaque nouvel
    // auditeur, et une reception en double ne doit pas interrompre une lecture en cours.
    if (known !== null && known.sessionId === stream.session.sessionId && this.state !== "OFFLINE") {
      return;
    }

    this.lastUnderruns = 0;
    this.resetDriftRecovery();
    this.resetGapRecovery();

    if (this.state === "PAUSED") {
      return;
    }

    this.moveTo(this.wantsSound ? "BUFFERING" : "READY");
  }

  // Cette methode traite la perte de la connexion au relais.
  connectionLost(): void {
    // Meme raison que dans `setStream` : l'etat de panne ne bouge pas, mais la session disparait.
    // Une reprise doit repartir de ce que le relais annonce maintenant, pas d'un direct termine.
    if (this.state === "ERROR") {
      this.session = null;
      return;
    }

    this.session = null;
    this.lastUnderruns = 0;
    this.resetDriftRecovery();
    this.resetGapRecovery();
    this.moveTo("OFFLINE");
  }

  // Cette methode traite le clic sur Play.
  play(): void {
    if (this.state === "ERROR") {
      return;
    }

    this.wantsSound = true;

    if (this.session === null) {
      this.moveTo("OFFLINE");
      return;
    }

    if (this.state !== "PLAYING") {
      this.moveTo("BUFFERING");
    }
  }

  // Cette methode traite le clic sur Pause. Le son s'arrete et les paquets recus sont jetes :
  // reprendre repartira du direct, pas d'un retard egal a la duree de la pause.
  pause(): void {
    if (this.state === "ERROR") {
      return;
    }

    this.wantsSound = false;
    this.moveTo(this.session === null ? "OFFLINE" : "PAUSED");
  }

  // Cette methode recoit le niveau de la file PCM mesure par le processeur audio.
  reportLevel(availableMs: number, underruns: number): void {
    const filling = this.state === "BUFFERING" || this.state === "REBUFFERING" || this.state === "PLAYING";

    if (!filling) {
      this.lastUnderruns = underruns;
      return;
    }

    // Le compteur precedent est retenu avant d'etre remplace : c'est sa comparaison avec le nouveau
    // qui dit si la file s'est videe depuis le dernier rapport.
    const previousUnderruns = this.lastUnderruns;
    this.lastUnderruns = underruns;
    const targetBufferMs = this.targetBufferMs();

    // La file a grossi bien au-dela du seuil : le thread audio ne l'a pas consommee pendant un
    // moment, donc le son qu'elle contient est vieux d'autant. Il est jete, et la lecture repart du
    // direct.
    //
    // Cette verification vient avant toute decision de jouer, et vaut pour les trois etats ou la
    // file se remplit. Bufferiser sur une file deja trop pleine et passer quand meme en lecture
    // ferait entendre ce son ancien pendant quarante millisecondes, jusqu'au rapport suivant qui
    // conclurait au retard et rebufferiserait : la page enchaine alors REBUFFERING et PLAYING deux
    // fois de suite au lieu de repartir proprement une seule fois.
    if (availableMs > targetBufferMs + LATE_MARGIN_MS) {
      this.flushId += 1;
      // Le rattrapage qui suivra devra se confirmer sur plusieurs rapports : celui-ci prouve qu'une
      // rafale est en cours, et un rapport correct isole n'y change rien tant qu'elle continue.
      // Chaque vidage supplementaire allonge cette confirmation, donc une rafale qui insiste ne peut
      // plus glisser une reprise entre deux de ses dents.
      this.recoveringFromDrift = true;
      this.stableReports = 0;
      this.driftFlushes += 1;
      // Un vidage de derive est un vidage plus large que celui d'une discontinuite : il jette toute
      // la file, pas seulement un trou comble. Une rafale de discontinuites en cours n'a plus de sens
      // une fois ce vidage fait, donc elle n'a pas a allonger la confirmation qui suit.
      this.resetGapRecovery();

      if (this.state === "PLAYING") {
        this.moveTo("REBUFFERING");
        return;
      }

      // La bufferisation continue : l'etat ne change pas, seul l'ordre de vidage doit partir.
      this.emit();
      return;
    }

    if (this.state !== "PLAYING") {
      // La reprise depuis REBUFFERING demande un retour net a un niveau de lecture, pas un simple
      // rebond autour du seuil. Sinon un blocage bref suffit a faire osciller le player entre
      // REBUFFERING et PLAYING. Ce niveau n'est plus le seuil entier : voir `RESUME_RATIO`.
      if (availableMs >= this.resumeBufferMs()) {
        if (!this.recoveringFromDrift && !this.recoveringFromGap) {
          this.moveTo("PLAYING");
          return;
        }

        // Une reprise qui suit un vidage par derive ou par discontinuite doit se confirmer sur
        // plusieurs rapports propres d'affilee : le rattrapage peut arriver par rafale, et un seul
        // rapport correct glisse parfois entre deux rapports encore trop pleins. Le rendre a
        // `PLAYING` tout de suite ferait repartir la lecture juste avant que la rafale ne la fasse
        // rebufferiser de nouveau. Les deux rafales se confirment chacune a son rythme : rien
        // n'empeche qu'elles soient toutes deux en cours a la fois.
        let confirme = true;

        if (this.recoveringFromDrift) {
          this.stableReports += 1;

          if (this.stableReports < this.requiredStableReports()) {
            confirme = false;
          }
        }

        if (this.recoveringFromGap) {
          this.gapStableReports += 1;

          if (this.gapStableReports < this.requiredGapStableReports()) {
            confirme = false;
          }
        }

        if (confirme) {
          this.resetDriftRecovery();
          this.resetGapRecovery();
          this.moveTo("PLAYING");
        }
      } else {
        this.stableReports = 0;
        this.gapStableReports = 0;
      }

      return;
    }

    // Un manque de donnees ne doit pas faire rebufferiser tout seul si la file reste au-dessus du
    // seuil. Un underrun bref, suivi d'un retour rapide a la normale, ne doit pas faire basculer le
    // player en boucle REBUFFERING/PLAYING pendant des minutes. On ne rebufferise qu'en cas de
    // manque durable, c'est-a-dire quand la baisse de la file depasse une petite marge autour du
    // seuil de lecture.
    if (underruns > previousUnderruns) {
      const rebufferingThresholdMs = targetBufferMs - Math.max(50, Math.round(targetBufferMs * 0.2));

      if (availableMs < rebufferingThresholdMs) {
        this.moveTo("REBUFFERING");
      }
    }
  }

  // Cette methode traite une discontinuite signalee par le decodeur : bit du device ou trou dans
  // les numeros de sequence, trop grand pour etre comble. Le PCM en attente est deja jete par le
  // decodeur, donc le player repasse en bufferisation.
  //
  // Elle agit aussi pendant une REBUFFERING deja en cours, pas seulement depuis PLAYING : c'est ce
  // qui permet a une rafale de trous rapproches d'allonger sa propre confirmation, exactement comme
  // le fait une rafale de derive dans `reportLevel`. `moveTo` ne fait rien de plus qu'emettre si
  // l'etat ne change pas, donc rappeler REBUFFERING depuis REBUFFERING est sans effet visible : seul
  // le compteur de rafale avance.
  discontinuity(): void {
    if (this.state !== "PLAYING" && this.state !== "REBUFFERING") {
      return;
    }

    // Une discontinuite est une cause differente d'une derive : un vidage de derive en cours n'a
    // plus de sens une fois que le decodeur a lui-meme jete son etat sur un trou trop grand.
    this.resetDriftRecovery();
    this.recoveringFromGap = true;
    this.gapStableReports = 0;
    this.gapFlushes += 1;
    this.moveTo("REBUFFERING");
  }

  // Cette methode declare une panne. Aucune transition ordinaire n'en sort : seul `recover()` le
  // fait, et il n'est appele que par un nouveau clic sur Play.
  fail(reason: string): void {
    this.errorReason = reason;
    this.moveTo("ERROR");
  }

  // Cette methode sort de l'erreur pour laisser une seconde chance.
  //
  // Une page bloquee sur `ERROR` jusqu'au rechargement est une mauvaise reponse a une panne
  // passagere : un contexte audio refuse par le systeme, un peripherique de sortie change en cours
  // de route, un WebAssembly qui n'a pas voulu se compiler du premier coup. L'appelant rebatit le
  // contexte audio avant d'appeler cette methode, donc le moteur repart de ce que le relais annonce.
  recover(): void {
    if (this.state !== "ERROR") {
      return;
    }

    // Le vidage n'est pas demande ici : l'appelant a jete la file avec le reste du contexte audio.
    this.errorReason = null;
    this.lastUnderruns = 0;
    this.resetDriftRecovery();
    this.resetGapRecovery();
    this.moveTo(this.session === null ? "OFFLINE" : "READY");
  }

  // Cette methode rend le nombre de rapports propres d'affilee exiges avant de reprendre la lecture.
  //
  // Il vaut deux rapports pour un vidage isole — le cas ordinaire, inchange — et deux de plus par
  // vidage supplementaire de la meme rafale, jusqu'au plafond d'une seconde.
  private requiredStableReports(): number {
    const required = RECOVERY_CONFIRM_REPORTS + RECOVERY_CONFIRM_STEP * (this.driftFlushes - 1);

    return Math.min(Math.max(required, RECOVERY_CONFIRM_REPORTS), RECOVERY_CONFIRM_MAX_REPORTS);
  }

  // Cette methode oublie la rafale de derive en cours. Elle est appelee des qu'une reprise est
  // confirmee, et a chaque evenement qui rend la rafale precedente sans objet : nouvelle session,
  // coupure, vidage de derive posterieur, sortie de panne.
  private resetDriftRecovery(): void {
    this.recoveringFromDrift = false;
    this.stableReports = 0;
    this.driftFlushes = 0;
  }

  // Cette methode rend le nombre de rapports propres d'affilee exiges avant de reprendre la lecture
  // apres une rafale de discontinuites. Meme forme que `requiredStableReports`, plafond plus bas :
  // voir `GAP_RECOVERY_CONFIRM_MAX_REPORTS`.
  private requiredGapStableReports(): number {
    const required = GAP_RECOVERY_CONFIRM_REPORTS + GAP_RECOVERY_CONFIRM_STEP * (this.gapFlushes - 1);

    return Math.min(Math.max(required, GAP_RECOVERY_CONFIRM_REPORTS), GAP_RECOVERY_CONFIRM_MAX_REPORTS);
  }

  // Cette methode oublie la rafale de discontinuites en cours, aux memes moments que
  // `resetDriftRecovery` oublie celle de derive.
  private resetGapRecovery(): void {
    this.recoveringFromGap = false;
    this.gapStableReports = 0;
    this.gapFlushes = 0;
  }

  // Cette methode rend le seuil de bufferisation en vigueur.
  //
  // Il vient du regulateur quand celui-ci a parle, et du profil de la session sinon. La machine ne
  // le calcule pas elle-meme : elle raisonne sur des etats, pas sur des mesures de reseau.
  targetBufferMs(): number {
    if (this.adaptiveTargetMs !== null) {
      return this.adaptiveTargetMs;
    }

    return this.session === null ? 400 : this.session.targetBufferMs;
  }

  // Cette methode rend le niveau de file qu'une rebufferisation doit atteindre pour rendre le son.
  //
  // Elle est bornee par le plancher du profil : la latence choisie par l'auditeur reste le minimum,
  // et un seuil adaptatif deja au plancher se comporte donc exactement comme avant.
  resumeBufferMs(): number {
    const target = this.targetBufferMs();
    const floorMs = this.session === null ? 400 : this.session.targetBufferMs;

    return Math.min(target, Math.max(floorMs, Math.round(target * RESUME_RATIO)));
  }

  // Cette methode installe le seuil decide par le regulateur (`buffer-target.ts`).
  //
  // Elle ne declenche aucune transition. Le seuil sert de comparaison dans `reportLevel`, qui sera
  // rappelee au prochain releve du processeur audio, soit dans moins de quarante millisecondes :
  // changer d'etat ici sur une mesure vieille d'un tour ne ferait qu'ajouter du bruit.
  setTargetBufferMs(targetMs: number | null): void {
    this.adaptiveTargetMs = targetMs;
  }

  // Cette methode change l'etat et previent une seule fois.
  private moveTo(next: PlayerState): void {
    if (this.state === next) {
      return;
    }

    this.state = next;
    this.emit();
  }

  // Cette methode transmet l'etat courant sans en changer.
  //
  // Elle sert au vidage demande pendant une bufferisation : l'ordre voyage dans le meme paquet que
  // l'etat, donc un ordre qui ne s'accompagne d'aucun changement d'etat n'atteindrait jamais le
  // decodeur sans cet appel.
  private emit(): void {
    this.onChange(this.status());
  }
}
