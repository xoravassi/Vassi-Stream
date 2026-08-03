import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  CODEC_OPUS,
  DISCONTINUITY_FLAG,
  FRAME_SAMPLE_COUNT,
  HEADER_SIZE,
  MAX_OPUS_PAYLOAD_SIZE,
  PROTOCOL_VERSION,
  decodeAudioPacket,
  encodeAudioPacket,
  inspectAudioPacket,
  type AudioPacketInput,
} from "../src/protocol/audio-packet.ts";

const MAX_UINT32 = 0xffffffff;
const MAX_UINT64 = 0xffffffffffffffffn;

// Cette fonction construit un paquet valide reutilise par les tests de refus.
function createValidPacket(): Uint8Array {
  return encodeAudioPacket({
    sessionId: 123456789,
    sequenceNumber: 42,
    timestampMicros: 840000n,
    flags: DISCONTINUITY_FLAG,
    payload: new Uint8Array([1, 2, 3, 4, 5, 250]),
  });
}

// Cette fonction construit une entree valide dont chaque test peut remplacer un champ.
function encodeWith(overrides: Partial<AudioPacketInput>): Uint8Array {
  return encodeAudioPacket({
    sessionId: 1,
    sequenceNumber: 0,
    timestampMicros: 0n,
    payload: new Uint8Array([10, 20]),
    ...overrides,
  });
}

// Cette fonction compare exactement le code d'erreur public renvoye par le module.
function assertError(run: () => unknown, expectedMessage: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expectedMessage);
    return true;
  });
}

// Ce test compare l'encodeur a un vecteur independant qui fixe les offsets et le big-endian.
test("encode exactement le vecteur binaire canonique", () => {
  const packet = encodeAudioPacket({
    sessionId: 0x01020304,
    sequenceNumber: 0x05060708,
    timestampMicros: 0x090a0b0c0d0e0f10n,
    flags: DISCONTINUITY_FLAG,
    payload: new Uint8Array([0xaa, 0xbb]),
  });
  const expected = new Uint8Array([
    0x56, 0x53, 0x41, 0x31,
    0x01, 0x01, 0x01, 0x02,
    0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    0x03, 0xc0, 0x00, 0x02,
    0xaa, 0xbb,
  ]);

  assert.deepEqual(packet, expected);
});

// Ce test lit un vecteur independant sans reutiliser l'encodeur du module.
test("decode exactement le vecteur binaire canonique", () => {
  const packet = new Uint8Array([
    0x56, 0x53, 0x41, 0x31,
    0x01, 0x01, 0x01, 0x02,
    0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    0x03, 0xc0, 0x00, 0x02,
    0xaa, 0xbb,
  ]);

  const decoded = decodeAudioPacket(packet);

  assert.deepEqual(decoded.header, {
    protocolVersion: PROTOCOL_VERSION,
    codec: CODEC_OPUS,
    flags: DISCONTINUITY_FLAG,
    channelCount: 2,
    sessionId: 0x01020304,
    sequenceNumber: 0x05060708,
    timestampMicros: 0x090a0b0c0d0e0f10n,
    sampleCount: FRAME_SAMPLE_COUNT,
    payloadSize: 2,
  });
  assert.deepEqual(decoded.payload, new Uint8Array([0xaa, 0xbb]));
});

// Ce test verifie que tous les champs et les octets survivent a un aller-retour.
test("encode et relit un paquet audio valide", () => {
  const packet = createValidPacket();
  const decoded = decodeAudioPacket(packet);

  assert.equal(decoded.header.sessionId, 123456789);
  assert.equal(decoded.header.sequenceNumber, 42);
  assert.equal(decoded.header.timestampMicros, 840000n);
  assert.equal(decoded.header.flags, DISCONTINUITY_FLAG);
  assert.deepEqual(decoded.payload, packet.slice(HEADER_SIZE));
});

// Ce test verifie les valeurs maximales autorisees par le contrat v1.
test("accepte les bornes maximales du paquet v1", () => {
  const payload = new Uint8Array(MAX_OPUS_PAYLOAD_SIZE).fill(0x7f);
  const packet = encodeAudioPacket({
    sessionId: MAX_UINT32,
    sequenceNumber: MAX_UINT32,
    timestampMicros: MAX_UINT64,
    flags: DISCONTINUITY_FLAG,
    payload,
  });

  const decoded = decodeAudioPacket(packet);

  assert.equal(packet.byteLength, HEADER_SIZE + MAX_OPUS_PAYLOAD_SIZE);
  assert.equal(decoded.header.payloadSize, MAX_OPUS_PAYLOAD_SIZE);
  assert.deepEqual(decoded.payload, payload);
});

