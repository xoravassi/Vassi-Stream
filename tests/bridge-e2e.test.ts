import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

// Le pont du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { FrameBridge } = require("../device/node/frame-bridge.js");

const NATIVE_STREAM_EXE = join(
  process.cwd(),
  ".local",
  "build",
  "vassi.encoder",
  "Release",
  "vassi_frame_sender_test.exe"
);
const FRAME_COUNT = 250;

type ReadFrame = {
  sequence: number;
  timestampMicros: bigint;
  flags: number;
  payload: Buffer;
};

// Cette fonction reproduit le payload deterministe genere par le binaire natif.
function expectedPayload(sequence: number): Buffer {
  const size = 40 + (sequence % 100);
  const payload = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    payload[index] = (sequence + index) & 0xff;
  }
  return payload;
}

// Cette fonction lance le producteur natif sur le port annonce par le pont.
function runNativeStream(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      NATIVE_STREAM_EXE,
      ["--stream", String(port), String(FRAME_COUNT)],
      (error) => (error ? reject(error) : resolve())
    );
  });
}

// Ce test verifie que Node recoit exactement les octets emis par l'objet natif.
test(
  "recoit dans Node les memes octets que ceux produits par l'objet natif",
  { skip: existsSync(NATIVE_STREAM_EXE) ? false : "binaire natif absent : lancer npm run test:bridge" },
  async () => {
    const received: ReadFrame[] = [];
    const states: string[] = [];
    const bridge = new FrameBridge({
      onFrame: (frame: ReadFrame) => received.push(frame),
      onStatus: (state: string) => states.push(state)
    });

    const port = await bridge.listen();
    const finished = new Promise<void>((resolve) => {
      const wait = () => {
        if (received.length >= FRAME_COUNT) {
          return void resolve();
        }
        setTimeout(wait, 10);
      };
      wait();
    });

    await runNativeStream(port);
    await finished;
    await bridge.close();

    assert.equal(received.length, FRAME_COUNT);
    assert.ok(states.includes("ready"));

    for (let index = 0; index < FRAME_COUNT; index += 1) {
      const frame = received[index]!;
      assert.equal(frame.sequence, index);
      assert.equal(frame.timestampMicros, BigInt(index) * 40000n);
      assert.equal(frame.flags, index % 50 === 0 ? 1 : 0);
      assert.deepEqual(frame.payload, expectedPayload(index));
    }
  }
);
