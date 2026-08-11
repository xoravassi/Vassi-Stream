// Banc de rejeu de la continuite du direct.
//
// Il existe pour une raison precise : chaque reglage de la chaine se validait jusqu'ici en rejouant
// un cours de 41 minutes, ce qui coute une soiree et ne se repete pas. Ce banc pousse un profil de
// production a travers `SourceClock`, le decodeur, la file PCM, le regulateur de vitesse, le
// regulateur de seuil et la machine d'etats, avec une horloge injectee. Une execution tient en
// quelques secondes.
//
// Il ne remplace pas l'essai reel : il ne connait ni le VPN, ni le navigateur, ni le Meet, ni Opus.
// Il sert a trier les hypotheses avant de payer un essai.
//
//   node scripts/bench-continuite.mjs            toutes les sections
//   node scripts/bench-continuite.mjs arrets     une seule section
//
// Sections : regime, arrets, veille, horloge, clic

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(pathToFileURL(path.join(root, "device/node/")).href);
const { SourceClock } = require(path.join(root, "device/node/source-clock.js"));
const { BufferTarget } = await import(pathToFileURL(path.join(root, "src/player/buffer-target.ts")).href);
const { PlayerStateMachine } = await import(pathToFileURL(path.join(root, "src/player/player-state.ts")).href);

// Ces constantes sont recopiees plutot qu'importees : `pcm-worklet.js` et `decode-worker.js`
// dependent l'un d'`AudioWorkletProcessor`, l'autre du WASM d'Opus, et aucun des deux ne se charge
// sous Node. Le banc rejoue leur arithmetique, pas leur code.
const FRAME_US = 40000n;
const FRAME_MS = 40;
const MAX_CONCEAL_US = 500000n;   // decode-worker.js
const RATE_MAX = 0.005;           // pcm-worklet.js
const RATE_DEADBAND_MS = 150;
const RATE_SPAN_MS = 500;
const BLOCK_MS = 128000 / 48000;  // un bloc du worklet
const REPORT_EVERY_BLOCKS = 16;
const CAPACITY_MS = 6000;         // PCM_CAPACITY_FRAMES
const LATE_MARGIN_MS = 1000;      // player-state.ts

const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// ---------------------------------------------------------------------------
// Le profil de production reproduit la correlation charge x debit relevee le 11 aout 2026 :
// -0,755 sur 126 releves, 24,94 tr/s machine au repos, 21,5 au-dela de 80 % de processeur, creux
// mesures a 16,4. La moyenne rendue est 24,08 tr/s, celle du cours.
function productionProfile(seconds, seed = 1) {
  const rnd = rng(seed);
  const segments = [];
  let t = 0;

  while (t < seconds) {
    const r = rnd();
    let fps, duration;

    if (r < 0.55) { fps = 24.94; duration = 8 + rnd() * 25; }
    else if (r < 0.85) { fps = 23.2; duration = 5 + rnd() * 20; }
    else if (r < 0.96) { fps = 21.5; duration = 5 + rnd() * 15; }
    else { fps = 16.4; duration = 10 + rnd() * 40; }

    segments.push({ fps, seconds: Math.min(duration, seconds - t) });
    t += duration;
  }

  return segments;
}

// Cette fonction rend la suite des trames produites : leur timestamp audio, et l'heure reelle de
// leur arrivee. Tout le sujet tient dans l'ecart entre les deux.
function framesOf(segments) {
  const out = [];
  let ts = 0n;
  let at = 0;

  for (const segment of segments) {
    const count = Math.round(segment.fps * segment.seconds);
    const step = 1000 / segment.fps;

    for (let i = 0; i < count; i++) {
      out.push({ ts, at });
      ts += FRAME_US;
      at += step;
    }
  }

  return out;
}

