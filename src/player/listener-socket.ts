import { readStreamState, type StreamState } from "./player-protocol.ts";

// Ce module tient la connexion WebSocket d'un auditeur. Il separe les messages JSON des paquets
// binaires, et il reconnecte tout seul apres une coupure. Il ne decode jamais l'audio : il transmet
// les octets recus tels quels.

// Cette suite est celle du publisher du bloc 6. La derniere valeur se repete : une coupure longue
// continue d'etre retentee toutes les trente secondes environ.
export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// Cet ecart etale les tentatives entre 80 % et 120 % du palier. Sans lui, tous les auditeurs d'un
// relais qui redemarre reviendraient a la meme seconde.
export const JITTER_RATIO = 0.2;

// Ce type regroupe ce que le socket annonce a son appelant.
export type ListenerSocketEvents = {
  onState: (state: StreamState) => void;
  onPacket: (packet: ArrayBuffer) => void;
  onConnectionLost: () => void;
};

// Ce type decrit les pieces remplacables, pour que les tests n'aient besoin ni de navigateur ni
// d'horloge reelle.
export type ListenerSocketDeps = {
  createSocket: (url: string) => WebSocket;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
  random: () => number;
};

// Cette fonction donne le delai avant la prochaine tentative de reconnexion.
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 0), BACKOFF_STEPS_MS.length - 1);
  const step = BACKOFF_STEPS_MS[index] ?? 30000;
  const factor = 1 - JITTER_RATIO + random() * JITTER_RATIO * 2;

  return Math.round(step * factor);
}

// Cette classe ouvre la connexion listener et la garde ouverte.
export class ListenerSocket {
  private url: string;
  private events: ListenerSocketEvents;
  private deps: ListenerSocketDeps;
  private socket: WebSocket | null = null;
  private retryTimer: number | null = null;
  private attempt = 0;
  private wanted = false;

  constructor(url: string, events: ListenerSocketEvents, deps: Partial<ListenerSocketDeps> = {}) {
    this.url = url;
    this.events = events;
    this.deps = {
      createSocket: deps.createSocket ?? ((target: string) => new WebSocket(target)),
      setTimer: deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as unknown as number),
      clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle)),
      random: deps.random ?? Math.random,
    };
  }

  // Cette methode dit si une connexion est actuellement ouverte.
  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  // Cette methode ouvre la connexion et la rouvre apres chaque coupure, jusqu'a `stop()`.
  start(): void {
    if (this.wanted) {
      return;
    }

    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  // Cette methode ferme la connexion et arrete les reconnexions.
  stop(): void {
    this.wanted = false;
    this.cancelRetry();
    this.closeSocket();
  }

  // Cette methode ouvre une connexion et branche ses evenements.
  private open(): void {
    let socket: WebSocket;

    try {
      socket = this.deps.createSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }

    // Les paquets audio arrivent en binaire. Sans cette ligne, le navigateur en ferait des `Blob`,
    // qui ne se lisent que de facon asynchrone et ne se transferent pas au worker.
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
    };

    socket.onmessage = (event: MessageEvent) => this.handleMessage(event.data);

    // Une coupure et une erreur menent au meme endroit : la connexion est perdue et une nouvelle
    // tentative est programmee. Le navigateur emet parfois les deux, d'ou la remise a zero du
    // socket avant tout traitement.
    socket.onerror = () => this.handleClose(socket);
    socket.onclose = () => this.handleClose(socket);
  }

  // Cette methode dirige un message vers l'etat ou vers l'audio.
  private handleMessage(data: unknown): void {
    if (typeof data === "string") {
      const state = readStreamState(data);

      if (state !== null) {
        this.events.onState(state);
      }

      return;
    }

    if (data instanceof ArrayBuffer) {
      this.events.onPacket(data);
    }
  }

  // Cette methode traite la perte de la connexion courante.
  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    this.socket = null;
    this.events.onConnectionLost();

    if (this.wanted) {
      this.scheduleRetry();
    }
  }

  // Cette methode programme la prochaine tentative.
  private scheduleRetry(): void {
    if (this.retryTimer !== null) {
      return;
    }

    const delay = backoffDelayMs(this.attempt, this.deps.random);
    this.attempt += 1;

    this.retryTimer = this.deps.setTimer(() => {
      this.retryTimer = null;

      if (this.wanted) {
        this.open();
      }
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      this.deps.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // Cette methode ferme le socket sans laisser ses evenements relancer une reconnexion.
  private closeSocket(): void {
    const socket = this.socket;

    if (socket === null) {
      return;
    }

    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    try {
      socket.close();
    } catch {
      // Une connexion deja fermee n'a plus rien a fermer.
    }
  }
}
