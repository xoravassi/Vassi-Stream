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
};

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
    };
  }

  // Cette methode applique l'etat annonce par le relais.
  setStream(stream: StreamState): void {
    if (this.state === "ERROR") {
      return;
    }

    if (!stream.live || stream.session === null) {
      this.session = null;
      this.lastUnderruns = 0;
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

    if (this.state === "PAUSED") {
      return;
    }

    this.moveTo(this.wantsSound ? "BUFFERING" : "READY");
  }

  // Cette methode traite la perte de la connexion au relais.
  connectionLost(): void {
    if (this.state === "ERROR") {
      return;
    }

    this.session = null;
    this.lastUnderruns = 0;
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
    if (this.state === "BUFFERING" || this.state === "REBUFFERING") {
      this.lastUnderruns = underruns;

      if (availableMs >= this.targetBufferMs()) {
        this.moveTo("PLAYING");
      }

      return;
    }

    if (this.state !== "PLAYING") {
      this.lastUnderruns = underruns;
      return;
    }

    // Un manque de donnees signifie que le processeur audio a du produire du silence. Le player
    // remplit de nouveau la file avant de reprendre, au lieu de laisser le son hacher.
    if (underruns > this.lastUnderruns) {
      this.lastUnderruns = underruns;
      this.moveTo("REBUFFERING");
    }
  }

  // Cette methode traite une discontinuite signalee par le decodeur : bit du device ou trou dans
  // les numeros de sequence. Le PCM en attente est deja jete par le decodeur, donc le player
  // repasse en bufferisation.
  discontinuity(): void {
    if (this.state === "PLAYING") {
      this.moveTo("REBUFFERING");
    }
  }

  // Cette methode declare une panne definitive. Seul un nouveau demarrage en sort.
  fail(reason: string): void {
    this.errorReason = reason;
    this.moveTo("ERROR");
  }

  // Cette methode rend le seuil de bufferisation de la session courante.
  targetBufferMs(): number {
    return this.session === null ? 400 : this.session.targetBufferMs;
  }

  // Cette methode change l'etat et previent une seule fois.
  private moveTo(next: PlayerState): void {
    if (this.state === next) {
      return;
    }

    this.state = next;
    this.onChange(this.status());
  }
}