// Ce test verifie les deux formes binaires livrees par Node et le navigateur.
test("lit un ArrayBuffer et une vue Uint8Array avec un offset", () => {
  const packet = createValidPacket();
  const container = new Uint8Array(packet.byteLength + 4);
  container.set(packet, 2);
  const offsetView = new Uint8Array(container.buffer, 2, packet.byteLength);
  const arrayBuffer = new Uint8Array(packet).buffer;

  assert.deepEqual(decodeAudioPacket(offsetView), decodeAudioPacket(packet));
  assert.deepEqual(decodeAudioPacket(arrayBuffer), decodeAudioPacket(packet));
});

// Ce test garantit que Buffer ne transforme pas le payload retourne en vue mutable.
test("copie le payload d'un Buffer Node", () => {
  const source = Buffer.from(createValidPacket());
  const decoded = decodeAudioPacket(source);
  const firstByte = decoded.payload[0];

  source[HEADER_SIZE] = 0xff;

  assert.equal(decoded.payload[0], firstByte);
  assert.equal(Buffer.isBuffer(decoded.payload), false);
});

// Ce test verifie que le lecteur refuse un paquet plus court que l'en-tete.
// Ce test verifie que la validation sans copie applique exactement les memes regles que la lecture
// complete. Le relais utilise cette validation pour chaque paquet diffuse : il verifie la structure
// puis rediffuse les memes octets, sans jamais recopier le payload Opus.
test("valide un paquet sans recopier son payload", () => {
  const packet = createValidPacket();
  const header = inspectAudioPacket(packet);

  assert.deepEqual(header, decodeAudioPacket(packet).header);
  assert.equal(header.sessionId, 123456789);
  assert.equal(header.sequenceNumber, 42);
  assert.equal(header.flags, DISCONTINUITY_FLAG);

  assertError(() => inspectAudioPacket(packet.subarray(0, HEADER_SIZE - 1)), "audio_packet_truncated_header");
  assertError(() => inspectAudioPacket(packet.subarray(0, packet.length - 1)), "audio_packet_payload_size_mismatch");

  const magicCasse = Uint8Array.from(packet);
  magicCasse[0] = 0;
  assertError(() => inspectAudioPacket(magicCasse), "audio_packet_invalid_magic");
});

test("refuse un en-tete tronque", () => {
  assertError(
    () => decodeAudioPacket(new Uint8Array(HEADER_SIZE - 1)),
    "audio_packet_truncated_header",
  );
});

// Ces cas protegent chaque constante fixe controlee dans l'en-tete v1.
const invalidHeaderCases = [
  {
    name: "magic invalide",
    expectedMessage: "audio_packet_invalid_magic",
    mutate: (packet: Uint8Array) => { packet[0] = 0; },
  },
  {
    name: "version invalide",
    expectedMessage: "audio_packet_invalid_version",
    mutate: (packet: Uint8Array) => { packet[4] = 2; },
  },
  {
    name: "codec invalide",
    expectedMessage: "audio_packet_invalid_codec",
    mutate: (packet: Uint8Array) => { packet[5] = 2; },
  },
  {
    name: "flags reserves non nuls",
    expectedMessage: "audio_packet_invalid_flags",
    mutate: (packet: Uint8Array) => { packet[6] = 2; },
  },
  {
    name: "nombre de canaux invalide",
    expectedMessage: "audio_packet_invalid_channel_count",
    mutate: (packet: Uint8Array) => { packet[7] = 1; },
  },
  {
    name: "session nulle",
    expectedMessage: "audio_packet_invalid_session_id",
    mutate: (packet: Uint8Array) => { new DataView(packet.buffer).setUint32(8, 0); },
  },
  {
    name: "nombre d'echantillons invalide",
    expectedMessage: "audio_packet_invalid_sample_count",
    mutate: (packet: Uint8Array) => { new DataView(packet.buffer).setUint16(24, 480); },
  },
];

// Ce test execute chaque corruption fixe avec le code d'erreur attendu.
test("refuse les constantes d'en-tete invalides", async (context) => {
  for (const invalidCase of invalidHeaderCases) {
    await context.test(invalidCase.name, () => {
      const packet = createValidPacket();
      invalidCase.mutate(packet);
      assertError(() => decodeAudioPacket(packet), invalidCase.expectedMessage);
    });
  }
});

