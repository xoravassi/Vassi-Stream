import { BrowserAudio } from "./browser-audio.ts";
import { ListenerSocket } from "./listener-socket.ts";
import type { DiagnosticArea, PlayerDiagnostics } from "./player-diagnostics.ts";
import { PlayerStateMachine, type PlayerStatus } from "./player-state.ts";

// Ce module assemble le moteur audio : la connexion au relais, la machine d'etats, les pieces du
// navigateur et les compteurs de diagnostic.
//
// Il ne contient aucune decision et ne touche jamais a un echantillon. La machine d'etats decide,
// `browser-audio.ts` execute, ce module fait passer les ordres de l'une a l'autre et compte ce qui
// traverse.

// Ce type decrit les adresses dont le moteur a besoin. Le bloc 9 fournit les deux dernieres avec
// `new URL(..., import.meta.url)` pour que le bundler du site les emette lui-meme : rien n'est
// telecharge depuis un CDN.
export type PlayerUrls = {
  relayUrl: string;
  workerUrl: URL | string;
  workletUrl: URL | string;
};

// Ce type decrit la seule piece remplacable du player, pour que les tests mesurent des durees sans
// attendre reellement.
export type PlayerDeps = {
  now: () => number;
};

// Cette classe est la surface utilisee par la page `/live`.
export class AudioPlayer {
  private now: () => number;
  private machine: PlayerStateMachine;
  private socket: ListenerSocket;
  private audio: BrowserAudio;
  private closed = false;

  // Cette famille retient d'ou venait la panne, que le message d'erreur seul ne dit pas toujours.
  private failedArea: DiagnosticArea | null = null;

  // Ces compteurs ne servent qu'au diagnostic. Ils repondent aux trois questions posees quand le
  // son ne sort pas : les paquets arrivent-ils, sont-ils decodes, le thread audio tourne-t-il ?
  private counters = {
    packets: 0,
    accepted: 0,
    decoded: 0,
    refused: 0,
    discontinuities: 0,
    underruns: 0,
    overflows: 0,
  };
  private lastRefusal: string | null = null;
  private lastPacketAt: number | null = null;
  private lastLevelAt: number | null = null;
  private bufferMs = 0;

  // Ces deux valeurs suivent la session en cours. La date d'annonce sert quand aucun paquet n'est
  // encore arrive : sans elle, un direct annonce qui n'envoie jamais rien — la panne reseau la plus
  // franche — ne se distinguerait pas d'un direct qui vient de commencer.
  private announcedSessionId = 0;
  private liveSince: number | null = null;

