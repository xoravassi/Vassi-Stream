import { WebSocket } from "ws";

import { buildStreamState, type SessionConfig } from "./protocol.ts";
import type { LogFields } from "./log.ts";

// Ce module tient la liste des auditeurs et leur envoie l'etat puis les paquets audio.
// Il ne lit jamais le contenu des paquets : il rediffuse les memes octets.

// Au-dela de ce nombre d'octets en attente, la sortie du listener est en retard d'environ deux
// secondes en qualite Studio. Les paquets suivants sont abandonnes plutot qu'empiles : l'audio
// ancien n'a plus d'interet dans un direct.
export const DROP_BYTES = 65536;
// Au-dela de cette limite, environ seize secondes d'audio, la connexion est consideree bloquee.
// Elle est coupee : elle ne rattrapera pas son retard et sa file grandirait sans fin.
export const CLOSE_BYTES = 524288;
// Un listener qui ne repond pas a deux pings de suite est considere disparu.
export const MISSED_PONG_LIMIT = 2;

// Ce code de fermeture WebSocket signale que le serveur s'arrete.
const CLOSE_GOING_AWAY = 1001;
// Ce code de fermeture WebSocket signale une donnee que le serveur n'accepte pas.
const CLOSE_UNSUPPORTED_DATA = 1003;
// Ce code de fermeture WebSocket signale un serveur temporairement plein.
const CLOSE_TRY_AGAIN_LATER = 1013;

// Ce type decrit ce que le hub retient pour chaque auditeur connecte.
type Listener = {
  socket: WebSocket;
  missedPongs: number;
};

// Ce type regroupe les compteurs affiches par la route de sante.
export type ListenerStats = {
  accepted: number;
  refused: number;
  closedSlow: number;
  closedSilent: number;
  framesDropped: number;
  framesSent: number;
};

// Cette classe garde les auditeurs, leur envoie l'etat courant et diffuse les paquets audio.
export class ListenerHub {
  readonly stats: ListenerStats = {
    accepted: 0,
    refused: 0,
    closedSlow: 0,
    closedSilent: 0,
    framesDropped: 0,
    framesSent: 0,
  };

  private listeners = new Map<WebSocket, Listener>();
  private stateMessage = buildStreamState(null);
  private onEvent: (event: string, fields?: LogFields) => void;
  private maxListeners: number;

  constructor(options: {
    maxListeners: number;
    onEvent?: (event: string, fields?: LogFields) => void;
  }) {
    this.maxListeners = options.maxListeners;
    this.onEvent = options.onEvent ?? (() => {});
  }

  // Cette methode donne le nombre d'auditeurs connectes.
  get size(): number {
    return this.listeners.size;
  }

  // Cette methode dit si un auditeur de plus peut etre accepte.
  get hasRoom(): boolean {
    return this.listeners.size < this.maxListeners;
  }

  // Cette methode compte un auditeur refuse faute de place. Le refus lui-meme est prononce avant
  // l'ouverture de la connexion WebSocket, par une reponse HTTP du serveur.
  countRefused(): void {
    this.stats.refused += 1;
  }

  // Cette methode accepte un auditeur : elle lui envoie l'etat courant avant de l'inscrire dans la
  // liste de diffusion. Cet ordre garantit qu'aucun paquet audio n'arrive avant son `stream_state`.
  add(socket: WebSocket): void {
    // La place est deja verifiee avant l'ouverture de la connexion, mais la limite est verifiee une
    // seconde fois ici : c'est cette liste qui la porte, donc c'est ici qu'elle doit tenir.
    if (!this.hasRoom) {
      this.stats.refused += 1;
      this.closeListener(socket, CLOSE_TRY_AGAIN_LATER, "too_many_listeners");
      return;
    }

    const listener: Listener = { socket, missedPongs: 0 };

    socket.on("close", () => this.remove(socket));
    socket.on("error", () => this.drop(socket));
    // Un signe de vie quelconque prouve que la connexion repond encore.
    socket.on("pong", () => this.markAlive(listener));
    socket.on("ping", () => this.markAlive(listener));
    // La page `/session` n'envoie rien. Une connexion qui parle ne suit pas le protocole.
    socket.on("message", () => {
      this.closeListener(socket, CLOSE_UNSUPPORTED_DATA, "listener_message_refuse");
    });

    this.send(socket, this.stateMessage, false);

    // Une connexion partie pendant cet envoi n'entre pas dans la liste de diffusion : l'inscrire
    // ferait croire a un auditeur de plus jusqu'a l'arrivee de son evenement de fermeture.
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.listeners.set(socket, listener);
    this.stats.accepted += 1;
    this.onEvent("listener_connected", { listeners: this.listeners.size });
  }

