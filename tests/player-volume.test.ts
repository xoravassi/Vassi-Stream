import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlayer } from "../src/player/audio-player.ts";
import { FakeAudioWorkletNode, FakeGainNode, installBrowserFakes } from "./browser-fakes.ts";
import { startLive, startRelay, waitFor, type TestRelay } from "./relay-harness.ts";

// Ce fichier verifie le reglage de volume : ou il se place dans la chaine audio, comment il est
// applique, et ce qu'il devient quand le contexte audio est detruit puis reconstruit.
//
// Le volume est le seul reglage qui n'agit pas sur le direct lui-meme. Il ne change ni l'etat, ni ce
// que le relais envoie, ni ce que le decodeur produit : il attenue le son au dernier maillon. Une
// erreur ici ne se voit dans aucun compteur, elle ne s'entend que dans un navigateur.

// Cette fonction demarre un relais, un direct et un player pret a jouer.
async function startPlayer(): Promise<{
  relay: TestRelay;
  player: AudioPlayer;
  restore: () => void;
}> {
  const restore = installBrowserFakes({ isolated: true });
  const relay = await startRelay();
  await startLive(relay, 4242);

  const player = new AudioPlayer({
    relayUrl: relay.listenerUrl,
    createWorker: () => new Worker("/decode-worker.js", { type: "module" }),
    workletUrl: "/pcm-worklet.js",
  });

  player.connect();
  await waitFor(() => player.status().state === "READY", "direct annonce a la page");

  return { relay, player, restore };
}

// Ce test verifie que le son passe par le reglage de volume avant d'atteindre la sortie.
//
// Un noeud de volume construit mais laisse de cote ne ferait rien du tout, et le curseur de la page
// resterait sans effet sans qu'aucun compteur ne le signale.
test("place le reglage de volume entre le processeur audio et la sortie", async (t) => {
  const { relay, player, restore } = await startPlayer();
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const node = FakeAudioWorkletNode.last;
  const gain = FakeGainNode.last;
  assert.ok(node !== null && gain !== null, "le noeud de volume doit exister");

  // Les deux sont branches : le processeur vers le volume, le volume vers la sortie.
  assert.equal(node.connected, true);
  assert.equal(gain.connected, true);
  // Le niveau d'origine tant que rien n'a ete demande.
  assert.equal(gain.gain.value, 1);
});

// Ce test verifie qu'un changement de volume est etale et non pose d'un coup.
//
// Un saut de niveau instantane coupe la forme d'onde en plein milieu, et cette rupture s'entend
// comme un clic. C'est le defaut le plus courant des curseurs de volume, et le seul que ce test
// puisse attraper sans oreille.
test("etale le changement de volume au lieu de le poser d'un coup", async (t) => {
  const { relay, player, restore } = await startPlayer();
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();
  player.setVolume(0.5);

  const gain = FakeGainNode.last;
  assert.ok(gain !== null);

  assert.equal(gain.cibles.length, 1);

  const cible = gain.cibles[0];
  assert.ok(cible !== undefined);
  assert.equal(cible.value, 0.5);
  assert.ok(cible.timeConstant > 0, "le changement doit s'etaler sur une duree non nulle");
});

// Ce test verifie que les valeurs hors bornes sont ramenees dans la plage utile.
//
// Un gain superieur a 1 amplifie le signal et sature ; un gain negatif inverse la phase. Ni l'un ni
// l'autre n'est ce qu'un curseur de volume doit pouvoir produire, meme si la page se trompe.
test("ramene les volumes hors bornes entre 0 et 1", async (t) => {
  const { relay, player, restore } = await startPlayer();
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  await player.play();

  const gain = FakeGainNode.last;
  assert.ok(gain !== null);

  player.setVolume(4);
  assert.equal(gain.gain.value, 1);

  player.setVolume(-2);
  assert.equal(gain.gain.value, 0);

  // Une valeur qui n'est pas un nombre ne touche a rien : le niveau precedent tient.
  player.setVolume(Number.NaN);
  assert.equal(gain.gain.value, 0);
});

// Ce test verifie que le volume regle avant le premier clic s'applique au premier son.
//
// La page peut afficher son curseur avant que l'auditeur ait clique sur Ecouter. Sans cette
// memoire, le son partirait au niveau maximum et ne se rangerait qu'au geste suivant.
test("retient le volume regle avant la creation du contexte audio", async (t) => {
  const { relay, player, restore } = await startPlayer();
  t.after(async () => {
    await player.close();
    await relay.close();
    restore();
  });

  // Aucun contexte audio n'existe encore : rien n'a ete cree avant le premier clic.
  const avantLeClic: FakeGainNode | null = FakeGainNode.last;
  assert.equal(avantLeClic, null);

  player.setVolume(0.25);
  await player.play();

  const gain: FakeGainNode | null = FakeGainNode.last;
  assert.ok(gain !== null);
  // Le noeud naît deja au bon niveau, sans transition : aucun echantillon n'a encore ete rendu.
  assert.equal(gain.gain.value, 0.25);
  assert.equal(gain.cibles.length, 0);
});
