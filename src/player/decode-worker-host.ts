import type { DecoderStats } from "./decode-worker.d.ts";

// Ce module tient le worker de decodage depuis le thread principal : il le cree, attend que le
// WebAssembly Opus soit compile, lui transmet les ordres et le detruit.
//
// Il garde aussi la memoire des ordres deja transmis. Les deux vont ensemble : un worker neuf ne
// connait ni la session ni les ordres precedents, donc cette memoire doit disparaitre avec lui.

// Ce type decrit la facon dont les echantillons decodes rejoignent le processeur audio : par une
// memoire partagee, ou par un port transfere.
export type WorkerSetup = { buffer: ArrayBufferLike; capacityFrames: number } | { port: MessagePort };

// Ce type decrit ce que le worker signale a son appelant.
export type DecodeWorkerEvents = {
  // Une discontinuite comblee sur place porte `recovered: true` : la lecture n'a pas ete
  // interrompue, et seul le diagnostic a besoin de le savoir.
  onDiscontinuity: (note: { reason: string; missingMs: number; recovered: boolean }) => void;
  onRefusal: (reason: string) => void;
  onStats: (stats: DecoderStats) => void;
  onFailure: (reason: string) => void;
};

export class DecodeWorkerHost {
  private events: DecodeWorkerEvents;
  private worker: Worker | null = null;

  // Ces valeurs sont les derniers ordres reellement transmis. Un ordre inchange n'est pas renvoye.
  private lastSessionId = 0;
  private lastAccepting = false;
  private lastFlushId = 0;

  constructor(events: DecodeWorkerEvents) {
    this.events = events;
  }

  // Cette methode dit si le worker existe et a fini de demarrer.
  get running(): boolean {
    return this.worker !== null;
  }

  // Cette methode cree le worker et rend la main quand le decodeur Opus est pret. Un echec de
  // compilation ou un worker mort-ne rejettent la promesse.
  //
  // Le worker n'est pas cree a partir d'une adresse mais par une fabrique fournie par l'appelant.
  // La raison est pratique : le decodeur importe `opus-decoder`, un nom de paquet que le navigateur
  // ne sait pas resoudre seul. C'est l'outil de construction du site qui sait le faire, et il ne le
  // fait que s'il voit lui-meme la creation du worker. Une adresse le priverait de cette occasion.
  async start(createWorker: () => Worker, setup: WorkerSetup): Promise<void> {
    const worker = createWorker();
    this.worker = worker;

    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as { type: string; reason?: string };

        if (message.type === "ready") {
          resolve();
          return;
        }

        if (message.type === "error") {
          reject(new Error(message.reason ?? "opus_start_failed"));
        }
      };

      worker.onerror = () => reject(new Error("worker_failed"));
    });

    if ("port" in setup) {
      worker.postMessage({ type: "configure", port: setup.port }, [setup.port]);
    } else {
      worker.postMessage({ type: "configure", buffer: setup.buffer, capacityFrames: setup.capacityFrames });
    }

    await ready;

    // Ces deux branchements remplacent ceux du demarrage. La promesse ci-dessus est resolue, donc
    // son `reject` ne declenche plus rien : sans eux, un worker qui meurt pendant le direct ne
    // dirait rien du tout, et la page resterait en lecture sans le moindre son.
    worker.onmessage = (event: MessageEvent) => this.handleMessage(event);
    worker.onerror = () => this.events.onFailure("worker_failed");

    this.reportEmptyStats();
  }

  // Cette methode detruit le worker et oublie les ordres deja transmis.
  stop(): void {
    this.worker?.postMessage({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;

    this.lastSessionId = 0;
    this.lastAccepting = false;
    this.reportEmptyStats();
  }

  // Cette methode remet a zero les compteurs tenus par l'appelant.
  //
  // Un worker neuf compte a partir de zero, et il n'annonce ses compteurs qu'une fois par seconde.
  // Sans cette remise a zero, l'appelant garderait entre-temps ceux du worker precedent : la page
  // afficherait des frames decodees par un worker mort, et la regle « des paquets acceptes mais rien
  // de decode » ne pourrait plus jamais se declencher apres un redemarrage.
  private reportEmptyStats(): void {
    this.events.onStats({
      accepted: 0,
      decoded: 0,
      refused: 0,
      discontinuities: 0,
      flushes: 0,
      concealedMs: 0,
      lastRefusal: null,
    });
  }

  // Cette methode transmet un paquet sans le lire. Le tampon est transfere : le thread principal ne
  // recopie aucun octet audio.
  sendPacket(packet: ArrayBuffer): void {
    this.worker?.postMessage({ type: "packet", packet }, [packet]);
  }

  // Cette methode previent le worker d'un changement de session.
  //
  // La connexion s'ouvre avant le premier clic sur Play, donc une session est deja connue quand le
  // worker naît. Si l'appelant notait la session sans pouvoir la transmettre, le worker garderait la
  // session zero, refuserait chaque paquet pour session etrangere, et aucun son ne sortirait.
  setSession(sessionId: number): void {
    if (this.worker === null || sessionId === this.lastSessionId) {
      return;
    }

    this.lastSessionId = sessionId;
    this.worker.postMessage({ type: "session", sessionId });
  }

  // Cette methode dit au decodeur de remplir la file, ou d'abandonner ce qu'il recoit.
  setAccepting(accepting: boolean): void {
    if (this.worker === null || accepting === this.lastAccepting) {
      return;
    }

    this.lastAccepting = accepting;
    this.worker.postMessage({ type: "accepting", accepting });
  }

  // Cette methode jette le son en attente quand le numero de vidage a change. Comparer un numero
  // plutot qu'attendre un evenement rend l'ordre insensible a une perte ou a un doublon.
  applyFlush(flushId: number): void {
    if (this.worker === null || flushId === this.lastFlushId) {
      return;
    }

    this.lastFlushId = flushId;
    this.worker.postMessage({ type: "flush" });
  }

  // Cette methode traite ce que le worker signale pendant le direct.
  private handleMessage(event: MessageEvent): void {
    const message = event.data as {
      type: string;
      reason?: string;
      missingMs?: number;
      recovered?: boolean;
    } & Partial<DecoderStats>;

    if (message.type === "discontinuity") {
      this.events.onDiscontinuity({
        reason: message.reason ?? "inconnue",
        missingMs: message.missingMs ?? 0,
        // Un drapeau absent vaut une interruption : la lecture s'arrete le temps de rebufferiser.
        // C'est le sens le plus prudent des deux, et c'est celui que merite un message dont on ne
        // sait pas si la file a ete videe.
        recovered: message.recovered === true,
      });
      return;
    }

    if (message.type === "refused") {
      this.events.onRefusal(message.reason ?? "inconnue");
      return;
    }

    if (message.type === "stats") {
      this.events.onStats({
        accepted: message.accepted ?? 0,
        decoded: message.decoded ?? 0,
        refused: message.refused ?? 0,
        discontinuities: message.discontinuities ?? 0,
        flushes: message.flushes ?? 0,
        concealedMs: message.concealedMs ?? 0,
        lastRefusal: message.lastRefusal ?? null,
      });
      return;
    }

    if (message.type === "error") {
      this.events.onFailure(message.reason ?? "worker_error");
    }
  }
}
