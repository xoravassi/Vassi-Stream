import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlayer } from "../src/player/audio-player.ts";
import { PCM_PROCESSOR_NAME } from "../src/player/pcm-worklet.js";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeWorker,
  installBrowserFakes,
} from "./browser-fakes.ts";
import { audioPacket, startLive, startRelay, waitFor, type TestRelay } from "./relay-harness.ts";

// Ce fichier verifie l'assemblage du player : ce qui part vers le worker, ce qui part vers le
// processeur audio, et dans quel ordre. Ces fils ne sont visibles nulle part ailleurs, et une erreur
// a cet endroit ne se voit qu'a l'oreille, dans un navigateur.
//
// Le relais est le vrai relais du bloc 7. Seules les pieces qui n'existent pas sous Node sont
// remplacees : contexte audio, noeud de traitement et worker.

// Cette fonction demarre un relais, un direct et un player pret a jouer.
async function startPlayer(options: { isolated: boolean }): Promise<{
  relay: TestRelay;
  player: AudioPlayer;
  publisher: Awaited<ReturnType<typeof startLive>>;
  restore: () => void;
}> {
  const restore = installBrowserFakes(options);
  const relay = await startRelay();
  const publisher = await startLive(relay, 4242);

  const player = new AudioPlayer({
    relayUrl: relay.listenerUrl,
    workerUrl: "/decode-worker.js",
    workletUrl: "/pcm-worklet.js",
  });

  player.connect();
  await waitFor(() => player.status().state === "READY", "direct annonce a la page");

  return { relay, player, publisher, restore };
}

// Ce test verifie que le worker apprend la session avant de recevoir un paquet.
//
// La connexion s'ouvre avant le premier clic sur Play : une session est donc deja connue quand le
// worker naît. Si elle ne lui est pas transmise a ce moment, il garde la session zero, refuse chaque
// paquet pour session etrangere, et aucun son ne sort jamais. Rien d'autre ne signale cette panne :
// la page reste simplement en bufferisation.
test("transmet la session au worker des sa creation, avant tout paquet", async (t) => {
  const { relay, player, publisher, restore } = await startPlayer({ isolated: true });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const worker = FakeWorker.last;
  assert.ok(worker !== null);

  const sessions = worker.messagesOfType("session");
  assert.deepEqual(sessions, [{ type: "session", sessionId: 4242 }]);

  // La session part avant le premier paquet, sinon ce paquet serait refuse.
  const rangSession = worker.sent.findIndex((message) => message.data.type === "session");
  publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => worker.messagesOfType("packet").length === 1, "paquet transmis au worker");

  const rangPaquet = worker.sent.findIndex((message) => message.data.type === "packet");
  assert.ok(rangSession < rangPaquet, "la session doit partir avant le premier paquet");
});

// Ce test verifie l'ordre complet du demarrage, celui que la page ne peut pas corriger elle-meme.
test("demarre le son dans l'ordre : module, noeud, worker, session, ordres", async (t) => {
  const { relay, player, restore } = await startPlayer({ isolated: true });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const context = FakeAudioContext.last;
  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(context !== null && node !== null && worker !== null);

  // Le processeur est charge avant que le noeud soit cree.
  assert.deepEqual(context.modules, ["/pcm-worklet.js"]);
  assert.equal(node.name, PCM_PROCESSOR_NAME);
  assert.equal(node.connected, true);
  assert.equal(context.settings.sampleRate, 48000);

  // Le decodeur recoit l'ordre de remplir la file des que le son est demande.
  assert.deepEqual(worker.messagesOfType("accepting"), [{ type: "accepting", accepting: true }]);

  // Le processeur audio ne consomme pas encore : la file doit d'abord se remplir.
  assert.equal(player.status().state, "BUFFERING");
  assert.deepEqual(node.port.messagesOfType("play"), []);
});

// Ce test verifie que le niveau annonce par le processeur audio lance et relance la lecture.
test("lance la lecture au seuil annonce par le processeur audio", async (t) => {
  const { relay, player, restore } = await startPlayer({ isolated: true });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const node = FakeAudioWorkletNode.last;
  assert.ok(node !== null);

  node.port.deliver({ type: "level", availableMs: 100, underruns: 0 });
  assert.equal(player.status().state, "BUFFERING");

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0 });
  assert.equal(player.status().state, "PLAYING");
  assert.deepEqual(node.port.messagesOfType("play"), [{ type: "play" }]);

  // Une pause coupe la consommation et arrete de remplir la file.
  player.pause();
  assert.equal(player.status().state, "PAUSED");
  assert.deepEqual(node.port.messagesOfType("pause"), [{ type: "pause" }]);

  const worker = FakeWorker.last;
  assert.ok(worker !== null);
  const ordres = worker.messagesOfType("accepting");
  assert.deepEqual(ordres[ordres.length - 1], { type: "accepting", accepting: false });
});

// Ce test verifie qu'une discontinuite signalee par le worker fait rebufferiser la page.
test("rebufferise quand le worker signale une discontinuite", async (t) => {
  const { relay, player, restore } = await startPlayer({ isolated: true });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0 });
  assert.equal(player.status().state, "PLAYING");

  worker.deliver({ type: "discontinuity", reason: "flag" });
  assert.equal(player.status().state, "REBUFFERING");
});

// Ce test verifie le chemin utilise quand la page n'est pas isolee. Le port qui relie le worker au
// processeur ne peut pas voyager dans les options de construction du noeud : celles-ci sont copiees,
// et un port se transfere. Sans ce detail, la page echoue au premier clic sur Play.
test("transfere le port du worker au processeur quand SharedArrayBuffer manque", async (t) => {
  const { relay, player, restore } = await startPlayer({ isolated: false });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  // Aucun port n'entre dans les options de construction, qui sont copiees et non transferees.
  // La memoire de la file y entre, elle, mais ordinaire : le processeur audio est seul a s'en
  // servir, puisque le worker lui envoie ses blocs au lieu d'ecrire dedans.
  const options = node.options.processorOptions as Record<string, unknown>;
  assert.equal(options.port, undefined);
  assert.ok(options.buffer instanceof ArrayBuffer);
  assert.ok(!(options.buffer instanceof SharedArrayBuffer));

  // Le port part par le port du noeud, dans sa liste de transfert.
  const envoi = node.port.sent.find((message) => message.data.type === "port");
  assert.ok(envoi !== undefined, "le port du worker doit etre transfere au processeur");
  assert.equal(envoi.transfer.length, 1);
  assert.equal(envoi.transfer[0], envoi.data.port);

  // L'autre extremite part vers le worker, elle aussi transferee.
  const configure = worker.sent.find((message) => message.data.type === "configure");
  assert.ok(configure !== undefined);
  assert.equal(configure.transfer.length, 1);
  assert.equal(configure.transfer[0], configure.data.port);
  // Le worker n'ecrit pas dans la memoire du processeur : il n'en recoit pas l'adresse.
  assert.equal(configure.data.buffer, undefined);
});

// Ce test verifie le chemin utilise quand la page est isolee : la memoire partagee remplace le port.
test("partage la memoire de la file quand la page est isolee", async (t) => {
  const { relay, player, restore } = await startPlayer({ isolated: true });
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  const options = node.options.processorOptions as Record<string, unknown>;
  assert.ok(options.buffer instanceof SharedArrayBuffer);

  const configure = worker.sent.find((message) => message.data.type === "configure");
  assert.ok(configure !== undefined);
  // Le worker et le processeur audio recoivent exactement la meme memoire.
  assert.equal(configure.data.buffer, options.buffer);
  assert.equal(configure.data.port, undefined);
});
