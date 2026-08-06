import { DecodeWorkerHost } from "./decode-worker-host.ts";
import { FillGate } from "./fill-gate.ts";
import type { AudioStage, DiagnosticArea } from "./player-diagnostics.ts";
import {
  createPcmBuffer,
  NET_CEILING_MAX_MS,
  PCM_CAPACITY_FRAMES,
  PCM_PROCESSOR_NAME,
  PCM_SAMPLE_RATE,
} from "./pcm-worklet.js";

// Ce module cree et detruit les pieces que seul un navigateur fournit : le contexte audio, le
// processeur qui lit la file PCM, et le worker de decodage tenu par `decode-worker-host.ts`.
//
// Il ne decide rien. La machine d'etats decide, `audio-player.ts` traduit, ce module execute. Il
// est separe pour une raison precise : c'est la seule partie du player qui ne peut pas tourner sous
// Node, et la tenir a part garde le reste testable.

// Ce type decrit les deux pieces qui tournent dans leur propre contexte JavaScript : le worker de
// decodage et le processeur audio.
//
// Le worker arrive sous forme de fabrique et le processeur audio sous forme d'adresse, parce que les
// deux fichiers n'ont pas le meme besoin. Le worker importe `opus-decoder` : sa creation doit passer
// par l'outil de construction du site, seul capable de resoudre ce nom de paquet. Le processeur
// audio, lui, ne contient aucun import, et `audioWorklet.addModule` ne sait de toute facon prendre
// qu'une adresse.
export type AudioSetup = {
  createWorker: () => Worker;
  workletUrl: URL | string;
};

// Ce type decrit ce que le processeur audio rapporte a chaque releve, environ toutes les quarante
// millisecondes. C'est la seule vue que le thread principal ait sur la file PCM.
export type PcmLevel = {
  availableMs: number;
  underruns: number;
  overflows: number;
  // Sauts du filet : la file a depasse son plafond, donc le vidage a ete distance. Une anomalie.
  skips: number;
  // Ebarbages : une reprise de lecture a ramene la file au seuil. Le fonctionnement normal.
  trims: number;
  // Vitesse de consommation appliquee, en part de la vitesse nominale. Un ecart a 1 dit que le
  // regulateur ramene la latence vers le seuil.
  ratio: number;
};

// Ce type decrit ce que les pieces signalent a leur appelant.
export type BrowserAudioEvents = {
  onLevel: (level: PcmLevel) => void;
  onDiscontinuity: (note: { reason: string; missingMs: number; recovered: boolean }) => void;
  onRefusal: (reason: string) => void;
  onStats: (stats: { accepted: number; decoded: number; refused: number; discontinuities: number; concealedMs: number; lastRefusal: string | null }) => void;
  onFailure: (area: DiagnosticArea, reason: string) => void;
};

export class BrowserAudio {
  private setup: AudioSetup;
  private events: BrowserAudioEvents;
  private now: () => number;
  private decoder: DecodeWorkerHost;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private closed = false;
  private lastPlaying = false;
  // Ces deux bornes sont les dernieres transmises au processeur audio. Un ordre inchange n'est pas
  // renvoye. Les deux sont retenues, et pas seulement le plafond : celui-ci bute toujours sur la
  // limite des deux tiers de la file, donc un profil de latence change en cours de direct ne le
  // ferait pas bouger et la nouvelle hauteur de saut ne partirait jamais.
  private lastCeilingFrames = 0;
  private lastKeepFrames = 0;

  // Ce portail decide si le decodeur remplit la file. Il rassemble les trois signaux qui y
  // repondent, et que ce module lui remet a mesure qu'ils arrivent.
  private gate = new FillGate();

  // Cette famille retient d'ou vient la panne pendant la construction : le contexte audio d'abord,
  // le decodeur ensuite.
  private buildingArea: DiagnosticArea = "audio";

  stage: AudioStage = "IDLE";
  shared = false;

  constructor(setup: AudioSetup, events: BrowserAudioEvents, now: () => number = () => Date.now()) {
    this.setup = setup;
    this.events = events;
    this.now = now;
    this.decoder = new DecodeWorkerHost({
      onDiscontinuity: events.onDiscontinuity,
      onRefusal: events.onRefusal,
      onStats: events.onStats,
      onFailure: (reason) => this.events.onFailure("decode", reason),
    });
  }

  // Cette methode rend l'etat du contexte audio, ou `null` tant qu'il n'existe pas.
  get contextState(): string | null {
    return this.context === null ? null : this.context.state;
  }

  // Ces deux methodes rendent la latence de sortie annoncee par le contexte audio, en millisecondes,
  // ou `null` tant qu'aucun contexte n'existe. Aucune des deux n'est lue ailleurs dans le moteur —
  // elles n'existent que pour le diagnostic. `baseLatency` est l'estimation du navigateur au moment
  // de la creation du contexte ; `outputLatency` pretend mesurer la sortie materielle reelle, mais ne
  // l'implemente de facon fiable que sous Firefox a ce jour. Sous Chrome elle peut rendre zero ou une
  // valeur peu significative selon la version : ne pas conclure sur elle seule.
  get baseLatencyMs(): number | null {
    return this.context === null ? null : this.context.baseLatency * 1000;
  }

