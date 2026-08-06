import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SOURCE_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "vassi.encoder.cpp");
const QUEUE_HEADER_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "audio_queue.h");
const QUEUE_SOURCE_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "audio_queue.cpp");
const WORKER_HEADER_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "encoder_worker.h");
const WORKER_SOURCE_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "encoder_worker.cpp");
const ENCODER_HEADER_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "audio_encoder.h");
const ENCODER_SOURCE_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "audio_encoder.cpp");
const STATE_SOURCE_PATH = join(ROOT, "externals", "vassi.encoder~", "source", "encoder_state.cpp");
const PATCH_PATH = join(ROOT, "patchers", "vassi.encoder.passive-test.maxpat");
const BRIDGE_PATCH_PATH = join(ROOT, "patchers", "vassi.encoder.bridge-test.maxpat");

// Cette fonction lit la source native comme texte pour verifier les invariants du bloc 2.
function readSource(): string {
  return readFileSync(SOURCE_PATH, "utf8");
}

// Cette fonction lit le module de queue pour verifier le contrat du bloc 3.
function readQueueFiles(): string {
  return `${readFileSync(QUEUE_HEADER_PATH, "utf8")}\n${readFileSync(QUEUE_SOURCE_PATH, "utf8")}`;
}

// Cette fonction lit le module worker pour verifier sa separation du callback audio.
function readWorkerFiles(): string {
  return `${readFileSync(WORKER_HEADER_PATH, "utf8")}\n${readFileSync(WORKER_SOURCE_PATH, "utf8")}`;
}

// Cette fonction lit le moteur Opus pour verifier les invariants du bloc 4.
function readEncoderFiles(): string {
  return `${readFileSync(ENCODER_HEADER_PATH, "utf8")}\n${readFileSync(ENCODER_SOURCE_PATH, "utf8")}`;
}

// Cette fonction isole le corps de perform64 pour controler uniquement le callback audio.
function readPerformBody(source: string): string {
  const start = source.lastIndexOf("static void vassi_encoder_perform64(");
  assert.notEqual(start, -1);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") {
      depth += 1;
    }

    if (char === "}") {
      depth -= 1;
    }

    if (depth === 0) {
      return source.slice(bodyStart + 1, index);
    }
  }

  throw new Error("perform64_body_not_found");
}

