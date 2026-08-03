import { ListenerSocket } from "./listener-socket.ts";
import { PlayerStateMachine, type PlayerStatus } from "./player-state.ts";
import { createPcmBuffer, PCM_CAPACITY_FRAMES, PCM_PROCESSOR_NAME, PCM_SAMPLE_RATE } from "./pcm-worklet.js";

// Ce module assemble le moteur audio : la connexion, le worker de decodage, la file PCM et le
// processeur audio. Il ne contient aucune decision : la machine d'etats decide, ce module execute.
//
// C'est la seule partie du bloc 8 qui a besoin d'un navigateur. Tout ce qui se calcule sans lui est
// dans `player-state.ts`, `player-protocol.ts` et `pcm-worklet.js`, et se teste sous Node.

// Ce type decrit les adresses des deux fichiers charges dans leur propre contexte. Le bloc 9 les
// fournit avec `new URL(..., import.meta.url)` pour que le bundler du site les emette lui-meme :
// rien n'est telecharge depuis un CDN.
export type PlayerUrls = {
  relayUrl: string;
  workerUrl: URL | string;
  workletUrl: URL | string;
};

// Cette classe est la surface utilisee par la page `/live`.
export class AudioPlayer {
  private urls: PlayerUrls;
  private machine: PlayerStateMachine;
  private socket: ListenerSocket;
  private worker: Worker | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private pcmBuffer: ArrayBufferLike | null = null;
  private shared = false;
  private starting: Promise<void> | null = null;
  private lastSessionId = 0;
  private lastCommands = { accepting: false, playing: false };
  // Ces deux valeurs ne servent qu'au diagnostic. Elles repondent aux deux questions posees quand
  // le son ne sort pas : les paquets arrivent-ils, et la file se remplit-elle ?
  private packets = 0;
  private bufferMs = 0;

  constructor(urls: PlayerUrls, onChange: (status: PlayerStatus) => void = () => {}) {
    this.urls = urls;
    this.machine = new PlayerStateMachine((status) => {
      this.applyCommands(status);
      onChange(status);
    });

    this.socket = new ListenerSocket(urls.relayUrl, {
      onState: (state) => {
        this.machine.setStream(state);
        this.announceSession();
      },
      onPacket: (packet) => this.sendPacket(packet),
      onConnectionLost: () => this.machine.connectionLost(),
    });
  }

  // Cette methode rend l'etat complet du player.
  status(): PlayerStatus {
    return this.machine.status();
  }

  // Cette methode rend le nombre de paquets audio recus du relais depuis la connexion.
  get packetsReceived(): number {
    return this.packets;
  }

  // Cette methode rend la quantite de son en attente dans la file, en millisecondes, telle que le
  // processeur audio l'a annoncee la derniere fois.
  get bufferedMs(): number {
    return this.bufferMs;
  }

  // Cette methode ouvre la connexion au relais. Elle ne cree aucun contexte audio : les navigateurs
  // refusent de demarrer le son sans un geste de l'auditeur, Safari le plus strictement.
  connect(): void {
    this.socket.start();
  }

  // Cette methode ferme tout : connexion, worker, contexte audio.
  async close(): Promise<void> {
    this.socket.stop();
    this.worker?.postMessage({ type: "stop" });
    this.worker?.terminate();
    this.worker = null;
    this.node?.port.postMessage({ type: "stop" });
    this.node?.disconnect();
    this.node = null;

    if (this.context !== null) {
      await this.context.close();
      this.context = null;
    }
  }

  // Cette methode traite le clic sur Play. Le contexte audio est cree ici, au premier clic, parce
  // que c'est le seul moment ou le navigateur autorise le son.
  async play(): Promise<void> {
    await this.startAudio();

    // Un contexte cree pendant un onglet en arriere-plan demarre suspendu.
    if (this.context !== null && this.context.state === "suspended") {
      await this.context.resume();
    }

    this.machine.play();
  }

  // Cette methode traite le clic sur Pause.
  pause(): void {
    this.machine.pause();
  }

  // Cette methode cree le contexte audio, le processeur et le worker, une seule fois.
  private async startAudio(): Promise<void> {
    if (this.starting !== null) {
      return this.starting;
    }

    this.starting = this.buildAudio().catch((error: unknown) => {
      this.starting = null;
      this.machine.fail(error instanceof Error ? error.message : "audio_start_failed");
      throw error;
    });

    return this.starting;
  }