  get outputLatencyMs(): number | null {
    return this.context === null ? null : this.context.outputLatency * 1000;
  }

  // Cette methode construit les pieces, une seule fois. Un deuxieme appel rend la meme promesse.
  async start(): Promise<void> {
    if (this.starting !== null) {
      return this.starting;
    }

    this.starting = this.build().catch(async (error: unknown) => {
      const reason = error instanceof Error ? error.message : "audio_start_failed";
      const area = this.buildingArea;

      await this.teardown();

      if (!this.closed) {
        this.stage = "FAILED";
        this.events.onFailure(area, reason);
      }
    });

    return this.starting;
  }

  // Cette methode demonte tout et laisse l'objet pret pour un nouveau demarrage.
  async stop(): Promise<void> {
    await this.teardown();
  }

  // Cette methode ferme definitivement.
  //
  // Elle attend un demarrage en cours avant de demonter. Sans cette attente, fermer la page pendant
  // le chargement du processeur audio laisserait derriere elle un contexte audio et un worker crees
  // apres la fermeture, que plus rien ne referme.
  async close(): Promise<void> {
    this.closed = true;

    if (this.starting !== null) {
      await this.starting.catch(() => {});
    }

    await this.teardown();
    this.stage = "CLOSED";
  }

  // Cette methode reprend un contexte suspendu. Un contexte cree pendant un onglet en arriere-plan
  // demarre suspendu, et le systeme peut en suspendre un a tout moment.
  async resume(): Promise<void> {
    if (this.context !== null && this.context.state !== "running") {
      await this.context.resume().catch(() => {});
    }
  }

  // Cette methode transmet un paquet au decodeur.
  //
  // Les paquets recus avant que les pieces soient pretes sont abandonnes. Le worker les refuserait
  // de toute facon, faute de connaitre la session, et chaque refus laisserait une trace trompeuse
  // dans les compteurs de diagnostic.
  sendPacket(packet: ArrayBuffer): void {
    if (this.stage !== "RUNNING") {
      return;
    }

    // L'arret du thread audio se constate a l'arrivee d'un paquet, cinquante fois par seconde :
    // c'est le flux qu'il s'agit de retenir, et le moteur n'a ainsi aucune horloge a lui.
    this.gate.checkStall(this.now());
    this.updateAccepting();

    this.decoder.sendPacket(packet);
  }

  // Cette methode transmet au decodeur la reponse du portail. Le passage par `false` jette le son
  // deja en attente, donc la reprise se fait toujours sur du direct.
  private updateAccepting(): void {
    this.decoder.setAccepting(this.gate.open);
  }

  setSession(sessionId: number): void {
    this.decoder.setSession(sessionId);
  }

  // Cette methode dit au decodeur de remplir la file, ou d'abandonner ce qu'il recoit.
  setAccepting(accepting: boolean): void {
    this.gate.setWanted(accepting);
    this.updateAccepting();
  }

  applyFlush(flushId: number): void {
    this.decoder.applyFlush(flushId);
  }

  // Cette methode donne au processeur audio la hauteur au-dela de laquelle il saute au direct, et
  // ce qu'il doit garder en sautant. Le processeur ne connait pas le profil de la session : c'est la
  // machine d'etats qui le tient, et cette borne en decoule.
  setLimit(ceilingMs: number, keepMs: number): void {
    if (this.node === null) {
      return;
    }

    // Le plafond demande est ramene a la borne de la file. L'appelant applique deja cette borne pour
    // que la valeur qu'il calcule soit lisible ; elle est reappliquee ici parce qu'elle appartient a
    // la file et non a l'appelant : la file doit tenir sa garantie quel que soit l'ordre recu.
    const maxFrames = Math.round((NET_CEILING_MAX_MS * PCM_SAMPLE_RATE) / 1000);
    const ceilingFrames = Math.min(Math.round((ceilingMs * PCM_SAMPLE_RATE) / 1000), maxFrames);
    const keepFrames = Math.round((keepMs * PCM_SAMPLE_RATE) / 1000);

    if (ceilingFrames === this.lastCeilingFrames && keepFrames === this.lastKeepFrames) {
      return;
    }

    this.lastCeilingFrames = ceilingFrames;
    this.lastKeepFrames = keepFrames;
    this.node.port.postMessage({ type: "limit", ceilingFrames, keepFrames });
  }

  // Cette methode dit au processeur audio de consommer la file, ou de produire du silence.
  setPlaying(playing: boolean): void {
    if (this.node === null || playing === this.lastPlaying) {
      return;
    }

    this.lastPlaying = playing;
    this.node.port.postMessage({ type: playing ? "play" : "pause" });
  }

