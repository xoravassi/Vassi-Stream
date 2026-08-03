import assert from "node:assert/strict";
import test from "node:test";

import { backoffDelayMs, BACKOFF_STEPS_MS, ListenerSocket } from "../src/player/listener-socket.ts";
import type { StreamState } from "../src/player/player-protocol.ts";
import { audioPacket, startLive, startRelay, waitFor } from "./relay-harness.ts";

// Ce fichier branche le socket du player sur le vrai relais du bloc 7. Les autres tests du player
// utilisent des donnees preparees ; celui-ci verifie que les deux moities se comprennent reellement.
//
// Le `WebSocket` global de Node suit la meme specification que celui du navigateur : c'est donc le
// vrai chemin de la page qui est teste, pas une imitation.

// Ce type garde tout ce que le socket a annonce pendant un test.
type Traces = {
  etats: StreamState[];
  paquets: ArrayBuffer[];
  coupures: number;
};

// Cette fonction ouvre un socket listener branche sur un relais de test.
function connect(url: string): { socket: ListenerSocket; traces: Traces } {
  const traces: Traces = { etats: [], paquets: [], coupures: 0 };

  const socket = new ListenerSocket(url, {
    onState: (state) => traces.etats.push(state),
    onPacket: (packet) => traces.paquets.push(packet),
    onConnectionLost: () => {
      traces.coupures += 1;
    },
  });

  socket.start();
  return { socket, traces };
}

// Ce test verifie le parcours complet vu par la page : etat hors ligne, puis direct, puis paquets
// audio recus octet pour octet.
test("recoit l'etat puis les paquets du vrai relais", async (t) => {
  const relay = await startRelay();
  const { socket, traces } = connect(relay.listenerUrl);
  t.after(async () => {
    socket.stop();
    await relay.close();
  });

  await waitFor(() => traces.etats.length === 1, "premier etat");
  assert.deepEqual(traces.etats[0], { live: false, session: null });

  const publisher = await startLive(relay, 4242);
  await waitFor(() => traces.etats.length === 2, "etat en direct");

  assert.equal(traces.etats[1]?.live, true);
  assert.equal(traces.etats[1]?.session?.sessionId, 4242);
  assert.equal(traces.etats[1]?.session?.targetBufferMs, 400);

  const envoye = audioPacket(4242, 0, 7);
  publisher.sendBinary(envoye);
  await waitFor(() => traces.paquets.length === 1, "paquet recu");

  // Les octets arrivent en `ArrayBuffer`, la seule forme qui se transfere au worker sans copie.
  assert.ok(traces.paquets[0] instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(traces.paquets[0] as ArrayBuffer), envoye);

  publisher.stop();
  await waitFor(() => traces.etats.length === 3, "retour hors ligne");
  assert.equal(traces.etats[2]?.live, false);
});

// Ce test verifie qu'une coupure du relais est signalee puis suivie d'une reconnexion. C'est le cas
// que le professeur rencontrera si le relais redemarre pendant une seance.
test("signale la coupure puis reconnecte quand le relais revient", async (t) => {
  const relay = await startRelay();
  const { socket, traces } = connect(relay.listenerUrl);
  t.after(() => socket.stop());

  await waitFor(() => traces.etats.length === 1, "premier etat");

  await relay.close();
  await waitFor(() => traces.coupures === 1, "coupure signalee");
  assert.equal(socket.connected, false);

  // Le meme port est rouvert : le socket doit y revenir seul, sans intervention de la page.
  const port = Number(new URL(relay.listenerUrl.replace("ws://", "http://")).port);
  const reprise = await startRelay({ port });
  t.after(() => reprise.close());

  await waitFor(() => traces.etats.length === 2, "etat apres reconnexion", 8000);
  assert.equal(traces.etats[1]?.live, false);
  assert.equal(socket.connected, true);
});

// Ce test verifie que `stop()` ne laisse aucune reconnexion en cours. Sans cela, quitter la page
// laisserait un minuteur rouvrir une connexion dont plus personne ne veut.
test("ne reconnecte plus apres un arret demande", async (t) => {
  const relay = await startRelay();
  const { socket, traces } = connect(relay.listenerUrl);
  t.after(() => relay.close());

  await waitFor(() => traces.etats.length === 1, "premier etat");

  socket.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(socket.connected, false);
  assert.equal(relay.relay.health().listeners, 0);
});

// Ce test verifie l'escalier de reconnexion. Il est identique a celui du publisher du bloc 6 : la
// derniere valeur se repete, et l'ecart aleatoire evite que tous les auditeurs reviennent ensemble.
test("applique l'escalier de reconnexion avec son ecart aleatoire", () => {
  assert.deepEqual(BACKOFF_STEPS_MS, [1000, 2000, 4000, 8000, 16000, 30000]);

  // Sans ecart, chaque tentative tombe exactement sur son palier.
  const milieu = () => 0.5;
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => backoffDelayMs(attempt, milieu)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );

  // L'ecart reste entre 80 % et 120 % du palier.
  assert.equal(backoffDelayMs(0, () => 0), 800);
  assert.equal(backoffDelayMs(0, () => 1), 1200);
});