// Ce test verifie que l'objet MSP expose le nom et les deux entrees signal prevus.
test("declare vassi.encoder~ avec deux entrees signal", () => {
  const source = readSource();

  assert.match(source, /class_new\(\s*"vassi\.encoder~"/);
  assert.match(source, /dsp_setup\(\(t_pxobject \*\)x,\s*2\)/);
});

// Ce test verifie que le chemin audio 64 bits natif est branche dans Max.
test("branche dsp64 et dsp_add64", () => {
  const source = readSource();

  assert.match(source, /class_dspinit\(class_ref\)/);
  assert.match(source, /class_addmethod\(class_ref,\s*\(method\)vassi_encoder_dsp64,\s*"dsp64"/);
  assert.match(source, /gensym\("dsp_add64"\)/);
  assert.match(source, /vassi_encoder_perform64/);
});

// Ce test protege la routine audio contre les operations interdites par la roadmap.
test("garde perform64 sans allocation, log, reseau ou outlet", () => {
  const source = readSource();
  const body = readPerformBody(source);
  const forbiddenPatterns = [
    /\bnew\b/,
    /\bdelete\b/,
    /\bmalloc\b/,
    /\bcalloc\b/,
    /\brealloc\b/,
    /\bfree\b/,
    /\bpost\s*\(/,
    /\bobject_post\s*\(/,
    /\berror\s*\(/,
    /\boutlet_/,
    /\bsend\b/,
    /\brecv\b/,
    /\bsocket\b/,
    /\bconnect\b/,
    /\bstd::thread\b/,
    /\bmutex\b/,
  ];

  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(body, pattern);
  }
});

// Ce test verifie que la file audio stereo est preallouee avec une duree fixe.
test("adapte une queue stereo preallouee au sample rate", () => {
  const source = readSource();
  const queue = readQueueFiles();

  assert.match(source, /QUEUE_CAPACITY_MS\s*=\s*1000/);
  assert.match(source, /vassi_encoder_prepare_queue\(x,\s*samplerate\)/);
  assert.match(source, /audio_queue_resize\(&x->audio_queue,\s*capacity_frames\)/);
  assert.match(queue, /t_atomic_sample \*left_samples/);
  assert.match(queue, /t_atomic_sample \*right_samples/);
  assert.match(queue, /new \(std::nothrow\) t_atomic_sample\[capacity_frames\]/g);
});

// Ce test verifie que la routine audio depose les deux canaux dans la file.
test("copie le signal stereo vers la queue depuis perform64", () => {
  const source = readSource();
  const body = readPerformBody(source);

  assert.match(body, /audio_queue_push_stereo\(&x->audio_queue,\s*ins\[0\],\s*ins\[1\],\s*sampleframes\)/);
});

// Ce test verifie que les compteurs par canal mesurent le son recu et non un drapeau de cablage.
// Un drapeau pose une seule fois dans dsp64 reste faux des que Max ne reconstruit pas sa chaine,
// et il ne dit rien du contenu : un canal cable mais muet comptait quand meme des blocs.
test("compte les blocs par canal a partir du signal recu", () => {
  const source = readSource();
  const body = readPerformBody(source);

  assert.match(body, /block_carries_signal\(ins\[0\],\s*sampleframes\)/);
  assert.match(body, /block_carries_signal\(ins\[1\],\s*sampleframes\)/);
  assert.match(source, /samples\[index\] != 0\.0/);
  assert.doesNotMatch(source, /left_connected|right_connected/);
});

// Ce test verifie que reset ne touche qu'aux compteurs de diagnostic.
test("garde reset limite aux compteurs", () => {
  const source = readSource();
  const start = source.lastIndexOf("static void vassi_encoder_reset(t_vassi_encoder *x) {");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.match(body, /x->block_count\.store\(0/);
  assert.doesNotMatch(body, /_connected|dsp_add64/);
});

// Ce test verifie que la file pleine abandonne l'ancien audio et compte l'evenement.
test("abandonne les samples anciens quand la queue est pleine", () => {
  const queue = readQueueFiles();

  assert.match(queue, /audio_queue_raise_read\(queue,\s*wanted_read\)/);
  assert.match(queue, /overflow_count\.fetch_add\(1,\s*std::memory_order_relaxed\)/);
  assert.match(queue, /audio_queue_size\(const t_audio_queue \*queue\)/);
});

// Ce test verifie que reset utilise la meme avance monotone que l'overflow.
test("empeche reset de faire reculer la lecture", () => {
  const queue = readQueueFiles();

  assert.match(queue, /void audio_queue_reset\(t_audio_queue \*queue\)[\s\S]*audio_queue_raise_read\(queue,\s*write\)/);
  assert.doesNotMatch(queue, /void audio_queue_reset\(t_audio_queue \*queue\)[\s\S]{0,200}read_frame\.store\(/);
});

// Ce test verifie que chaque frame lue est copiee dans les buffers du worker.
test("copie toutes les frames stereo vers le worker", () => {
  const queue = readQueueFiles();
  const worker = readWorkerFiles();

  assert.match(queue, /for \(std::size_t frame = 0; frame < frames_to_read; frame \+= 1\)/);
  assert.match(queue, /left\[frame\]\s*=\s*audio_queue_unpack_sample/);
  assert.match(queue, /right\[frame\]\s*=\s*audio_queue_unpack_sample/);
  assert.match(worker, /double left_samples\[ENCODER_WORKER_READ_FRAMES\]/);
  assert.match(worker, /double right_samples\[ENCODER_WORKER_READ_FRAMES\]/);
});

// Ce test verifie que le worker peut etre demarre et arrete hors routine audio.
test("demarre et arrete un worker de lecture hors routine audio", () => {
  const source = readSource();
  const worker = readWorkerFiles();
  const body = readPerformBody(source);

  assert.match(source, /class_addmethod\(class_ref,\s*\(method\)vassi_encoder_start,\s*"start"/);
  assert.match(source, /class_addmethod\(class_ref,\s*\(method\)vassi_encoder_stop,\s*"stop"/);
  assert.match(worker, /new \(std::nothrow\) std::thread\(encoder_worker_run,\s*worker\)/);
  assert.match(worker, /thread->join\(\)/);
  assert.match(worker, /audio_queue_pop\(/);
  assert.doesNotMatch(body, /std::thread|join|sleep_for/);
});

// Ce test verifie que le diagnostic expose la taille de queue et les overflows.
test("expose les diagnostics de queue par bang", () => {
  const source = readSource();
  const body = readPerformBody(source);

  assert.match(source, /audio_queue_size\(&x->audio_queue\)/);
  assert.match(source, /overflow_count\.load\(std::memory_order_relaxed\)/);
  assert.match(source, /outlet_anything\(x->diagnostic_outlet,\s*gensym\("queue"\),\s*8,\s*queue_values\)/);
  assert.doesNotMatch(body, /gensym\("queue"\)|outlet_anything/);
});

// Ce test verifie que les diagnostics sortent seulement depuis le thread message.
test("expose un diagnostic par bang hors routine audio", () => {
  const source = readSource();
  const body = readPerformBody(source);

  assert.match(source, /class_addmethod\(class_ref,\s*\(method\)vassi_encoder_bang,\s*"bang"/);
  assert.match(source, /outlet_anything\(x->diagnostic_outlet,\s*gensym\("blocks"\),\s*4,\s*block_values\)/);
  assert.doesNotMatch(body, /outlet_anything/);
});

// Ce test verrouille le format audio fixe remis a libopus.
test("encode des frames Opus stereo de 40 ms pour la musique", () => {
  const encoder = readEncoderFiles();

  assert.match(encoder, /OPUS_FRAME_SAMPLES\s*=\s*1920/);
  assert.match(encoder, /OUTPUT_RATE\s*=\s*48000/);
  assert.match(encoder, /OUTPUT_CHANNELS\s*=\s*2/);
  assert.match(encoder, /opus_encoder_create\(OUTPUT_RATE,\s*OUTPUT_CHANNELS,\s*OPUS_APPLICATION_AUDIO/);
  assert.match(encoder, /opus_encode_float\(/);
});

// Ce test verifie le resampling et les trois profils figes de la version 1.
test("reechantillonne et applique les trois profils de qualite", () => {
  const encoder = readEncoderFiles();
  const state = readFileSync(STATE_SOURCE_PATH, "utf8");

  assert.match(encoder, /speex_resampler_process_interleaved_float\(/);
  assert.match(encoder, /OPUS_BITRATE_STABLE\s*=\s*128000/);
  assert.match(encoder, /OPUS_BITRATE_HIGH\s*=\s*192000/);
  assert.match(encoder, /OPUS_BITRATE_STUDIO\s*=\s*256000/);
  assert.match(state, /new \(&state->bitrate\) t_atomic_long\(OPUS_BITRATE_STUDIO\)/);
});

// Ce test verifie que le worker reset le codec avant de traiter l'audio post-overflow.
test("marque la premiere frame apres une perte locale", () => {
  const worker = readWorkerFiles();
  const encoder = readEncoderFiles();

  assert.match(worker, /encoder_worker_reset_after_overflow\(worker,\s*encoder,\s*&known_dropped\)/);
  assert.match(worker, /audio_encoder_reset_after_loss\(encoder,\s*lost_us\)/);
  assert.match(encoder, /frame\.flags\s*=\s*encoder->discontinuity_pending\s*\?\s*1\s*:\s*0/);
});

// Ce test verifie que la chronologie suit le contrat du protocole v1 apres une perte.
test("avance le timestamp de la duree abandonnee", () => {
  const queue = readQueueFiles();
  const worker = readWorkerFiles();
  const encoder = readEncoderFiles();

  assert.match(queue, /queue->dropped_frames\.fetch_add\(skipped/);
  assert.match(worker, /current > \*known_dropped \? current - \*known_dropped : 0/);
  assert.match(encoder, /encoder->timestamp_us \+= lost_us \+ discarded_us/);
  assert.match(encoder, /OPUS_MAX_PACKET_BYTES\s*=\s*2560/);
});

// Ce test verifie qu'un compteur de pertes remis a zero ne cree jamais une duree perdue enorme.
test("resiste a un compteur de pertes remis a zero", () => {
  const worker = readWorkerFiles();

  // Sans cette garde, une soustraction non signee produirait un timestamp de plusieurs annees.
  assert.match(worker, /current > \*known_dropped \? current - \*known_dropped : 0/);
  assert.match(worker, /stored_rate > 0 \? \(std::uint64_t\)stored_rate : 1ULL/);
});

// Ce test verifie que l'arret du worker devient visible dans Max au lieu de rester silencieux.
test("remonte l'erreur du worker jusqu'a Max", () => {
  const source = readSource();
  const worker = readWorkerFiles();

  assert.match(worker, /encoder_worker_publish_error\(worker,\s*&known_error\)/);
  assert.match(worker, /encoder_worker_notify\(worker\);\s*\n\s*return;/);
  assert.match(source, /x->worker\.error\.load\(std::memory_order_acquire\) != 0/);
  assert.match(source, /failed \? "error" :/);
});

// Ce test verifie qu'une reconstruction de chaine DSP sans changement ne touche pas au worker.
test("ne rejoint pas le worker quand le sample rate ne change pas", () => {
  const source = readSource();

  assert.match(
    source,
    /if \(sample_rate == x->sample_rate\.load\(std::memory_order_relaxed\)[\s\S]{0,120}return true;/
  );
});

// Ce test verifie que la lecture de la queue ne peut jamais bloquer l'arret du worker.
test("borne les tentatives de lecture de la queue", () => {
  const queue = readQueueFiles();

  assert.match(queue, /AUDIO_QUEUE_POP_ATTEMPTS\s*=\s*\d+/);
  assert.match(queue, /for \(int attempt = 0; attempt < AUDIO_QUEUE_POP_ATTEMPTS/);
  assert.doesNotMatch(queue, /while \(true\)/);
});

// Ce test verifie que le pont vers Node vit dans le worker et jamais dans le thread audio.
test("envoie les frames depuis le worker et pas depuis Max", () => {
  const source = readSource();
  const worker = readWorkerFiles();

  assert.match(worker, /frame_sender_send\(worker->sender,\s*frame\)/);
  assert.match(worker, /frame_sender_service\(worker->sender\)/);
  assert.doesNotMatch(source, /frame_sender_send\(/);
  assert.match(source, /class_addmethod\(class_ref,\s*\(method\)vassi_encoder_port,\s*"port"/);
  assert.match(source, /qelem_set\(x->status_qelem\)/);
});

// Ce test verifie que le cote Node reste local, en CommonJS et sans base64.
test("expose un pont loopback CommonJS cote Node", () => {
  const bridge = readFileSync(join(ROOT, "device", "node", "frame-bridge.js"), "utf8");
  const entry = readFileSync(join(ROOT, "device", "node", "vassi-stream-device.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(ROOT, "device", "node", "package.json"), "utf8"));

  assert.equal(manifest.type, "commonjs");
  assert.match(entry, /require\("max-api"\)/);
  assert.match(bridge, /host:\s*"127\.0\.0\.1"/);
  assert.doesNotMatch(bridge, /base64/);
  assert.doesNotMatch(entry, /base64/);
  assert.match(entry, /Max\.addHandler\("getport"/);
});

// Ce test verifie que le patch du pont relie bien le port annonce par Node a l'encodeur.
test("transmet le port de node.script a vassi.encoder~", () => {
  const patch = JSON.parse(readFileSync(BRIDGE_PATCH_PATH, "utf8"));
  const boxes = patch.patcher.boxes.map((entry: { box: unknown }) => entry.box);
  const lines = patch.patcher.lines.map((line: { patchline: unknown }) => line.patchline);
  const textOf = (id: string) => boxes.find((box: any) => box.id === id)?.text ?? "";
  const linked = (from: string, outlet: number, to: string) =>
    lines.some((line: any) => line.source[0] === from && line.source[1] === outlet && line.destination[0] === to);

  // Le chemin du script est absolu : le device reste valide depuis la User Library d'Ableton.
  assert.match(textOf("node"), /^node\.script [A-Za-z]:\/.*\/device\/node\/vassi-stream-device\.js @autostart 1$/);
  assert.match(textOf("node-route"), /route port status stats/);
  assert.equal(textOf("port-to-encoder"), "prepend port");
  assert.ok(linked("node", 0, "node-route"));
  assert.ok(linked("node-route", 0, "port-to-encoder"));
  assert.ok(linked("port-to-encoder", 0, "encoder"));
  assert.ok(linked("plugin", 0, "plugout"));

  // Le port annonce doit rester visible dans la console pour le diagnostic manuel.
  assert.ok(linked("node-route", 1, "node-print"));
  assert.ok(linked("node-route", 3, "node-print"));

  // Le patch doit pouvoir relancer Node et redemander le port pendant un test manuel.
  assert.equal(textOf("ask-port"), "getport");
  assert.equal(textOf("button-restart"), "script restart");
  assert.ok(linked("ask-port", 0, "node"));
  assert.ok(linked("button-restart", 0, "node"));
});

// Ce test verifie que le patch se rafraichit et se reconnecte sans intervention.
test("interroge Max et Node sans clic pendant le test manuel", () => {
  const patch = JSON.parse(readFileSync(BRIDGE_PATCH_PATH, "utf8"));
  const boxes = patch.patcher.boxes.map((entry: { box: unknown }) => entry.box);
  const lines = patch.patcher.lines.map((line: { patchline: unknown }) => line.patchline);
  const textOf = (id: string) => boxes.find((box: any) => box.id === id)?.text ?? "";
  const linked = (from: string, to: string) =>
    lines.some((line: any) => line.source[0] === from && line.destination[0] === to);

  // Node met environ une seconde a demarrer : l'interrogation attend avant sa premiere demande.
  assert.match(textOf("poll-delay"), /^delay \d+$/);
  assert.match(textOf("poll-metro"), /^metro \d+$/);
  assert.ok(linked("loadbang", "poll-delay"));
  assert.ok(linked("poll-delay", "poll-on"));
  assert.ok(linked("poll-on", "poll-metro"));
  assert.ok(linked("poll-metro", "poll-split"));
  assert.ok(linked("poll-split", "encoder"));
  assert.ok(linked("poll-split", "ask-stats"));
  assert.ok(linked("ask-stats", "node"));

  // Un pont ferme redemande le port : le device se repare seul apres un redemarrage de Node.
  assert.equal(textOf("bridge-closed"), "sel 0");
  assert.ok(linked("encoder-route", "bridge-unpack"));
  assert.ok(linked("bridge-unpack", "bridge-closed"));
  assert.ok(linked("bridge-closed", "ask-port"));
});

// Ce test verifie que le device reste lisible dans Ableton sans ouvrir l'editeur Max.
test("affiche les compteurs dans la vue presentation du device", () => {
  const patch = JSON.parse(readFileSync(BRIDGE_PATCH_PATH, "utf8"));
  const boxes = patch.patcher.boxes.map((entry: { box: any }) => entry.box);
  const visible = boxes.filter((box: any) => box.presentation === 1);

  assert.equal(patch.patcher.openinpresentation, 1);

  // Chaque valeur lue pendant le test doit exister dans la vue presentation.
  for (const id of [
    "display-encoder-state",
    "display-node-state",
    "display-encoded",
    "display-sent",
    "display-lost",
    "display-received",
    "display-gaps",
    "display-discontinuities",
    "display-overflows",
    "display-port",
    "display-blocks-left",
    "display-blocks-right"
  ]) {
    assert.ok(visible.some((box: any) => box.id === id), `${id} doit etre en presentation`);
  }

  // Live impose une hauteur fixe : un objet plus bas serait invisible dans le device.
  for (const box of visible) {
    const [x, y, width, height] = box.presentation_rect;
    assert.ok(x >= 0 && y >= 0, `${box.id} sort du cadre`);
    assert.ok(x + width <= patch.patcher.devicewidth, `${box.id} depasse la largeur du device`);
    assert.ok(y + height <= 168, `${box.id} depasse la hauteur d'un device Live`);
  }
});

// Ce test verifie le routage passif attendu dans le patch de test Max for Live.
test("route plugin~ vers plugout~ et vassi.encoder~", () => {
  const patch = JSON.parse(readFileSync(PATCH_PATH, "utf8"));
  const lines = patch.patcher.lines.map((line: { patchline: unknown }) => line.patchline);

  assert.ok(lines.some((line: any) => line.source[0] === "plugin" && line.source[1] === 0 && line.destination[0] === "plugout" && line.destination[1] === 0));
  assert.ok(lines.some((line: any) => line.source[0] === "plugin" && line.source[1] === 1 && line.destination[0] === "plugout" && line.destination[1] === 1));
  assert.ok(lines.some((line: any) => line.source[0] === "plugin" && line.source[1] === 0 && line.destination[0] === "encoder" && line.destination[1] === 0));
  assert.ok(lines.some((line: any) => line.source[0] === "plugin" && line.source[1] === 1 && line.destination[0] === "encoder" && line.destination[1] === 1));
});
