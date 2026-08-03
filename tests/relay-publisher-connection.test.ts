import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  AUTH_TIMEOUT_MS,
  ERROR_INTERVAL_MS,
  MISSED_PONG_LIMIT,
  PublisherConnection,
} from "../relay/publisher-connection.ts";
import type { SessionConfig } from "../relay/protocol.ts";
import { asSocket, audioPacket, FakeSocket, streamStartMessage, TEST_TOKEN } from "./relay-harness.ts";

// Ce fichier verifie les protections d'une connexion publisher qui demandent de controler le temps :
// le delai d'authentification, les pings sans reponse et la limite des messages d'erreur.

// Ce type garde ce que la connexion a annonce au serveur pendant un test.
type Traces = {
  authentifie: number;
  sessions: SessionConfig[];
  arrets: string[];
  paquets: Buffer[];
  refus: string[];
  fermetures: number;
};

// Cette fonction cree une connexion publisher branchee sur un faux socket et une horloge de test.
// La connexion est coupee a la fin du test : son minuteur d'authentification retiendrait sinon le
// processus pendant cinq secondes.
function makeConnection(t: TestContext, clock: { value: number }): {
  socket: FakeSocket;
  connection: PublisherConnection;
  traces: Traces;
} {
  const socket = new FakeSocket();
  const traces: Traces = { authentifie: 0, sessions: [], arrets: [], paquets: [], refus: [], fermetures: 0 };

  const connection = new PublisherConnection(
    asSocket(socket),
    TEST_TOKEN,
    {
      onAuthenticated: () => {
        traces.authentifie += 1;
      },
      onSessionStart: (_connection, session) => traces.sessions.push(session),
      onSessionStop: (_connection, reason) => traces.arrets.push(reason),
      onAudio: (_connection, packet) => traces.paquets.push(packet),
      onPacketRefused: (_connection, reason) => traces.refus.push(reason),
      onClosed: () => {
        traces.fermetures += 1;
      },
      onEvent: () => {},
    },
    () => clock.value,
  );

  connection.start();
  t.after(() => connection.terminate());

  return { socket, connection, traces };
}

// Cette fonction envoie un message JSON a la connexion, comme le ferait le socket.
function sendJson(socket: FakeSocket, message: Record<string, unknown>): void {
  socket.emit("message", Buffer.from(JSON.stringify(message)), false);
}

// Ce test verifie qu'une connexion muette est fermee au lieu d'occuper la place indefiniment.
test("ferme une connexion qui n'envoie pas son token a temps", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { value: 0 };
  const { socket } = makeConnection(t, clock);

  t.mock.timers.tick(AUTH_TIMEOUT_MS);

  assert.equal(socket.closedWith?.code, 1008);
  assert.equal(socket.jsonMessages()[0]?.reason, "auth_timeout");
});

// Ce test verifie que le delai d'authentification s'arrete des que le token est accepte.
test("garde la connexion ouverte apres un token accepte", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { value: 0 };
  const { socket, traces } = makeConnection(t, clock);

  sendJson(socket, { type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
  t.mock.timers.tick(AUTH_TIMEOUT_MS * 2);

  assert.equal(traces.authentifie, 1);
  assert.equal(socket.jsonMessages()[0]?.type, "auth_ok");
  assert.equal(socket.closedWith, null);
});

// Ce test verifie qu'un publisher qui ne repond plus a deux pings est coupe. Sans cette regle,
// une connexion morte garderait la place et bloquerait le prochain live.
test("coupe un publisher qui ne repond plus a deux pings", (t) => {
  const clock = { value: 0 };
  const { socket, connection } = makeConnection(t, clock);

  for (let tour = 0; tour <= MISSED_PONG_LIMIT; tour += 1) {
    connection.pingRound();
  }

  assert.equal(socket.pings, MISSED_PONG_LIMIT);
  assert.equal(socket.terminated, true);
});

// Ce test verifie qu'un signe de vie quelconque repousse la coupure.
test("garde un publisher qui repond aux pings", (t) => {
  const clock = { value: 0 };
  const { socket, connection } = makeConnection(t, clock);

  for (let tour = 0; tour < 10; tour += 1) {
    connection.pingRound();
    socket.emit("pong");
  }

  assert.equal(socket.terminated, false);
  assert.equal(socket.pings, 10);
});

// Ce test verifie qu'un publisher casse ne recoit pas cinquante messages d'erreur par seconde.
// Le compteur de paquets refuses continue pourtant d'avancer, pour rester visible en diagnostic.
test("limite les messages d'erreur a un par seconde", (t) => {
  const clock = { value: 0 };
  const { socket, connection, traces } = makeConnection(t, clock);

  sendJson(socket, { type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
  sendJson(socket, streamStartMessage(31));

  for (let index = 0; index < 5; index += 1) {
    socket.emit("message", audioPacket(999, index, 1), true);
  }

  const premiers = socket.jsonMessages().filter((message) => message.type === "server_error");
  assert.equal(premiers.length, 1);
  assert.equal(premiers[0]?.reason, "session_mismatch");
  assert.equal(connection.packetsRefused, 5);
  // Le serveur est prevenu de chaque refus, pas seulement du premier qui a produit un message.
  assert.equal(traces.refus.length, 5);
  assert.equal(traces.paquets.length, 0);

  clock.value += ERROR_INTERVAL_MS;
  socket.emit("message", audioPacket(999, 5, 1), true);

  assert.equal(socket.jsonMessages().filter((message) => message.type === "server_error").length, 2);
  assert.equal(connection.packetsRefused, 6);

  // Un paquet de la bonne session passe toujours : les refus n'ont pas casse la session.
  socket.emit("message", audioPacket(31, 0, 1), true);
  assert.equal(traces.paquets.length, 1);
});

// Ce test verifie qu'un second `stream_start` remplace la session au lieu d'en garder deux.
test("remplace la session quand le publisher en ouvre une autre", (t) => {
  const clock = { value: 0 };
  const { socket, traces } = makeConnection(t, clock);

  sendJson(socket, { type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
  sendJson(socket, streamStartMessage(10));
  sendJson(socket, streamStartMessage(11));

  assert.deepEqual(
    traces.sessions.map((session) => session.sessionId),
    [10, 11],
  );

  // Les paquets de l'ancienne session ne passent plus.
  socket.emit("message", audioPacket(10, 0, 1), true);
  assert.equal(traces.paquets.length, 0);

  socket.emit("message", audioPacket(11, 0, 1), true);
  assert.equal(traces.paquets.length, 1);
});