  constructor(urls: PlayerUrls, onChange: (status: PlayerStatus) => void = () => {}, deps: Partial<PlayerDeps> = {}) {
    this.now = deps.now ?? (() => Date.now());

    this.machine = new PlayerStateMachine((status) => {
      this.applyCommands(status);
      onChange(status);
    });

    this.audio = new BrowserAudio(urls, {
      onLevel: (availableMs, underruns, overflows) => this.handleLevel(availableMs, underruns, overflows),
      onDiscontinuity: () => this.machine.discontinuity(),
      onRefusal: (reason) => {
        this.lastRefusal = reason;
      },
      // Ces compteurs viennent du worker et le remplacent en entier : ils decrivent le worker
      // vivant, y compris quand celui-ci vient de naitre et n'a donc encore rien compte.
      onStats: (stats) => {
        this.counters.accepted = stats.accepted;
        this.counters.decoded = stats.decoded;
        this.counters.refused = stats.refused;
        this.counters.discontinuities = stats.discontinuities;
        this.lastRefusal = stats.lastRefusal;
      },
      onFailure: (area, reason) => this.fail(area, reason),
    }, this.now);

    this.socket = new ListenerSocket(urls.relayUrl, {
      onState: (state) => {
        this.machine.setStream(state);
        this.trackSession();
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
    return this.counters.packets;
  }

  // Cette methode rend la quantite de son en attente dans la file, en millisecondes, telle que le
  // processeur audio l'a annoncee la derniere fois.
  get bufferedMs(): number {
    return this.bufferMs;
  }

  // Cette methode rend tout ce que le moteur sait de lui-meme. `explainPlayer` la lit pour ranger
  // une panne entre reseau, decodage et contexte audio.
  diagnostics(): PlayerDiagnostics {
    const status = this.machine.status();
    const at = this.now();

    return {
      state: status.state,
      sessionId: status.session === null ? null : status.session.sessionId,
      targetBufferMs: this.machine.targetBufferMs(),
      shared: this.audio.shared,

      connected: this.socket.connected,
      packets: this.counters.packets,
      sincePacketMs: this.lastPacketAt === null ? null : at - this.lastPacketAt,
      sinceLiveMs: this.liveSince === null ? null : at - this.liveSince,

      accepted: this.counters.accepted,
      decoded: this.counters.decoded,
      refused: this.counters.refused,
      lastRefusal: this.lastRefusal,
      discontinuities: this.counters.discontinuities,

      audio: this.audio.stage,
      contextState: this.audio.contextState,
      bufferedMs: this.bufferMs,
      underruns: this.counters.underruns,
      overflows: this.counters.overflows,
      sinceLevelMs: this.lastLevelAt === null ? null : at - this.lastLevelAt,

      errorReason: status.errorReason,
      errorArea: this.failedArea,
    };
  }

  // Cette methode ouvre la connexion au relais. Elle ne cree aucun contexte audio : les navigateurs
  // refusent de demarrer le son sans un geste de l'auditeur, Safari le plus strictement.
  connect(): void {
    this.socket.start();
  }

  // Cette methode ferme tout : connexion, worker, contexte audio.
  async close(): Promise<void> {
    this.closed = true;
    this.socket.stop();
    await this.audio.close();
  }

  // Cette methode traite le clic sur Play. Le contexte audio est cree ici, au premier clic, parce
  // que c'est le seul moment ou le navigateur autorise le son.
  async play(): Promise<void> {
    if (this.closed) {
      return;
    }

    // Une panne passagere ne doit pas bloquer la page jusqu'au rechargement. Les pieces en panne
    // sont jetees, puis la machine sort de l'erreur et le demarrage recommence a neuf.
    if (this.machine.status().state === "ERROR") {
      await this.audio.stop();
      this.failedArea = null;
      this.machine.recover();
    }

    await this.audio.start();

    if (this.closed || this.audio.stage !== "RUNNING") {
      return;
    }

    // Les pieces sont neuves : elles ignorent la session en cours et les ordres deja donnes.
    this.announceSession();
    this.applyCommands(this.machine.status());

    await this.audio.resume();
    this.machine.play();
  }

  // Cette methode traite le clic sur Pause.
  pause(): void {
    this.machine.pause();
  }

  // Cette methode enregistre le niveau annonce par le processeur audio et le remet a la machine.
  private handleLevel(availableMs: number, underruns: number, overflows: number): void {
    this.bufferMs = availableMs;
    this.counters.underruns = underruns;
    this.counters.overflows = overflows;
    // Cette date est la preuve que le thread audio tourne encore. Un contexte suspendu cesse
    // d'appeler le processeur, donc plus aucun niveau n'arrive.
    this.lastLevelAt = this.now();
    this.machine.reportLevel(availableMs, underruns);
  }

  // Cette methode declare une panne en retenant sa famille.
  private fail(area: DiagnosticArea, reason: string): void {
    if (this.closed) {
      return;
    }

    this.failedArea = area;
    this.machine.fail(reason);
  }

  // Cette methode compte un paquet recu et le transmet aux pieces du navigateur.
  private sendPacket(packet: ArrayBuffer): void {
    this.counters.packets += 1;
    this.lastPacketAt = this.now();
    this.audio.sendPacket(packet);
  }

  // Cette methode note le moment ou une nouvelle session commence.
  //
  // Le compteur de paquets repart de rien : les paquets du direct precedent ne disent rien de
  // celui-ci, et les garder ferait passer un nouveau direct muet pour un direct qui parle.
  private trackSession(): void {
    const session = this.machine.status().session;
    const sessionId = session === null ? 0 : session.sessionId;

    if (sessionId === this.announcedSessionId) {
      return;
    }

    this.announcedSessionId = sessionId;
    this.lastPacketAt = null;
    this.liveSince = sessionId === 0 ? null : this.now();
  }

  // Cette methode transmet la session courante au decodeur.
  private announceSession(): void {
    const session = this.machine.status().session;
    this.audio.setSession(session === null ? 0 : session.sessionId);
  }

  // Cette methode traduit l'etat en trois ordres : le decodeur remplit-il la file, le son en attente
  // doit-il etre jete, le processeur audio consomme-t-il la file.
  //
  // L'ordre protege la file. Un arret de lecture part en premier : vider une file que le processeur
  // audio lit encore lui fait rendre du silence pendant un bloc ou deux, ce qui compte des manques de
  // donnees qui n'en sont pas et peut faire rebufferiser pour rien. Une reprise de lecture part en
  // dernier, quand la file est deja dans l'etat voulu.
  private applyCommands(status: PlayerStatus): void {
    if (!status.playing) {
      this.audio.setPlaying(false);
    }

    this.audio.setAccepting(status.accepting);
    this.audio.applyFlush(status.flushId);

    if (status.playing) {
      this.audio.setPlaying(true);
    }
  }
}