// Cette fonction insere des arrets francs : la production s'arrete net, le temps continue. C'est ce
// que fait un blocage du moteur audio, par opposition a une baisse de cadence.
function withStalls(frames, stalls, seed = 99) {
  const rnd = rng(seed);
  const out = frames.map((f) => ({ ...f }));

  for (const { everyS, ms } of stalls) {
    let next = everyS * 1000 * rnd();
    let shift = 0;

    for (const frame of out) {
      if (frame.at + shift >= next) {
        shift += ms;
        next = frame.at + shift + everyS * 1000 * (0.5 + rnd());
      }
      frame.at += shift;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cette fonction rejoue `SourceClock.note` avec un plafond de pas configurable.
//
// Elle duplique volontairement l'algorithme du module : c'est ce qui permet de comparer un reglage
// candidat au code en place dans la meme execution, sans toucher au device. Toute divergence avec
// `source-clock.js` invaliderait le banc — la section « horloge » compare les deux.
//
// `mode` :
//   "avant"    l'etat d'avant le 11 aout 2026 : tout pas etait borne a 5 s, y compris une veille
//   "borne"    pas ordinaire borne a `capUs`, mais la veille reste bornee elle aussi
//   "actuel"   le code en place : pas borne a `capUs`, et un seul saut au-dela de `jumpUs`
function note(clock, timestampMicros, atMs, mode, capUs = 400000n, jumpUs = 5000000n, windowMs = 2000) {
  if (clock.baseTimestamp === null) {
    clock.baseTimestamp = timestampMicros;
    clock.baseAt = atMs;
    return clock.shiftMicros;
  }

  const audio = timestampMicros - clock.baseTimestamp;
  const elapsed = BigInt(Math.round((atMs - clock.baseAt) * 1000));

  if (elapsed < 0n) {
    clock.samples.length = 0;
    return clock.shiftMicros;
  }

  clock.audioMicros = audio;
  clock.elapsedMicros = elapsed;
  clock.samples.push({ at: atMs, rawLag: elapsed - audio });

  while (clock.samples.length > 1 && atMs - clock.samples[0].at > windowMs) {
    clock.samples.shift();
  }

  if (atMs - clock.baseAt < windowMs) {
    return clock.shiftMicros;
  }

  let smallest = clock.samples[0].rawLag;
  for (const sample of clock.samples) {
    if (sample.rawLag < smallest) smallest = sample.rawLag;
  }

  const lag = smallest - clock.shiftMicros;
  if (lag < FRAME_US) return clock.shiftMicros;

  const ceiling = mode === "avant" ? 5000000n : capUs;
  const wanted = mode === "actuel" && lag > jumpUs ? lag : (lag > ceiling ? ceiling : lag);
  const step = (wanted / FRAME_US) * FRAME_US;

  clock.shiftMicros += step;
  clock.declaredMicros += step;
  clock.gaps += 1;

  return clock.shiftMicros;
}

function consumptionRatio(availableMs, keepMs, proportional) {
  if (keepMs <= 0) return 1;

  const error = availableMs - keepMs;
  const deadband = proportional ? Math.min(RATE_DEADBAND_MS, keepMs * 0.15) : RATE_DEADBAND_MS;
  const span = proportional ? Math.min(RATE_SPAN_MS, keepMs * 0.5) : RATE_SPAN_MS;

  if (error > -deadband && error < deadband) return 1;

  const excess = error > 0 ? error - deadband : error + deadband;
  return 1 + RATE_MAX * Math.max(-1, Math.min(1, excess / span));
}

// ---------------------------------------------------------------------------
// Cette fonction rejoue une session complete et rend les chiffres du tableau de validation.
function simulate(frames, options = {}) {
  const {
    sourceClock = true,
    mode = "actuel",
    capUs = 400000n,
    concealCeilingUs = MAX_CONCEAL_US,
    proportionalDeadband = false,
    floorMs = 400,
    label = "",
  } = options;

  const clock = sourceClock ? new SourceClock() : null;
  const target = new BufferTarget(floorMs);
  let status = null;
  const machine = new PlayerStateMachine((next) => { status = next; });

  machine.setStream({
    live: true,
    session: { sessionId: 1, bitrate: 256000, latencyProfile: "balanced", targetBufferMs: floorMs },
  });
  machine.play();

  let ringMs = 0;
  let underruns = 0;
  let seenUnderruns = 0;
  let previousOut = null;
  let index = 0;
  let now = 0;
  let blocks = 0;
  let trimPending = false;
  let wasPlaying = true;

  const stats = {
    cuts: 0, decoderFlushes: 0, netTrims: 0,
    silenceMs: 0, concealedMs: 0, steps: [], targets: [], levels: [],
  };

  const end = frames.at(-1).at;

  while (now < end) {
    // Les trames dont l'heure est venue entrent dans le decodeur.
    while (index < frames.length && frames[index].at <= now) {
      const frame = frames[index++];
      const outTs = clock === null
        ? frame.ts
        : frame.ts + note(clock, frame.ts, frame.at, mode, capUs);

      target.notePacket(frame.at);

      if (previousOut !== null) {
        const advance = outTs - previousOut;
        const missing = advance > FRAME_US ? advance - FRAME_US : 0n;

        if (missing > 0n) {
          stats.steps.push(Number(missing) / 1000);

          if (missing > concealCeilingUs) {
            // decode-worker.js : au-dela du plafond, la file part et la lecture repart du direct.
            ringMs = 0;
            stats.decoderFlushes += 1;
            machine.discontinuity();
          } else {
            ringMs = Math.min(CAPACITY_MS, ringMs + Number(missing) / 1000);
            stats.concealedMs += Number(missing) / 1000;
          }
        }
      }

      previousOut = outTs;
      ringMs = Math.min(CAPACITY_MS, ringMs + FRAME_MS);
    }

    // Un bloc du processeur audio.
    const keepMs = machine.targetBufferMs();

    if (trimPending) {
      trimPending = false;
      if (ringMs > keepMs) ringMs = keepMs;
    }

    const ceilingMs = Math.min(keepMs + 2 * LATE_MARGIN_MS, 4000);
    if (ringMs > ceilingMs) {
      ringMs = keepMs;
      stats.netTrims += 1;
    }

    if (status?.playing) {
      const wanted = BLOCK_MS * consumptionRatio(ringMs, keepMs, proportionalDeadband);

      if (ringMs < wanted) {
        underruns += 1;
        stats.silenceMs += wanted - ringMs;
        ringMs = 0;
      } else {
        ringMs -= wanted;
      }
    } else {
      stats.silenceMs += BLOCK_MS;
    }

    blocks += 1;
    now += BLOCK_MS;

    // Le releve du processeur audio vers le thread principal.
    if (blocks % REPORT_EVERY_BLOCKS === 0) {
      target.noteLevel(ringMs);

      const wanted = target.targetMs(now);
      if (wanted !== machine.targetBufferMs()) machine.setTargetBufferMs(wanted);

      if (underruns > seenUnderruns) {
        target.noteUnderrun(now);
        seenUnderruns = underruns;
      }

      machine.reportLevel(ringMs, underruns);

      const playing = Boolean(status?.playing);
      if (playing !== wasPlaying) {
        if (playing) trimPending = true;
        else stats.cuts += 1;
        wasPlaying = playing;
      }

      stats.targets.push(machine.targetBufferMs());
      stats.levels.push(ringMs);
    }
  }

  return print(label, stats, now);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[sorted.length >> 1];
};

function print(label, stats, now) {
  const targetMedian = median(stats.targets);
  const levelMedian = median(stats.levels);

  console.log(
    `  ${label.padEnd(38)}` +
    ` coupures ${String(stats.cuts).padStart(4)}` +
    ` | vidages ${String(stats.decoderFlushes).padStart(4)}` +
    ` | silence ${(stats.silenceMs / 1000).toFixed(1).padStart(6)} s` +
    ` | seuil med ${String(targetMedian).padStart(4)} ms` +
    ` | niveau ${String(Math.round(levelMedian)).padStart(4)} ms`
  );

  return stats;
}

// ===========================================================================
const SESSION_SECONDS = 2460; // 41 min, la duree du cours du 11 aout
const sections = process.argv.slice(2);
const wants = (name) => sections.length === 0 || sections.includes(name);

const baseFrames = framesOf(productionProfile(SESSION_SECONDS));
const producedS = Number(baseFrames.at(-1).ts) / 1e6;
const realS = baseFrames.at(-1).at / 1000;

console.log(
  `Profil de production : ${baseFrames.length} trames, ` +
  `${(baseFrames.length / realS).toFixed(2)} tr/s, ` +
  `${(realS - producedS).toFixed(0)} s de son jamais produites en ${realS.toFixed(0)} s.\n`
);

// --- Regime permanent -------------------------------------------------------
// Repond a : la sous-production seule, sans arret franc, coupe-t-elle encore ?
if (wants("regime")) {
  console.log("### Regime permanent : sous-production lissee, aucun arret franc");
  simulate(baseFrames, { sourceClock: false, label: "sans horloge de source (11 aout)" });
  simulate(baseFrames, { mode: "avant", label: "avant le bornage du pas" });
  simulate(baseFrames, { mode: "actuel", label: "code actuel" });
  simulate(baseFrames, { mode: "actuel", proportionalDeadband: true, label: "+ zone morte proportionnelle" });
  simulate(baseFrames, { mode: "actuel", concealCeilingUs: 1500000n, label: "+ combler jusqu'a 1500 ms" });
  simulate(baseFrames, { mode: "actuel", floorMs: 200, label: "profil 200 ms, code actuel" });
  simulate(baseFrames, { mode: "actuel", floorMs: 200, proportionalDeadband: true, label: "profil 200 ms, zone morte prop." });
  console.log("");
}

// --- Arrets francs ----------------------------------------------------------
// Repond a : que se passe-t-il quand le moteur audio ne ralentit pas mais s'arrete ?
if (wants("arrets")) {
  const scenarios = [
    { name: "arrets de 600 ms toutes les 60 s", stalls: [{ everyS: 60, ms: 600 }] },
    { name: "arrets de 1 s toutes les 60 s", stalls: [{ everyS: 60, ms: 1000 }] },
    { name: "arrets de 2 s toutes les 120 s", stalls: [{ everyS: 120, ms: 2000 }] },
    { name: "arrets varies : 600 ms/30 s et 2 s/300 s", stalls: [{ everyS: 30, ms: 600 }, { everyS: 300, ms: 2000 }] },
  ];

  for (const scenario of scenarios) {
    const frames = withStalls(baseFrames, scenario.stalls);
    console.log(`### ${scenario.name}`);
    simulate(frames, { mode: "avant", label: "avant : pas borne a 5 s" });
    simulate(frames, { mode: "actuel", label: "code actuel : pas borne a 400 ms" });
    console.log("");
  }
}

// --- Veille -----------------------------------------------------------------
// Repond a : combien de vidages une sortie de veille coute-t-elle vraiment ?
if (wants("veille")) {
  console.log("### Sortie de veille : nombre de vidages du decodeur d'affilee");

  for (const sleepMs of [60000, 180000, 600000]) {
    for (const mode of ["avant", "actuel"]) {
      const frames = [];
      let ts = 0n;
      let at = 0;

      for (let i = 0; i < 25 * 120; i++) {
        frames.push({ ts, at: at + (i >= 750 ? sleepMs : 0) });
        ts += FRAME_US;
        at += 40;
      }

      const clock = new SourceClock();
      let previousOut = null;
      let flushes = 0;

      for (const frame of frames) {
        const out = frame.ts + note(clock, frame.ts, frame.at, mode);
        if (previousOut !== null && out - previousOut - FRAME_US > MAX_CONCEAL_US) flushes += 1;
        previousOut = out;
      }

      console.log(`  veille de ${String(sleepMs / 1000).padStart(3)} s, ${mode.padEnd(7)} -> ${flushes} vidage(s)`);
    }
  }
  console.log("");
}

// --- Horloge ----------------------------------------------------------------
// Repond a : quel pas un arret franc produit-il, et le banc dit-il la meme chose que le module ?
if (wants("horloge")) {
  console.log("### Pas declare pour un arret franc isole, et vidages qui en resultent");

  const hardStall = (stallMs) => {
    const out = [];
    let ts = 0n;
    let at = 0;

    for (let i = 0; i < 25 * 30; i++) {
      out.push({ ts, at: at + (i >= 250 ? stallMs : 0) });
      ts += FRAME_US;
      at += 40;
    }

    return out;
  };

  for (const mode of ["avant", "actuel"]) {
    console.log(`  -- ${mode === "avant" ? "avant : pas borne a 5 s" : "code actuel : pas borne a 400 ms"}`);

    for (const stallMs of [200, 400, 500, 600, 800, 1000, 2000, 5000]) {
      const clock = new SourceClock();
      const reference = new SourceClock();
      let previousOut = null;
      let flushes = 0;
      let steps = 0;
      let maxStep = 0;
      let diverged = false;

      for (const frame of hardStall(stallMs)) {
        const shift = note(clock, frame.ts, frame.at, mode);
        // Le module lui-meme, en parallele : le banc doit lui etre identique en mode "actuel".
        if (mode === "actuel" && reference.note(frame.ts, frame.at) !== shift) diverged = true;

        const out = frame.ts + shift;
        if (previousOut !== null) {
          const missing = out - previousOut - FRAME_US;
          if (missing > 0n) {
            steps += 1;
            maxStep = Math.max(maxStep, Number(missing) / 1000);
            if (missing > MAX_CONCEAL_US) flushes += 1;
          }
        }
        previousOut = out;
      }

      console.log(
        `     arret ${String(stallMs).padStart(4)} ms -> ${String(steps).padStart(2)} pas, ` +
        `max ${String(maxStep.toFixed(0)).padStart(4)} ms, ${flushes} vidage(s)` +
        (diverged ? "   *** BANC DIVERGENT DU MODULE ***" : "")
      );
    }
  }
  console.log("");
}

// --- Clic -------------------------------------------------------------------
// Repond a : un trou comble par du silence claque-t-il, et de combien un fondu le corrige-t-il ?
if (wants("clic")) {
  const SR = 48000;

  // Un accord de synthese, sans rien au-dessus de 880 Hz : tout ce qui apparait plus haut a ete
  // fabrique par la discontinuite. C'est la definition operatoire d'un clic.
  const tone = (count, offset = 0) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const t = (offset + i) / SR;
      out[i] = 0.35 * Math.sin(2 * Math.PI * 220 * t)
             + 0.25 * Math.sin(2 * Math.PI * 330 * t)
             + 0.20 * Math.sin(2 * Math.PI * 440 * t)
             + 0.10 * Math.sin(2 * Math.PI * 880 * t);
    }
    return out;
  };

  const outOfBandDb = (x) => {
    const n = x.length;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

    let inBand = 0;
    let outBand = 0;

    for (let k = 1; k < n / 2; k++) {
      let re = 0;
      let im = 0;
      const a = (-2 * Math.PI * k) / n;
      for (let i = 0; i < n; i++) { re += w[i] * Math.cos(a * i); im += w[i] * Math.sin(a * i); }
      const power = re * re + im * im;
      if ((k * SR) / n > 2000) outBand += power; else inBand += power;
    }

    return 10 * Math.log10(outBand / inBand);
  };

  const GAP = Math.round(0.04 * SR);
  const PRE = Math.round(0.05 * SR);
  const POST = Math.round(0.05 * SR);

  const build = (fadeMs) => {
    const out = new Float32Array(PRE + GAP + POST);
    out.set(tone(PRE, 0), 0);
    // La chronologie est conservee a l'echantillon pres : le trou dure exactement sa duree.
    out.set(tone(POST, PRE + GAP), PRE + GAP);

    if (fadeMs > 0) {
      const f = Math.round((fadeMs / 1000) * SR);
      for (let i = 0; i < f; i++) {
        const gain = 0.5 + 0.5 * Math.cos((Math.PI * i) / f);
        out[PRE - f + i] *= gain;
        out[PRE + GAP + f - 1 - i] *= gain;
      }
    }

    return out;
  };

  const edge = (x, at) => {
    const n = Math.round(0.008 * SR);
    return x.subarray(at - n / 2, at + n / 2);
  };

  console.log("### Clic aux bords d'un trou de 40 ms comble par du silence");
  console.log("    Energie au-dessus de 2 kHz rapportee a la bande utile. Le signal n'a rien au-dessus");
  console.log("    de 880 Hz : tout ce qui s'y trouve a ete fabrique par la discontinuite.\n");
  console.log(`  signal intact, sans trou          ${outOfBandDb(edge(tone(PRE + GAP + POST), PRE)).toFixed(1).padStart(6)} dB`);

  for (const fadeMs of [0, 0.5, 1, 2, 3, 5, 8]) {
    const y = build(fadeMs);
    const label = fadeMs === 0 ? "silence nu (code actuel)" : `fondu de ${fadeMs} ms`;
    console.log(
      `  ${label.padEnd(33)} ${outOfBandDb(edge(y, PRE)).toFixed(1).padStart(6)} dB a l'entree, ` +
      `${outOfBandDb(edge(y, PRE + GAP)).toFixed(1).padStart(6)} dB a la sortie`
    );
  }
  console.log("");
}
