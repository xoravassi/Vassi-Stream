import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { FrameBridge } = require("../device/node/frame-bridge.js");
const { HEADER_SIZE } = require("../device/node/frame-reader.js");

type ReadFrame = {
  sequence: number;
  timestampMicros: bigint;
  flags: number;
  payload: Buffer;
};

// Cette fonction construit une frame VSF1 identique a celle produite par vassi.encoder~.
function buildFrame(sequence: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(HEADER_SIZE + payload.length);
  frame.write("VSF1", 0, "ascii");
  frame.writeUInt32BE(sequence, 4);
  frame.writeBigUInt64BE(BigInt(sequence) * 20000n, 8);
  frame.writeUInt8(0, 16);
  frame.writeUInt8(0, 17);
  frame.writeUInt16BE(payload.length, 18);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

// Cette fonction ouvre une connexion cliente vers le pont, comme le fait l'objet natif.
function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => resolve(socket));
    socket.on("error", reject);
  });
}

// Cette fonction attend qu'un nombre de frames soit arrive ou echoue apres une seconde.
function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const step = () => {
      if (check()) {
        return void resolve();
      }
      if (Date.now() > deadline) {
        return void reject(new Error("attente trop longue"));
      }
      setTimeout(step, 5);
    };
    step();
  });
}

test("remplace la connexion precedente par la plus recente", async () => {
  const frames: ReadFrame[] = [];
  const states: string[] = [];
  const bridge = new FrameBridge({
    onFrame: (frame: ReadFrame) => frames.push(frame),
    onStatus: (state: string) => states.push(state)
  });

  const port = await bridge.listen();
  const first = await connect(port);
  await waitFor(() => states.length === 1);

  // La seconde connexion arrive avant que Node ait vu la fermeture de la premiere.
  const second = await connect(port);
  await waitFor(() => states.length === 2);

  second.write(buildFrame(0, Buffer.from([1, 2, 3])));
  await waitFor(() => frames.length === 1);

  assert.equal(first.destroyed, true);
  assert.deepEqual(states, ["ready", "ready"]);
  assert.equal(frames[0]!.sequence, 0);

  second.destroy();
  await waitFor(() => states.length === 3);
  assert.equal(states[2], "stopped");

  await bridge.close();
});

test("survit a un consommateur de frames qui echoue", async () => {
  const states: string[] = [];
  const bridge = new FrameBridge({
    onFrame: () => {
      throw new Error("consommateur casse");
    },
    onStatus: (state: string) => states.push(state)
  });

  const port = await bridge.listen();
  const socket = await connect(port);
  await waitFor(() => states.length === 1);

  socket.write(buildFrame(0, Buffer.from([1, 2, 3])));
  await waitFor(() => states.includes("error"));

  // Le pont reste ouvert : seule l'erreur est publiee, le processus Node ne s'arrete pas.
  assert.equal(socket.destroyed, false);

  socket.destroy();
  await bridge.close();
});

test("annonce un port loopback lisible apres l'ecoute", async () => {
  const bridge = new FrameBridge({ onFrame: () => {}, onStatus: () => {} });
  const port = await bridge.listen();

  assert.ok(port > 0);
  assert.equal(bridge.port, port);

  await bridge.close();
});
