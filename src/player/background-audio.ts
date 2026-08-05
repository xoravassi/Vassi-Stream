// Ce module traite un seul probleme : ce qui arrive au son quand l'auditeur range son telephone.
//
// Il faut d'abord dire ce qui n'est pas possible, parce que cela decide de tout le reste.
//
// **Aucune page web ne peut garder un AudioWorklet en marche sur un iPhone dont l'ecran est
// verrouille.** Quand la page passe en arriere-plan, iOS Safari met le contexte audio dans l'etat
// `interrupted`, et la definition meme de cet etat est que la page n'a pas la main : « the audio
// context was paused in response to an interruption outside the control of the web app. In this
// case, the browser decides when to pause and unpause the app. » Android Chrome suspend de meme un
// contexte dont l'onglet est cache, et ce que le navigateur laisse tourner ensuite depend du
// reglage de batterie de l'application, pas de la page.
//
// Deux contournements circulent et aucun ne tient ici. Faire sortir le son par un
// `MediaStreamAudioDestinationNode` branche sur un element `<audio>` donne un resultat different
// dans chaque navigateur — Chromium declenche les evenements de lecture mais `currentTime` n'avance
// pas — et la specification ne dit pas ce qui devrait se passer. Le fichier muet joue en boucle,
// lui, ne marche plus depuis plusieurs versions de Safari mobile. Les batir dans le chemin audio
// couterait la lecture qui fonctionne aujourd'hui sur ordinateur pour un gain incertain sur
// telephone.
//
// Ce module fait donc les trois choses qui, elles, sont possibles et documentees :
//
// 1. **Declarer l'intention audio de la page.** `navigator.audioSession.type = "playback"` dit au
//    systeme que cette page joue un media. Sur iOS, c'est ce qui distingue un son que le bouton
//    silencieux du telephone coupe d'un son qu'il laisse passer — un auditeur qui n'entend rien
//    alors que tout fonctionne est le defaut le plus deroutant de la page.
// 2. **Poser les commandes de l'ecran verrouille.** `navigator.mediaSession` donne le titre, l'etat
//    de lecture et les boutons Lecture et Pause. Sur Android, c'est aussi ce qui fait entrer la page
//    dans la liste des lectures en cours du systeme.
// 3. **Reprendre des le retour au premier plan.** Une reprise demandee pendant que la page est
//    cachee est refusee ; celle qui compte est celle du retour. Le son revient alors tout de suite,
//    au direct, au lieu de laisser une page muette qu'il faut recharger.
//
// Rien ici n'est indispensable au fonctionnement : chaque interface est verifiee avant usage, et un
// navigateur qui n'en a aucune se comporte exactement comme avant.

// Ce type decrit ce que le module demande au moteur audio. Il ne touche jamais au contexte
// lui-meme : il dit quand reprendre, et le moteur sait comment.
export type BackgroundAudioEvents = {
  // Ce rappel demande une reprise du contexte audio.
  onWake: () => void;
  // Ce rappel dit si le son tourne de nouveau. Il arrete les tentatives de reprise.
  isAwake: () => boolean;
  // Ces deux rappels repondent aux boutons de l'ecran verrouille.
  onPlay: () => void;
  onPause: () => void;
};

// Ce type decrit ce que la page affiche sur l'ecran verrouille et dans la liste des lectures en
// cours du systeme.
export type BackgroundAudioTitle = {
  title: string;
  artist: string;
};

// Ces delais espacent les tentatives de reprise apres un retour au premier plan. La premiere part
// tout de suite ; les suivantes couvrent le cas d'un systeme qui rend la sortie audio avec un
// instant de retard, ce qui arrive quand l'interruption venait d'un appel telephonique.
export const WAKE_RETRY_DELAYS_MS = [0, 250, 1000, 3000];

// Ce type decrit les pieces du navigateur utilisees, pour que les tests n'aient besoin d'aucune.
export type BackgroundAudioDeps = {
  audioSession: { type: string } | null;
  mediaSession: MediaSessionLike | null;
  createMetadata: ((values: BackgroundAudioTitle) => unknown) | null;
  page: PageLike | null;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
};

// Ce type decrit la partie de `navigator.mediaSession` utilisee ici.
export type MediaSessionLike = {
  metadata: unknown;
  playbackState: string;
  setActionHandler: (action: string, handler: (() => void) | null) => void;
};

