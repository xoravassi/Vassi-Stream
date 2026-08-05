import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlayer } from "../src/player/audio-player.ts";
import {
  BackgroundAudio,
  WAKE_RETRY_DELAYS_MS,
  type BackgroundAudioDeps,
  type MediaSessionLike,
  type PageLike,
} from "../src/player/background-audio.ts";
import { FakeAudioContext, installBrowserFakes } from "./browser-fakes.ts";
import { startLive, startRelay, waitFor } from "./relay-harness.ts";

// Ces tests portent sur ce que la page fait quand l'auditeur range son telephone.
//
// Ils ne prouvent pas que le son survit a un ecran verrouille : aucune page web ne peut le garantir,
// parce que l'etat `interrupted` d'iOS est par definition hors du controle de la page. Ils prouvent
// les trois choses qui sont, elles, du ressort de la page : l'intention audio est declaree, les
// commandes de l'ecran verrouille sont posees et suivent l'etat reel, et le son revient au retour au
// premier plan sans que personne ne recharge quoi que ce soit.

// Cette classe imite `navigator.mediaSession` et retient ce qu'on lui pose.
class FakeMediaSession implements MediaSessionLike {
  metadata: unknown = null;
  playbackState = "none";
  readonly handlers = new Map<string, (() => void) | null>();
  // Ces actions sont refusees, comme le fait un navigateur qui ne connait pas l'action demandee.
  refuse = new Set<string>();

  setActionHandler(action: string, handler: (() => void) | null): void {
    if (this.refuse.has(action)) {
      throw new Error("unsupported_action");
    }

    this.handlers.set(action, handler);
  }

  // Cette methode imite le clic sur un bouton de l'ecran verrouille.
  press(action: string): void {
    this.handlers.get(action)?.();
  }
}

// Cette classe imite le document : la page est visible ou cachee, et le dit quand cela change.
class FakePage implements PageLike {
  hidden = false;
  private listeners: (() => void)[] = [];

  addEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") {
      this.listeners.push(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "visibilitychange") {
      this.listeners = this.listeners.filter((known) => known !== listener);
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }

  // Cette methode imite un passage en arriere-plan ou un retour au premier plan.
  setHidden(hidden: boolean): void {
    this.hidden = hidden;

    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

// Cette classe remplace les minuteurs : les tests ne peuvent pas attendre trois secondes.
class FakeClock {
  private pending = new Map<number, () => void>();
  private next = 1;

  readonly setTimer = (callback: () => void, _delayMs: number): number => {
    const handle = this.next;
    this.next += 1;
    this.pending.set(handle, callback);
    return handle;
  };

  readonly clearTimer = (handle: number): void => {
    this.pending.delete(handle);
  };

  get waiting(): number {
    return this.pending.size;
  }

  // Cette methode declenche toutes les tentatives en attente, dans leur ordre de programmation.
  runAll(): void {
    const due = [...this.pending.entries()].sort((a, b) => a[0] - b[0]);
    this.pending.clear();

    for (const [, callback] of due) {
      callback();
    }
  }
}

// Ce type regroupe tout ce qu'un test observe.
type Harness = {
  background: BackgroundAudio;
  media: FakeMediaSession;
  page: FakePage;
  clock: FakeClock;
  session: { type: string };
  wakes: () => number;
  plays: () => number;
  pauses: () => number;
  setAwake: (awake: boolean) => void;
};

// Cette fonction monte le module avec des pieces fausses et rien du navigateur.
function harness(options: { withMediaSession?: boolean; withAudioSession?: boolean } = {}): Harness {
  const media = new FakeMediaSession();
  const page = new FakePage();
  const clock = new FakeClock();
  const session = { type: "auto" };

  let wakes = 0;
  let plays = 0;
  let pauses = 0;
  let awake = true;

  const deps: Partial<BackgroundAudioDeps> = {
    audioSession: options.withAudioSession === false ? null : session,
    mediaSession: options.withMediaSession === false ? null : media,
    createMetadata: (values) => ({ ...values }),
    page,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };

  const background = new BackgroundAudio(
    {
      onWake: () => {
        wakes += 1;
      },
      isAwake: () => awake,
      onPlay: () => {
        plays += 1;
      },
      onPause: () => {
        pauses += 1;
      },
    },
    { title: "Direct", artist: "Session" },
    deps,
  );

  return {
    background,
    media,
    page,
    clock,
    session,
    wakes: () => wakes,
    plays: () => plays,
    pauses: () => pauses,
    setAwake: (value: boolean) => {
      awake = value;
    },
  };
}

// Ce test verifie la declaration d'intention audio.
//
// C'est la ligne qui, sur iOS, distingue un son que le bouton silencieux du telephone coupe d'un son
// qu'il laisse passer. Un auditeur qui n'entend rien alors que la page affiche « Lecture » est le
// defaut le plus deroutant possible, et il n'a aucune cause visible.
test("declare que la page joue un media", () => {
  const kit = harness();

  assert.equal(kit.session.type, "auto");

  kit.background.start();

  assert.equal(kit.session.type, "playback");
});

// Ce test verifie que les commandes de l'ecran verrouille sont posees avec un titre.
test("pose le titre et les deux boutons de l'ecran verrouille", () => {
  const kit = harness();

  kit.background.start();

  assert.deepEqual(kit.media.metadata, { title: "Direct", artist: "Session" });
  assert.ok(kit.media.handlers.get("play"));
  assert.ok(kit.media.handlers.get("pause"));
});

// Ce test verifie que les boutons du systeme mènent aux memes actions que celles de la page.
test("les boutons du systeme lancent et arretent la lecture", () => {
  const kit = harness();

  kit.background.start();
  kit.media.press("play");
  kit.media.press("pause");

  assert.equal(kit.plays(), 1);
  assert.equal(kit.pauses(), 1);
});

// Ce test verifie que l'ecran verrouille suit l'etat reel de la lecture.
//
// L'etat vient de la machine d'etats, pas du dernier clic : une rebufferisation ou une reconnexion
// doit s'y voir, sinon le telephone affiche « en lecture » sur du silence.
test("l'ecran verrouille suit l'etat reel de la lecture", () => {
  const kit = harness();

  kit.background.start();

  kit.background.setPlaying(true);
  assert.equal(kit.media.playbackState, "playing");

  kit.background.setPlaying(false);
  assert.equal(kit.media.playbackState, "paused");
});

// Ce test verifie le coeur du correctif : le son revient au retour au premier plan.
//
// Une reprise demandee pendant que la page est cachee est refusee par le navigateur ; celle qui
// compte est celle du retour. Sans elle, l'auditeur qui rallume son telephone trouve une page muette
// qu'il faut recharger.
test("demande la reprise au retour au premier plan", () => {
  const kit = harness();

  kit.background.start();
  kit.setAwake(false);

  kit.page.setHidden(true);
  kit.clock.runAll();
  assert.equal(kit.wakes(), 0, "rien ne doit etre tente pendant que la page est cachee");

  kit.page.setHidden(false);
  kit.clock.runAll();

  assert.equal(kit.wakes(), WAKE_RETRY_DELAYS_MS.length, "chaque palier doit avoir tente une reprise");
});

// Ce test verifie que les tentatives s'arretent des que le son est revenu.
test("cesse de demander la reprise quand le son est revenu", () => {
  const kit = harness();

  kit.background.start();
  kit.setAwake(true);

  kit.page.setHidden(false);
  kit.clock.runAll();

  assert.equal(kit.wakes(), 0);
});

// Ce test verifie que deux bascules rapprochees ne superposent pas deux series de tentatives.
test("oublie les reprises en attente a chaque changement de visibilite", () => {
  const kit = harness();

  kit.background.start();
  kit.setAwake(false);

  kit.page.setHidden(false);
  assert.equal(kit.clock.waiting, WAKE_RETRY_DELAYS_MS.length);

  kit.page.setHidden(true);
  assert.equal(kit.clock.waiting, 0, "le passage en arriere-plan doit annuler les tentatives");

  kit.page.setHidden(false);
  assert.equal(kit.clock.waiting, WAKE_RETRY_DELAYS_MS.length, "une seule serie doit rester");
});

// Ce test verifie l'arret : plus rien ne doit reagir apres la fermeture de la page.
test("rend la page au systeme a l'arret", () => {
  const kit = harness();

  kit.background.start();
  kit.background.setPlaying(true);
  kit.background.stop();

  assert.equal(kit.page.listenerCount, 0, "la surveillance de la visibilite doit etre retiree");
  assert.equal(kit.media.playbackState, "none");
  assert.equal(kit.media.metadata, null);
  assert.equal(kit.media.handlers.get("play"), null);
  assert.equal(kit.media.handlers.get("pause"), null);

  kit.setAwake(false);
  kit.page.setHidden(false);
  kit.clock.runAll();

  assert.equal(kit.wakes(), 0, "une page fermee ne demande plus rien");
});

// Ce test verifie qu'un navigateur sans aucune de ces interfaces se comporte comme avant.
//
// C'est la garantie qui compte le plus : ce module est un ajout, et un ajout ne doit rien couter a
// la lecture qui fonctionne deja sur ordinateur.
test("reste sans effet dans un navigateur qui n'offre aucune de ces interfaces", () => {
  const kit = harness({ withMediaSession: false, withAudioSession: false });

  assert.doesNotThrow(() => {
    kit.background.start();
    kit.background.setPlaying(true);
    kit.background.stop();
  });
});

// Ce test verifie qu'une action refusee par le navigateur n'empeche pas les autres d'etre posees.
// La specification demande de lever une exception pour une action inconnue.
test("garde les commandes acceptees quand une action est refusee", () => {
  const kit = harness();
  kit.media.refuse.add("play");

  assert.doesNotThrow(() => kit.background.start());
  assert.ok(kit.media.handlers.get("pause"));
});

// Ce test verifie qu'un second demarrage ne double ni les gestionnaires ni la surveillance.
test("ne pose ses commandes qu'une fois", () => {
  const kit = harness();

  kit.background.start();
  kit.background.start();

  assert.equal(kit.page.listenerCount, 1);
});

// Ce test verifie le chemin complet, avec le vrai relais et le vrai assemblage du player.
//
// Les tests precedents portent sur le module seul. Celui-ci verifie les fils : que le player declare
// bien l'intention audio au premier clic, qu'il annonce l'etat de lecture au systeme, et surtout que
// le retour au premier plan atteint reellement le contexte audio. C'est ce dernier fil qui repare la
// panne — un module correct branche sur rien ne ramenerait aucun son.
test("le player reprend le son au retour au premier plan", async (t) => {
  const restore = installBrowserFakes({ isolated: true });
  const relay = await startRelay();
  await startLive(relay, 4242);

  const media = new FakeMediaSession();
  const page = new FakePage();
  const clock = new FakeClock();
  const session = { type: "auto" };

  const player = new AudioPlayer(
    {
      relayUrl: relay.listenerUrl,
      createWorker: () => new Worker("/decode-worker.js", { type: "module" }),
      workletUrl: "/pcm-worklet.js",
      title: { title: "Direct", artist: "Session" },
    },
    () => {},
    {
      background: {
        audioSession: session,
        mediaSession: media,
        createMetadata: (values) => ({ ...values }),
        page,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    },
  );

  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  player.connect();
  await waitFor(() => player.status().state === "READY", "direct annonce a la page");

  await player.play();

  assert.equal(session.type, "playback", "le premier clic doit declarer l'intention audio");
  assert.deepEqual(media.metadata, { title: "Direct", artist: "Session" });

  const context = FakeAudioContext.last;
  assert.ok(context, "le contexte audio doit exister");

  // Le telephone passe en veille : Safari annonce `interrupted`, les autres `suspended`.
  const resumesBefore = context.resumes;
  page.hidden = true;
  context.interrupt("interrupted");

  // Le retour au premier plan est le seul moment ou une reprise est acceptee.
  page.setHidden(false);
  clock.runAll();

  assert.ok(context.resumes > resumesBefore, "le retour doit demander la reprise du contexte");
  assert.equal(context.state, "running", "le son doit etre revenu");
});
