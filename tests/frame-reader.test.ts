import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { FrameReader, HEADER_SIZE, MAX_BUFFERED_BYTES } = require("../device/node/frame-reader.js");

type ReadFrame = {
  sequence: number;
  timestampMicros: bigint;
  flags: number;
  payload: Buffer;
};

// Cette fonction construit une frame VSF1 identique a celle produite par vassi.encoder~.
function buildFrame(sequence: number, timestampMicros: bigint, flags: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(HEADER_SIZE + payload.length);
  frame.write("VSF1", 0, "ascii");
  frame.writeUInt32BE(sequence, 4);
  frame.writeBigUInt64BE(timestampMicros, 8);
  frame.writeUInt8(flags, 16);
  frame.writeUInt8(0, 17);
  frame.writeUInt16BE(payload.length, 18);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

// Cette fonction cree un payload reconnaissable de la taille demandee.
function makePayload(size: number, seed: number): Buffer {
  const payload = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    payload[index] = (seed + index) & 0xff;
  }
  return payload;
}

// Ces octets sont la reference partagee avec tests/native/frame_sender.test.cpp.
const REFERENCE_FRAME = Buffer.from("56534631010203040000000005f5e10001000003aabbcc", "hex");

test("lit exactement les octets produits par l'objet natif", () => {
  const reader = new FrameReader();
  const frames: ReadFrame[] = reader.push(REFERENCE_FRAME);

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.sequence, 0x01020304);
  assert.equal(frames[0]!.timestampMicros, 100000000n);
  assert.equal(frames[0]!.flags, 1);
  assert.deepEqual(frames[0]!.payload, Buffer.from([0xaa, 0xbb, 0xcc]));
});

test("lit une frame complete recue en une fois", () => {
  const reader = new FrameReader();
  const payload = makePayload(40, 7);
  const frames: ReadFrame[] = reader.push(buildFrame(3, 60000n, 1, payload));

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.sequence, 3);
  assert.equal(frames[0]!.timestampMicros, 60000n);
  assert.equal(frames[0]!.flags, 1);
  assert.deepEqual(frames[0]!.payload, payload);
});

test("reassemble une frame coupee en trois morceaux", () => {
  const reader = new FrameReader();
  const payload = makePayload(120, 1);
  const frame = buildFrame(9, 180000n, 0, payload);

  assert.equal(reader.push(frame.subarray(0, 5)).length, 0);
  assert.equal(reader.push(frame.subarray(5, HEADER_SIZE + 10)).length, 0);

  const frames: ReadFrame[] = reader.push(frame.subarray(HEADER_SIZE + 10));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.payload, payload);
});

test("rend deux frames arrivees dans le meme morceau", () => {
  const reader = new FrameReader();
  const first = buildFrame(1, 20000n, 0, makePayload(30, 2));
  const second = buildFrame(2, 40000n, 0, makePayload(31, 3));
  const frames: ReadFrame[] = reader.push(Buffer.concat([first, second]));

  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.sequence, 1);
  assert.equal(frames[1]!.sequence, 2);
});

test("retrouve le flux apres des octets parasites", () => {
  const reader = new FrameReader();
  const payload = makePayload(24, 5);
  const noise = Buffer.from([0x00, 0x11, 0x56, 0x53, 0x22]);
  const frames: ReadFrame[] = reader.push(Buffer.concat([noise, buildFrame(4, 80000n, 0, payload)]));

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.sequence, 4);
  assert.ok(reader.resyncCount >= 1);
});

test("refuse un en-tete dont la taille de payload est impossible", () => {
  const reader = new FrameReader();
  const broken = buildFrame(5, 100000n, 0, makePayload(10, 1));
  broken.writeUInt16BE(0, 18);

  const valid = buildFrame(6, 120000n, 0, makePayload(12, 4));
  const frames: ReadFrame[] = reader.push(Buffer.concat([broken.subarray(0, HEADER_SIZE), valid]));

  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.sequence, 6);
});

test("ne garde jamais un tampon sans limite", () => {
  const reader = new FrameReader();
  const frames: ReadFrame[] = reader.push(Buffer.alloc(MAX_BUFFERED_BYTES + 1, 0x41));

  assert.equal(frames.length, 0);
  // Un flux sans magic ne laisse que les trois octets pouvant commencer un magic coupe.
  assert.ok(reader.pending.length <= 3);
});

test("rend toutes les frames d'un morceau plus grand que la limite de tampon", () => {
  const reader = new FrameReader();
  const parts: Buffer[] = [];
  const payloadSize = 1276;
  const frameCount = Math.ceil((MAX_BUFFERED_BYTES + 1) / (HEADER_SIZE + payloadSize));

  for (let index = 0; index < frameCount; index += 1) {
    parts.push(buildFrame(index, BigInt(index) * 20000n, 0, makePayload(payloadSize, index)));
  }

  const burst = Buffer.concat(parts);
  assert.ok(burst.length > MAX_BUFFERED_BYTES);

  const frames: ReadFrame[] = reader.push(burst);
  assert.equal(frames.length, frameCount);
  assert.equal(frames[frameCount - 1]!.sequence, frameCount - 1);
  assert.equal(reader.pending.length, 0);
});

test("oublie les octets en attente quand la connexion repart", () => {
  const reader = new FrameReader();
  const frame = buildFrame(8, 160000n, 0, makePayload(50, 9));

  reader.push(frame.subarray(0, 12));
  reader.reset();

  const frames: ReadFrame[] = reader.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.sequence, 8);
});