// Ce test couvre un payload reel plus court ou plus long que sa taille declaree.
test("refuse les tailles totales incoherentes", () => {
  const packet = createValidPacket();
  const shorterPacket = packet.slice(0, packet.byteLength - 1);
  const longerPacket = new Uint8Array(packet.byteLength + 1);
  longerPacket.set(packet);

  assertError(
    () => decodeAudioPacket(shorterPacket),
    "audio_packet_payload_size_mismatch",
  );
  assertError(
    () => decodeAudioPacket(longerPacket),
    "audio_packet_payload_size_mismatch",
  );
});

// Ce test refuse les tailles de payload interdites avant toute copie audio.
test("refuse un payload decode vide ou trop grand", () => {
  const emptyPacket = createValidPacket().slice(0, HEADER_SIZE);
  new DataView(emptyPacket.buffer).setUint16(26, 0);

  const largePacket = new Uint8Array(HEADER_SIZE + MAX_OPUS_PAYLOAD_SIZE + 1);
  largePacket.set(createValidPacket().subarray(0, HEADER_SIZE));
  new DataView(largePacket.buffer).setUint16(26, MAX_OPUS_PAYLOAD_SIZE + 1);

  assertError(
    () => decodeAudioPacket(emptyPacket),
    "audio_packet_invalid_payload_size",
  );
  assertError(
    () => decodeAudioPacket(largePacket),
    "audio_packet_invalid_payload_size",
  );
});

// Ces cas protegent toutes les bornes numeriques controlees avant l'encodage.
const invalidInputCases: Array<{
  name: string;
  overrides: Partial<AudioPacketInput>;
  expectedMessage: string;
}> = [
  { name: "session nulle", overrides: { sessionId: 0 }, expectedMessage: "sessionId_out_of_range" },
  { name: "session decimale", overrides: { sessionId: 1.5 }, expectedMessage: "sessionId_out_of_range" },
  { name: "session trop grande", overrides: { sessionId: MAX_UINT32 + 1 }, expectedMessage: "sessionId_out_of_range" },
  { name: "sequence negative", overrides: { sequenceNumber: -1 }, expectedMessage: "sequenceNumber_out_of_range" },
  { name: "sequence decimale", overrides: { sequenceNumber: 1.5 }, expectedMessage: "sequenceNumber_out_of_range" },
  { name: "sequence trop grande", overrides: { sequenceNumber: MAX_UINT32 + 1 }, expectedMessage: "sequenceNumber_out_of_range" },
  { name: "timestamp negatif", overrides: { timestampMicros: -1n }, expectedMessage: "timestampMicros_out_of_range" },
  { name: "timestamp trop grand", overrides: { timestampMicros: MAX_UINT64 + 1n }, expectedMessage: "timestampMicros_out_of_range" },
  { name: "flag negatif", overrides: { flags: -1 }, expectedMessage: "flags_out_of_range" },
  { name: "flag trop grand", overrides: { flags: 256 }, expectedMessage: "flags_out_of_range" },
  { name: "flag reserve", overrides: { flags: 2 }, expectedMessage: "flags_unsupported" },
  { name: "payload vide", overrides: { payload: new Uint8Array() }, expectedMessage: "payloadSize_out_of_range" },
  { name: "payload trop grand", overrides: { payload: new Uint8Array(MAX_OPUS_PAYLOAD_SIZE + 1) }, expectedMessage: "payloadSize_out_of_range" },
];

// Ce test execute chaque entree hors contrat avec son code d'erreur exact.
test("refuse les entrees d'encodage hors limites", async (context) => {
  for (const invalidCase of invalidInputCases) {
    await context.test(invalidCase.name, () => {
      assertError(
        () => encodeWith(invalidCase.overrides),
        invalidCase.expectedMessage,
      );
    });
  }
});

// Ce test controle aussi les types a l'execution aux frontieres avec Max et Node.
test("refuse les types invalides a l'execution", () => {
  assertError(
    () => encodeWith({
      payload: new ArrayBuffer(2) as unknown as Uint8Array,
    }),
    "payload_invalid_type",
  );
  assertError(
    () => encodeWith({
      timestampMicros: 0 as unknown as bigint,
    }),
    "timestampMicros_out_of_range",
  );
});