  private async build(): Promise<void> {
    this.stage = "STARTING";
    this.buildingArea = "audio";

    // `crossOriginIsolated` dit si la page a recu les en-tetes COOP et COEP. Sans eux,
    // `SharedArrayBuffer` n'existe pas, et les echantillons passent par un port.
    this.shared = typeof globalThis.crossOriginIsolated === "boolean" && globalThis.crossOriginIsolated;
    const pcmBuffer = createPcmBuffer(this.shared);

    // Le contexte demande explicitement 48 kHz, le taux du protocole. Le navigateur reechantillonne
    // seul si sa sortie tourne a un autre taux.
    const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE, latencyHint: "playback" });
    this.context = context;
    this.watchContext(context);

    // `audioWorklet` n'existe que dans un contexte securise : une page en `https://`, ou servie
    // depuis `localhost`. Une page en `http://` venue d'une autre machine n'en a pas, et le
    // processeur audio ne peut donc pas etre charge du tout.
    //
    // Sans cette verification, l'absence se voit sous la forme d'une erreur de propriete indefinie,
    // qui dit ou le code s'est arrete mais pas ce qu'il faut corriger.
    if (context.audioWorklet === undefined) {
      throw new Error("audioworklet_unavailable");
    }

    await context.audioWorklet.addModule(this.setup.workletUrl.toString());

    // Une fermeture pendant le chargement s'arrete ici : le demontage ferme le contexte deja cree,
    // et rien de plus n'est construit.
    if (this.closed) {
      await this.teardown();
      return;
    }

    // En mode messages, ce canal relie directement le worker au processeur audio. Le thread
    // principal ne fait que remettre chaque extremite a son proprietaire.
    const channel = this.shared ? null : new MessageChannel();

    const node = new AudioWorkletNode(context, PCM_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { buffer: pcmBuffer, capacityFrames: PCM_CAPACITY_FRAMES },
    });

    // Le port du canal ne peut pas voyager dans les options de construction : celles-ci sont
    // copiees, et un `MessagePort` se transfere, il ne se copie pas. Il part donc par le port du
    // noeud, qui accepte une liste de transfert.
    if (channel !== null) {
      node.port.postMessage({ type: "port", port: channel.port2 }, [channel.port2]);
    }

    node.port.onmessage = (event: MessageEvent) => this.handleLevel(event);
    node.connect(context.destination);
    this.node = node;

    this.buildingArea = "decode";
    await this.decoder.start(
      this.setup.createWorker,
      channel === null ? { buffer: pcmBuffer, capacityFrames: PCM_CAPACITY_FRAMES } : { port: channel.port1 },
    );

    if (this.closed) {
      await this.teardown();
      return;
    }

    this.stage = "RUNNING";
  }

  // Cette methode surveille le contexte audio.
  //
  // Un contexte peut etre suspendu sans que la page le demande : onglet mis en arriere-plan, appel
  // telephonique sur un appareil Apple, peripherique de sortie debranche. Safari annonce alors
  // `interrupted` la ou les autres annoncent `suspended`.
  private watchContext(context: AudioContext): void {
    context.onstatechange = () => {
      if (context !== this.context || this.closed) {
        return;
      }

      // Le decodeur suit l'etat du contexte : il arrete de remplir la file quand le thread audio
      // s'arrete, et la remplit de nouveau des qu'il repart.
      const running = context.state === "running";
      this.gate.setContextRunning(running);
      this.updateAccepting();

      if (!running && this.gate.wanted) {
        void context.resume().catch(() => {});
      }
    };
  }

  // Cette methode traite le niveau annonce par le processeur audio.
  //
  // Chaque niveau prouve que le thread audio tourne : c'est ici que le remplissage de la file
  // reprend apres un arret constate.
  private handleLevel(event: MessageEvent): void {
    const message = event.data as { type: string } & Partial<PcmLevel>;

    if (message.type !== "level") {
      return;
    }

    this.gate.noteLevel(this.now());
    this.updateAccepting();

    this.events.onLevel({
      availableMs: message.availableMs ?? 0,
      underruns: message.underruns ?? 0,
      overflows: message.overflows ?? 0,
      skips: message.skips ?? 0,
      trims: message.trims ?? 0,
      ratio: message.ratio ?? 1,
    });
  }

  // Cette methode detruit les pieces et oublie les ordres deja transmis.
  private async teardown(): Promise<void> {
    this.starting = null;
    this.decoder.stop();

    this.node?.port.postMessage({ type: "stop" });
    this.node?.disconnect();
    this.node = null;
    this.lastPlaying = false;
    this.lastCeilingFrames = 0;
    this.lastKeepFrames = 0;
    this.gate.reset();

    const context = this.context;
    this.context = null;

    if (context !== null) {
      context.onstatechange = null;

      try {
        await context.close();
      } catch {
        // Un contexte deja ferme n'a plus rien a fermer.
      }
    }

    this.stage = this.closed ? "CLOSED" : "IDLE";
  }
}
