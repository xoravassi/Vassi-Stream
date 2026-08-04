// Ce fichier imite le strict necessaire du navigateur : contexte audio, noeud de traitement et
// worker. Il existe pour une raison precise : l'assemblage du player, dans `audio-player.ts`, est la
// seule piece que ni Node ni les autres tests ne touchent, et c'est celle qui relie toutes les
// autres. Un fil oublie entre deux threads ne se voit nulle part ailleurs qu'a l'oreille.

// Ce type decrit un message capture par une des fausses pieces. `ordre` classe les messages de
// toutes les pieces dans une seule suite : c'est ce qui permet a un test de verifier qu'un ordre
// parti vers le processeur audio precede un ordre parti vers le worker.
export type SentMessage = {
  data: Record<string, unknown>;
  transfer: unknown[];
  ordre: number;
};

// Ce compteur avance a chaque message envoye, quelle que soit la piece qui l'envoie.
let prochainRang = 0;

// Cette classe imite un `MessagePort` : elle garde ce qu'on lui envoie et sait le remettre.
export class FakePort {
  readonly sent: SentMessage[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(data: Record<string, unknown>, transfer: unknown[] = []): void {
    prochainRang += 1;
    this.sent.push({ data, transfer, ordre: prochainRang });
  }

  // Cette methode delivre un message a celui qui ecoute ce port.
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  // Cette methode rend les messages d'un type donne, dans leur ordre d'envoi.
  messagesOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.data.type === type).map((message) => message.data);
  }

  close(): void {}
  start(): void {}
}

// Cette classe imite le canal qui relie le worker au processeur audio.
export class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
}

// Cette classe imite le worker de decodage. Elle repond `ready` comme le vrai, pour que le player
// puisse continuer son demarrage.
export class FakeWorker extends FakePort {
  static last: FakeWorker | null = null;
  static created: FakeWorker[] = [];
  // Ce drapeau fait echouer la compilation du WebAssembly Opus, comme un navigateur qui refuse le
  // module. Il sert a verifier ce que le player fait d'un decodeur qui ne demarre pas.
  static failOnConfigure = false;

  readonly url: unknown;
  terminated = false;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: unknown, _options?: unknown) {
    super();
    this.url = url;
    FakeWorker.last = this;
    FakeWorker.created.push(this);
  }

  override postMessage(data: Record<string, unknown>, transfer: unknown[] = []): void {
    super.postMessage(data, transfer);

    if (data.type !== "configure") {
      return;
    }

    if (FakeWorker.failOnConfigure) {
      queueMicrotask(() => this.deliver({ type: "error", reason: "opus_start_failed" }));
      return;
    }

    // Le vrai worker repond des que le WebAssembly Opus est compile.
    queueMicrotask(() => this.deliver({ type: "ready" }));
  }

  // Cette methode imite un worker qui meurt pendant le direct.
  crash(): void {
    this.onerror?.({ message: "worker_failed" });
  }

  terminate(): void {
    this.terminated = true;
  }
}

// Cette classe imite le noeud audio et son port de commande.
export class FakeAudioWorkletNode {
  static last: FakeAudioWorkletNode | null = null;

  readonly port = new FakePort();
  readonly options: Record<string, unknown>;
  readonly name: string;
  connected = false;

  constructor(_context: unknown, name: string, options: Record<string, unknown>) {
    this.name = name;
    this.options = options;
    FakeAudioWorkletNode.last = this;
  }

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }
}

// Cette classe imite le contexte audio et son chargement de module.
export class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  static created: FakeAudioContext[] = [];
  // Tant que cette promesse n'est pas tenue, `addModule` n'a pas rendu la main. Elle sert a fermer
  // le player exactement pendant le chargement du processeur audio.
  static moduleGate: Promise<void> | null = null;
  // Ce drapeau imite une page qui n'est pas un contexte securise : `audioWorklet` y est absent.
  static sansAudioWorklet = false;

  readonly modules: string[] = [];
  readonly destination = {};
  readonly settings: Record<string, unknown>;
  state = "running";
  resumes = 0;
  onstatechange: (() => void) | null = null;

  constructor(settings: Record<string, unknown> = {}) {
    this.settings = settings;
    FakeAudioContext.last = this;
    FakeAudioContext.created.push(this);
  }

  readonly audioWorklet = FakeAudioContext.sansAudioWorklet
    ? undefined
    : {
        addModule: async (url: string): Promise<void> => {
          this.modules.push(url);

          if (FakeAudioContext.moduleGate !== null) {
            await FakeAudioContext.moduleGate;
          }
        },
      };

  // Cette methode imite une suspension venue du systeme : onglet en arriere-plan, appel
  // telephonique sur un appareil Apple, peripherique de sortie debranche. Safari annonce
  // `interrupted` la ou les autres annoncent `suspended`.
  interrupt(state = "suspended"): void {
    this.state = state;
    this.onstatechange?.();
  }

  async resume(): Promise<void> {
    this.resumes += 1;
    this.state = "running";
    this.onstatechange?.();
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

// Ce type garde les valeurs remplacees, pour les remettre a la fin d'un test.
type Saved = Record<string, unknown>;

// Cette fonction installe les fausses pieces a la place des pieces du navigateur, et rend la
// fonction qui remet tout en place.
export function installBrowserFakes(options: { isolated: boolean }): () => void {
  const target = globalThis as unknown as Saved;
  const keys = ["AudioContext", "AudioWorkletNode", "Worker", "MessageChannel", "crossOriginIsolated"];
  const saved: Saved = {};

  for (const key of keys) {
    saved[key] = target[key];
  }

  target.AudioContext = FakeAudioContext;
  target.AudioWorkletNode = FakeAudioWorkletNode;
  target.Worker = FakeWorker;
  target.MessageChannel = FakeMessageChannel;
  target.crossOriginIsolated = options.isolated;

  FakeWorker.last = null;
  FakeWorker.created = [];
  FakeWorker.failOnConfigure = false;
  FakeAudioWorkletNode.last = null;
  FakeAudioContext.last = null;
  FakeAudioContext.created = [];
  FakeAudioContext.moduleGate = null;
  FakeAudioContext.sansAudioWorklet = false;

  return () => {
    for (const key of keys) {
      target[key] = saved[key];
    }

    FakeWorker.failOnConfigure = false;
    FakeAudioContext.moduleGate = null;
    FakeAudioContext.sansAudioWorklet = false;
  };
}