// Ce type decrit la partie du document utilisee ici : savoir si la page est visible, et l'apprendre
// quand cela change.
export type PageLike = {
  hidden: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

// Cette fonction lit les pieces reellement offertes par le navigateur. Chacune peut manquer :
// `audioSession` n'existe aujourd'hui que dans Safari, `mediaSession` manque encore par endroits, et
// aucune des deux n'existe sous Node.
export function browserDeps(): BackgroundAudioDeps {
  const browser = globalThis as unknown as {
    navigator?: { audioSession?: { type: string }; mediaSession?: MediaSessionLike };
    document?: PageLike;
    MediaMetadata?: new (values: BackgroundAudioTitle) => unknown;
  };

  const MetadataClass = browser.MediaMetadata;

  return {
    audioSession: browser.navigator?.audioSession ?? null,
    mediaSession: browser.navigator?.mediaSession ?? null,
    createMetadata: MetadataClass === undefined ? null : (values) => new MetadataClass(values),
    page: browser.document ?? null,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
  };
}

// Cette classe tient tout ce qui touche a la mise en arriere-plan de la page.
export class BackgroundAudio {
  private events: BackgroundAudioEvents;
  private deps: BackgroundAudioDeps;
  private title: BackgroundAudioTitle;
  private started = false;
  private wakeTimers: number[] = [];

  // Cette fonction est gardee telle quelle : `removeEventListener` ne retire que la fonction qu'il
  // a recue, et une fonction recreee a l'arret ne retirerait rien.
  private onVisibilityChange = (): void => this.handleVisibility();

  constructor(
    events: BackgroundAudioEvents,
    title: BackgroundAudioTitle,
    deps: Partial<BackgroundAudioDeps> = {},
  ) {
    const found = browserDeps();

    this.events = events;
    this.title = title;
    this.deps = {
      audioSession: deps.audioSession !== undefined ? deps.audioSession : found.audioSession,
      mediaSession: deps.mediaSession !== undefined ? deps.mediaSession : found.mediaSession,
      createMetadata: deps.createMetadata !== undefined ? deps.createMetadata : found.createMetadata,
      page: deps.page !== undefined ? deps.page : found.page,
      setTimer: deps.setTimer ?? found.setTimer,
      clearTimer: deps.clearTimer ?? found.clearTimer,
    };
  }

  // Cette methode s'appelle au premier clic sur Lecture, avant la creation du contexte audio.
  //
  // L'ordre compte pour le type de session audio : il decrit ce que la page va jouer, et le systeme
  // le lit au moment ou le son commence.
  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.declareIntent();
    this.installControls();
    this.deps.page?.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  // Cette methode remet la page dans l'etat d'avant : plus de commandes systeme, plus de surveillance
  // de la visibilite, plus de reprise en attente.
  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.cancelWake();
    this.deps.page?.removeEventListener("visibilitychange", this.onVisibilityChange);

    const media = this.deps.mediaSession;

    if (media !== null) {
      this.setHandler(media, "play", null);
      this.setHandler(media, "pause", null);
      media.playbackState = "none";
      media.metadata = null;
    }
  }

  // Cette methode annonce au systeme si le son joue. C'est ce que l'ecran verrouille affiche, et ce
  // qui decide du bouton montre : Lecture ou Pause.
  setPlaying(playing: boolean): void {
    const media = this.deps.mediaSession;

    if (media === null || !this.started) {
      return;
    }

    try {
      media.playbackState = playing ? "playing" : "paused";
    } catch {
      // Un navigateur qui refuse cette valeur ne doit pas arreter la lecture pour autant.
    }
  }

  // Cette methode declare que la page joue un media.
  //
  // Sur iOS, un son emis par Web Audio est coupe par le bouton silencieux du telephone, alors qu'un
  // media ne l'est pas. Ce type de session est la maniere prevue de le dire. L'interface n'existe
  // aujourd'hui que dans Safari, ce qui est exactement le navigateur ou le probleme se pose.
  private declareIntent(): void {
    const session = this.deps.audioSession;

    if (session === null) {
      return;
    }

    try {
      session.type = "playback";
    } catch {
      // Une valeur refusee laisse le comportement par defaut, qui est celui d'aujourd'hui.
    }
  }

  // Cette methode pose le titre et les deux boutons de l'ecran verrouille.
  private installControls(): void {
    const media = this.deps.mediaSession;

    if (media === null) {
      return;
    }

    const createMetadata = this.deps.createMetadata;

    if (createMetadata !== null) {
      try {
        media.metadata = createMetadata(this.title);
      } catch {
        // Sans titre, les commandes fonctionnent quand meme.
      }
    }

    this.setHandler(media, "play", () => this.events.onPlay());
    this.setHandler(media, "pause", () => this.events.onPause());
  }

  // Cette methode pose un gestionnaire d'action sans laisser un navigateur qui ignore cette action
  // arreter le reste. La specification demande de lever une exception pour une action inconnue.
  private setHandler(media: MediaSessionLike, action: string, handler: (() => void) | null): void {
    try {
      media.setActionHandler(action, handler);
    } catch {
      // Cette action n'existe pas dans ce navigateur : les autres restent posees.
    }
  }

  // Cette methode traite un changement de visibilite de la page.
  //
  // Le passage en arriere-plan n'a rien a declencher : le systeme a deja repris la sortie audio, et
  // le moteur cesse tout seul de remplir sa file des que le contexte s'arrete. C'est le retour qui
  // demande un geste, parce qu'une reprise n'est acceptee que la.
  private handleVisibility(): void {
    this.cancelWake();

    if (this.deps.page?.hidden !== false) {
      return;
    }

    for (const delay of WAKE_RETRY_DELAYS_MS) {
      this.wakeTimers.push(this.deps.setTimer(() => this.tryWake(), delay));
    }
  }

  // Cette methode demande une reprise, sauf si le son est deja revenu.
  private tryWake(): void {
    if (!this.started || this.events.isAwake()) {
      return;
    }

    this.events.onWake();
  }

  // Cette methode annule les reprises encore en attente. Sans elle, deux bascules rapprochees
  // laisseraient deux series de tentatives se superposer.
  private cancelWake(): void {
    for (const handle of this.wakeTimers) {
      this.deps.clearTimer(handle);
    }

    this.wakeTimers = [];
  }
}