  private async buildAudio(): Promise<void> {
    // `crossOriginIsolated` dit si la page a recu les en-tetes COOP et COEP. Sans eux,
    // `SharedArrayBuffer` n'existe pas, et les echantillons passent par un port.
    this.shared = typeof globalThis.crossOriginIsolated === "boolean" && globalThis.crossOriginIsolated;
    this.pcmBuffer = createPcmBuffer(this.shared);

    // Le contexte demande explicitement 48 kHz, le taux du protocole. Le navigateur reechantillonne
    // seul si sa sortie tourne a un autre taux.
    const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE, latencyHint: "playback" });
    this.context = context;

    await context.audioWorklet.addModule(this.urls.workletUrl.toString());

    // En mode messages, ce canal relie directement le worker au processeur audio. Le thread
    // principal ne fait que remettre chaque extremite a son proprietaire.
    const channel = this.shared ? null : new MessageChannel();

    const node = new AudioWorkletNode(context, PCM_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { buffer: this.pcmBuffer, capacityFrames: PCM_CAPACITY_FRAMES },
    });

    // Le port du canal ne peut pas voyager dans les options de construction : celles-ci sont
    // copiees, et un `MessagePort` se transfere, il ne se copie pas. Il part donc par le port du
    // noeud, qui accepte une liste de transfert.
    if (channel !== null) {
      node.port.postMessage({ type: "port", port: channel.port2 }, [channel.port2]);
    }

    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; availableMs: number; underruns: number };

      if (message.type === "level") {
        this.bufferMs = message.availableMs;
        this.machine.reportLevel(message.availableMs, message.underruns);
      }
    };

    node.connect(context.destination);
    this.node = node;

    await this.startWorker(channel);
    this.announceSession();
    this.applyCommands(this.machine.status());
  }

  // Cette methode demarre le worker de decodage et attend que le WebAssembly Opus soit pret.
  private async startWorker(channel: MessageChannel | null): Promise<void> {
    const worker = new Worker(this.urls.workerUrl, { type: "module" });
    this.worker = worker;

    const ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as { type: string; reason?: string };

        if (message.type === "ready") {
          worker.onmessage = (next: MessageEvent) => this.handleWorkerMessage(next);
          resolve();
          return;
        }

        if (message.type === "error") {
          reject(new Error(message.reason ?? "opus_start_failed"));
        }
      };

      worker.onerror = () => reject(new Error("worker_failed"));
    });

    if (channel === null) {
      worker.postMessage({ type: "configure", buffer: this.pcmBuffer, capacityFrames: PCM_CAPACITY_FRAMES });
    } else {
      worker.postMessage({ type: "configure", port: channel.port1 }, [channel.port1]);
    }

    await ready;
  }

  // Cette methode traite ce que le worker signale pendant le direct.
  private handleWorkerMessage(event: MessageEvent): void {
    const message = event.data as { type: string; reason?: string };

    if (message.type === "discontinuity") {
      this.machine.discontinuity();
    }
  }

  // Cette methode transmet un paquet au worker sans le lire. Le tampon est transfere : le thread
  // principal ne recopie aucun octet audio.
  private sendPacket(packet: ArrayBuffer): void {
    this.packets += 1;
    this.worker?.postMessage({ type: "packet", packet }, [packet]);
  }

  // Cette methode previent le worker d'un changement de session.
  //
  // Elle ne retient que ce qu'elle a reellement envoye. La connexion s'ouvre avant le premier clic
  // sur Play, donc une session est deja connue quand le worker naît : si cette methode notait la
  // session sans pouvoir la transmettre, le worker garderait la session zero, refuserait chaque
  // paquet pour session etrangere, et aucun son ne sortirait jamais.
  private announceSession(): void {
    const worker = this.worker;

    if (worker === null) {
      return;
    }

    const session = this.machine.status().session;
    const sessionId = session === null ? 0 : session.sessionId;

    if (sessionId === this.lastSessionId) {
      return;
    }

    this.lastSessionId = sessionId;
    worker.postMessage({ type: "session", sessionId });
  }

  // Cette methode traduit l'etat en deux ordres : le decodeur remplit-il la file, le processeur
  // audio la consomme-t-il. Chaque ordre n'est envoye que lorsqu'il change, et n'est retenu que
  // lorsqu'il part reellement.
  private applyCommands(status: PlayerStatus): void {
    const worker = this.worker;
    const node = this.node;

    if (worker !== null && status.accepting !== this.lastCommands.accepting) {
      this.lastCommands.accepting = status.accepting;
      worker.postMessage({ type: "accepting", accepting: status.accepting });
    }

    if (node !== null && status.playing !== this.lastCommands.playing) {
      this.lastCommands.playing = status.playing;
      node.port.postMessage({ type: status.playing ? "play" : "pause" });
    }
  }
}