  // Cette methode annonce une nouvelle session ou la fin du direct a tous les auditeurs.
  // Elle memorise l'etat : un auditeur qui arrive ensuite recoit exactement le meme message.
  setSession(session: SessionConfig | null): void {
    this.stateMessage = buildStreamState(session);

    // La liste est copiee avant l'envoi : une erreur de socket retire son auditeur pendant la
    // boucle, et la boucle ne doit pas dependre de ce que fait la liste sous elle.
    for (const listener of [...this.listeners.values()]) {
      this.send(listener.socket, this.stateMessage, false);
    }
  }

  // Cette methode diffuse un paquet audio deja valide, sans en modifier un seul octet.
  broadcast(packet: Buffer): void {
    for (const listener of [...this.listeners.values()]) {
      const socket = listener.socket;

      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Une file d'envoi bloquee ne se videra plus : la connexion est coupee tout de suite.
      if (socket.bufferedAmount > CLOSE_BYTES) {
        this.stats.closedSlow += 1;
        this.onEvent("listener_closed_slow", { bufferedAmount: socket.bufferedAmount });
        this.drop(socket);
        continue;
      }

      // Une file d'envoi en retard laisse passer le paquet suivant plutot que d'empiler l'ancien.
      if (socket.bufferedAmount > DROP_BYTES) {
        this.stats.framesDropped += 1;
        continue;
      }

      this.send(socket, packet, true);
      this.stats.framesSent += 1;
    }
  }

  // Cette methode envoie un ping a chaque auditeur et coupe ceux qui ne repondent plus.
  // Elle detecte les connexions que le systeme croit encore ouvertes, par exemple apres la
  // disparition brutale d'un reseau mobile.
  pingRound(): void {
    for (const listener of [...this.listeners.values()]) {
      if (listener.missedPongs >= MISSED_PONG_LIMIT) {
        this.stats.closedSilent += 1;
        this.onEvent("listener_closed_silent");
        this.drop(listener.socket);
        continue;
      }

      listener.missedPongs += 1;

      try {
        listener.socket.ping();
      } catch {
        this.drop(listener.socket);
      }
    }
  }

  // Cette methode ferme proprement tous les auditeurs, par exemple a l'arret du relais.
  closeAll(): void {
    for (const listener of [...this.listeners.values()]) {
      this.closeListener(listener.socket, CLOSE_GOING_AWAY, "relais_arrete");
    }

    this.listeners.clear();
  }

  // Cette methode remet a zero le compte de pings sans reponse.
  private markAlive(listener: Listener): void {
    listener.missedPongs = 0;
  }

  // Cette methode retire un auditeur de la liste de diffusion.
  private remove(socket: WebSocket): void {
    if (this.listeners.delete(socket)) {
      this.onEvent("listener_closed", { listeners: this.listeners.size });
    }
  }

  // Cette methode coupe une connexion sans attendre la fin de sa file d'envoi.
  private drop(socket: WebSocket): void {
    this.listeners.delete(socket);

    try {
      socket.terminate();
    } catch {
      // Une connexion deja fermee n'a plus rien a couper.
    }
  }

  // Cette methode ferme une connexion en annoncant la raison, puis la retire de la liste.
  private closeListener(socket: WebSocket, code: number, reason: string): void {
    this.listeners.delete(socket);

    try {
      socket.close(code, reason);
    } catch {
      // Une connexion deja fermee n'a plus rien a annoncer.
    }
  }

  // Cette methode envoie sans jamais laisser une erreur de socket arreter le relais.
  private send(socket: WebSocket, data: string | Buffer, binary: boolean): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(data, { binary }, () => {});
    } catch {
      this.drop(socket);
    }
  }
}
