import { BackgroundAudio, type BackgroundAudioDeps, type BackgroundAudioTitle } from "./background-audio.ts";
import { BrowserAudio } from "./browser-audio.ts";
import { ListenerSocket } from "./listener-socket.ts";
import type { DiagnosticArea, PlayerDiagnostics } from "./player-diagnostics.ts";
import { NET_CEILING_MAX_MS } from "./pcm-worklet.js";
import { LATE_MARGIN_MS, PlayerStateMachine, type PlayerStatus } from "./player-state.ts";

// Ce module assemble le moteur audio : la connexion au relais, la machine d'etats, les pieces du
// navigateur et les compteurs de diagnostic.
//
// Il ne contient aucune decision et ne touche jamais a un echantillon. La machine d'etats decide,
// `browser-audio.ts` execute, ce module fait passer les ordres de l'une a l'autre et compte ce qui
// traverse.

// Ce type decrit tout ce dont le moteur a besoin pour atteindre ses pieces.
//
// `createWorker` est une fabrique et non une adresse. Le worker de decodage importe la bibliotheque
// `opus-decoder`, un nom de paquet qu'un navigateur ne sait pas resoudre : c'est l'outil de
// construction du site qui s'en charge, et il ne le fait que s'il voit lui-meme la creation du
// worker. Le processeur audio, lui, ne contient aucun import et se donne par son adresse.
//
// Rien n'est telecharge depuis un CDN : les deux fichiers sont livres par le site.
// `title` nomme le direct sur l'ecran verrouille d'un telephone et dans la liste des lectures en
// cours du systeme. Il est facultatif : le moteur ne connait pas le nom du site qui l'emploie, et
// il ne doit en inventer aucun.
export type PlayerSetup = {
  relayUrl: string;
  createWorker: () => Worker;
  workletUrl: URL | string;
  title?: BackgroundAudioTitle;
};

// Ce titre sert tant que la page n'en fournit pas. Il decrit ce qui joue, sans nommer personne.
export const DEFAULT_TITLE: BackgroundAudioTitle = { title: "Direct", artist: "Session en direct" };

// Ce type decrit les pieces remplacables du player, pour que les tests mesurent des durees sans
// attendre reellement et n'aient besoin d'aucune interface de navigateur.
export type PlayerDeps = {
  now: () => number;
  background: Partial<BackgroundAudioDeps>;
};

// Cette classe est la surface utilisee par la page `/session` du site.
export class AudioPlayer {
  private now: () => number;
  private machine: PlayerStateMachine;
  private socket: ListenerSocket;
  private audio: BrowserAudio;
  private background: BackgroundAudio;
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
    skips: 0,
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

  constructor(setup: PlayerSetup, onChange: (status: PlayerStatus) => void = () => {}, deps: Partial<PlayerDeps> = {}) {
    this.now = deps.now ?? (() => Date.now());

    this.machine = new PlayerStateMachine((status) => {
      this.applyCommands(status);
      onChange(status);
    });

    this.audio = new BrowserAudio(setup, {
      onLevel: (availableMs, underruns, overflows, skips) =>
        this.handleLevel(availableMs, underruns, overflows, skips),
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

    this.socket = new ListenerSocket(setup.relayUrl, {
      onState: (state) => {
        this.machine.setStream(state);
        this.trackSession();
        this.announceSession();
        // Les bornes du processeur audio dependent du profil de latence, donc de la session, et pas
        // seulement de l'etat. La machine ne previent que lorsque son etat change de nom : un direct
        // relance sur un autre profil pendant que la page bufferise deja la laisserait muette, et la
        // hauteur de saut resterait celle du direct precedent. Ce rappel est sans effet quand rien
        // n'a change — chaque ordre transmis est deja compare au precedent.
        this.applyCommands(this.machine.status());
      },
      onPacket: (packet) => this.sendPacket(packet),
      onConnectionLost: () => this.machine.connectionLost(),
    });

    // Ce module tient ce qui arrive quand l'auditeur range son telephone : declaration de
    // l'intention audio, commandes de l'ecran verrouille, et reprise au retour au premier plan.
    // Il ne touche jamais au contexte audio lui-meme : il demande, `BrowserAudio` execute.
    this.background = new BackgroundAudio(
      {
        onWake: () => void this.audio.resume(),
        isAwake: () => this.audio.contextState === "running",
        onPlay: () => void this.play(),
        onPause: () => this.pause(),
      },
      setup.title ?? DEFAULT_TITLE,
      deps.background ?? {},
    );
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
      skips: this.counters.skips,
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

  // Cette methode ferme tout : connexion, worker, contexte audio, commandes systeme.
  async close(): Promise<void> {
    this.closed = true;
    this.background.stop();
    this.socket.stop();
    await this.audio.close();
  }

  // Cette methode traite le clic sur Play. Le contexte audio est cree ici, au premier clic, parce
  // que c'est le seul moment ou le navigateur autorise le son.
  async play(): Promise<void> {
    if (this.closed) {
      return;
    }

    // L'intention audio de la page se declare avant la creation du contexte : c'est ce que le
    // systeme lit au moment ou le son commence, et c'est ce qui decide, sur iOS, si le bouton
    // silencieux du telephone coupe ce son ou le laisse passer.
    this.background.start();

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
  private handleLevel(availableMs: number, underruns: number, overflows: number, skips: number): void {
    this.bufferMs = availableMs;
    this.counters.underruns = underruns;
    this.counters.overflows = overflows;
    this.counters.skips = skips;
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
    // L'ecran verrouille suit l'etat reel de la lecture, pas le dernier clic : une rebufferisation
    // ou une reconnexion doit s'y voir, sinon le telephone affiche « en lecture » sur du silence.
    this.background.setPlaying(status.playing);

    if (!status.playing) {
      this.audio.setPlaying(false);
    }

    // Le filet du processeur audio est place une marge au-dessus du seuil de vidage : le vidage
    // garde la main sur la derive ordinaire, avec son diagnostic et sa rebufferisation, et le filet
    // n'intervient que lorsqu'une rafale l'a distance. En sautant, il laisse de quoi jouer tout de
    // suite, sinon le saut se paierait d'un manque de donnees.
    //
    // La marge voulue est de deux fois `LATE_MARGIN_MS`, mais la file la tronque : avec trois
    // secondes de capacite, aucun profil n'atteint la borne des deux tiers. Les valeurs reellement
    // appliquees sont donc celles-ci, et le `Math.min` est ce qui decide, pas l'addition :
    //
    //   Faible 200 ms     vidage a 1200 ms, filet a 2000 ms, marge 800 ms
    //   Equilibree 400 ms vidage a 1400 ms, filet a 2000 ms, marge 600 ms
    //   Stable 800 ms     vidage a 1800 ms, filet a 2000 ms, marge 200 ms
    //
    // L'ordre voulu tient partout — le filet reste au-dessus du vidage — mais la marge de Stable est
    // mince : une rafale y sera parfois rattrapee par le filet sans que la machine d'etats l'ait vue
    // passer. Ce n'est pas une perte de service, la file redescend exactement au seuil de lecture et
    // le son continue ; c'est un saut que seul le compteur `skips` raconte. Agrandir la file
    // rendrait la marge complete, au prix d'une mesure de charge reelle a refaire.
    const target = this.machine.targetBufferMs();
    this.audio.setLimit(Math.min(target + 2 * LATE_MARGIN_MS, NET_CEILING_MAX_MS), target);

    this.audio.setAccepting(status.accepting);
    this.audio.applyFlush(status.flushId);

    if (status.playing) {
      this.audio.setPlaying(true);
    }
  }
}
