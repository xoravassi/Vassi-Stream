import { BackgroundAudio, type BackgroundAudioDeps, type BackgroundAudioTitle } from "./background-audio.ts";
import { BufferTarget } from "./buffer-target.ts";
import { BrowserAudio, type PcmLevel } from "./browser-audio.ts";
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
    // Octets audio recus du relais. Compte avec les paquets, il donne le debit reellement porte par
    // le lien — la seule mesure qui vienne du bout de la chaine, apres tout ce qui a pu se produire
    // en amont. Le debit annonce par la session, lui, n'est qu'un plafond.
    bytes: 0,
    accepted: 0,
    decoded: 0,
    refused: 0,
    discontinuities: 0,
    concealedMs: 0,
    underruns: 0,
    overflows: 0,
    skips: 0,
    trims: 0,
  };
  // Vitesse de consommation appliquee par le processeur audio au dernier releve.
  private ratio = 1;
  // Ce regulateur decide du seuil de bufferisation a partir des blocages d'arrivee reellement
  // observes. Le profil choisi par l'auditeur lui sert de plancher.
  private bufferTarget = new BufferTarget();
  private lastRefusal: string | null = null;
  // Ce dernier trou dit ou le son a disparu : sur le poste Ableton, ou entre le relais et cet
  // auditeur. Le compteur de discontinuites, lui, dit seulement combien il y en a eu.
  private lastGap: { reason: string; missingMs: number; recovered: boolean } | null = null;
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
      onLevel: (level) => this.handleLevel(level),
      // Un trou comble sur place n'interrompt pas la lecture : le decodeur a ecrit la duree
      // manquante dans la file, la chronologie est juste, et rebufferiser ne ferait qu'ajouter du
      // silence a un trou deja passe. Seul un trou trop grand pour etre comble fait repartir la
      // bufferisation, parce que la file a alors ete jetee.
      onDiscontinuity: (note) => {
        this.lastGap = note;

        if (!note.recovered) {
          this.machine.discontinuity();
        }
      },
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
        this.counters.concealedMs = stats.concealedMs;
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
      sessionBitrate: status.session === null ? null : status.session.bitrate,
      targetBufferMs: this.machine.targetBufferMs(),
      stallMs: this.bufferTarget.stallMs,
      shared: this.audio.shared,

      connected: this.socket.connected,
      packets: this.counters.packets,
      bytes: this.counters.bytes,
      sincePacketMs: this.lastPacketAt === null ? null : at - this.lastPacketAt,
      sinceLiveMs: this.liveSince === null ? null : at - this.liveSince,

      accepted: this.counters.accepted,
      decoded: this.counters.decoded,
      refused: this.counters.refused,
      lastRefusal: this.lastRefusal,
      discontinuities: this.counters.discontinuities,
      concealedMs: this.counters.concealedMs,
      lastGapReason: this.lastGap === null ? null : this.lastGap.reason,
      lastGapMs: this.lastGap === null ? null : this.lastGap.missingMs,

      audio: this.audio.stage,
      contextState: this.audio.contextState,
      baseLatencyMs: this.audio.baseLatencyMs,
      outputLatencyMs: this.audio.outputLatencyMs,
      bufferedMs: this.bufferMs,
      underruns: this.counters.underruns,
      overflows: this.counters.overflows,
      skips: this.counters.skips,
      trims: this.counters.trims,
      ratio: this.ratio,
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
  private handleLevel(level: PcmLevel): void {
    const at = this.now();

    this.bufferMs = level.availableMs;
    this.counters.overflows = level.overflows;
    this.counters.skips = level.skips;
    this.counters.trims = level.trims;
    this.ratio = level.ratio;

    // Le niveau part au regulateur avant toute decision : c'est lui qui ouvre ou ferme la porte de
    // decroissance du seuil, et une decision prise sur le niveau du releve precedent serait fausse
    // d'un tour au moment ou elle compte le plus.
    this.bufferTarget.noteLevel(level.availableMs);

    // Un manque de donnees prouve que le seuil courant etait trop court. C'est la mesure la plus
    // directe dont le regulateur dispose, et elle prime sur ce que les blocages d'arrivee laissaient
    // prevoir.
    if (level.underruns > this.counters.underruns) {
      this.bufferTarget.noteUnderrun(at);
    }

    this.counters.underruns = level.underruns;
    // Cette date est la preuve que le thread audio tourne encore. Un contexte suspendu cesse
    // d'appeler le processeur, donc plus aucun niveau n'arrive.
    this.lastLevelAt = at;
    this.applyBufferTarget(at);
    this.machine.reportLevel(level.availableMs, level.underruns);
  }

  // Cette methode transmet le seuil decide par le regulateur, quand il a bouge.
  //
  // Le seuil ne circule pas tout seul : il decide de la reprise dans la machine d'etats, du plafond
  // du filet et du niveau vise par le regulateur de vitesse. Les trois se recalculent donc ensemble,
  // et seulement lorsqu'il change vraiment — le pas de quantification du regulateur fait que cela
  // n'arrive qu'une fois toutes les quelques secondes, au pire.
  private applyBufferTarget(at: number): void {
    const target = this.bufferTarget.targetMs(at);

    if (target === this.machine.targetBufferMs()) {
      return;
    }

    this.machine.setTargetBufferMs(target);
    this.applyCommands(this.machine.status());
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
    // L'ecart entre deux arrivees est le signal du regulateur de seuil. Il est releve ici, au plus
    // pres du reseau : tout ce qui vient apres — decodage, file, thread audio — a sa propre gigue et
    // brouillerait la mesure.
    this.bufferTarget.notePacket(this.now());
    // La taille est lue avant le transfert au worker : un `ArrayBuffer` transfere est vide pour son
    // ancien proprietaire, et sa longueur y retombe a zero.
    this.counters.bytes += packet.byteLength;
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
    // Le regulateur repart de zero et reprend le profil du nouveau direct comme plancher. Le seuil
    // adaptatif est efface dans le meme geste : sans cela, la machine d'etats garderait celui du
    // direct precedent jusqu'au premier releve du processeur audio.
    this.bufferTarget.reset(session === null ? 400 : session.targetBufferMs);
    this.machine.setTargetBufferMs(null);
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
    // La marge voulue est de deux fois `LATE_MARGIN_MS`, et la borne des deux tiers de la file
    // (`NET_CEILING_MAX_MS`, 4000 ms) la tronque au-dela d'un seuil de 2000 ms. Le seuil n'etant
    // jamais superieur a 2000 (`MAX_TARGET_MS`), les valeurs appliquees sont donc :
    //
    //   plancher Faible 200 ms      vidage a 1200 ms, filet a 2200 ms
    //   plancher Equilibree 400 ms  vidage a 1400 ms, filet a 2400 ms
    //   plancher Stable 800 ms      vidage a 1800 ms, filet a 2800 ms
    //   seuil adaptatif max 2000 ms vidage a 3000 ms, filet a 4000 ms
    //
    // L'ordre voulu tient sur toute la plage — le filet reste mille millisecondes au-dessus du
    // vidage — et c'est ce qui a impose de porter la file a six secondes. Avec quatre secondes le
    // filet plafonnait a 2666 ms : des que le seuil adaptatif depassait 1666 ms, le vidage se
    // retrouvait au-dessus de lui et devenait inatteignable. Le journal du 6 aout 2026 a 23h18 le
    // montre, trois sauts du filet et pas un seul vidage.
    const target = this.machine.targetBufferMs();
    this.audio.setLimit(Math.min(target + 2 * LATE_MARGIN_MS, NET_CEILING_MAX_MS), target);

    this.audio.setAccepting(status.accepting);
    this.audio.applyFlush(status.flushId);

    if (status.playing) {
      this.audio.setPlaying(true);
    }
  }
}
