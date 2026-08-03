// Cette constante identifie la version commune au publisher, au relais et au player.
export const PROTOCOL_VERSION = 1;
// Cette constante identifie le codec Opus dans l'en-tete binaire.
export const CODEC_OPUS = 1;
// Cette constante impose un flux stereo dans la version 1.
export const CHANNEL_COUNT = 2;
// Cette constante represente 20 ms d'audio a 48 kHz pour chaque canal.
export const FRAME_SAMPLE_COUNT = 960;
// Cette constante fixe la taille de l'en-tete avant le payload Opus.
export const HEADER_SIZE = 28;
// Ce bit signale le premier paquet transmis apres une perte locale d'audio.
export const DISCONTINUITY_FLAG = 1;
// Cette limite contient un paquet Opus constitue d'une seule frame de 20 ms.
export const MAX_OPUS_PAYLOAD_SIZE = 1276;

const MAGIC_TEXT = "VSA1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC_TEXT);
const MAX_UINT8 = 0xff;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT64 = 0xffffffffffffffffn;

// Ce type decrit les valeurs variables utilisees pour construire un paquet audio.
export type AudioPacketInput = {
  sessionId: number;
  sequenceNumber: number;
  timestampMicros: bigint;
  payload: Uint8Array;
  flags?: number;
};

// Ce type decrit tous les champs lus dans l'en-tete binaire.
export type AudioPacketHeader = {
  protocolVersion: number;
  codec: number;
  flags: number;
  channelCount: number;
  sessionId: number;
  sequenceNumber: number;
  timestampMicros: bigint;
  sampleCount: number;
  payloadSize: number;
};

// Ce type regroupe l'en-tete valide et une copie independante du payload Opus.
export type AudioPacket = {
  header: AudioPacketHeader;
  payload: Uint8Array;
};

// Cette fonction cree un paquet audio complet avec l'en-tete v1 et le payload Opus.
export function encodeAudioPacket(input: AudioPacketInput): Uint8Array {
  const flags = input.flags ?? 0;

  assertPayload(input.payload);
  assertIntegerRange("sessionId", input.sessionId, 1, MAX_UINT32);
  assertIntegerRange("sequenceNumber", input.sequenceNumber, 0, MAX_UINT32);
  assertIntegerRange("flags", flags, 0, MAX_UINT8);
  assertKnownFlags(flags);
  assertBigIntRange("timestampMicros", input.timestampMicros, 0n, MAX_UINT64);
  assertIntegerRange(
    "payloadSize",
    input.payload.byteLength,
    1,
    MAX_OPUS_PAYLOAD_SIZE,
  );

  const packet = new Uint8Array(HEADER_SIZE + input.payload.byteLength);
  const view = new DataView(packet.buffer);

  packet.set(MAGIC_BYTES, 0);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, CODEC_OPUS);
  view.setUint8(6, flags);
  view.setUint8(7, CHANNEL_COUNT);
  view.setUint32(8, input.sessionId);
  view.setUint32(12, input.sequenceNumber);
  view.setBigUint64(16, input.timestampMicros);
  view.setUint16(24, FRAME_SAMPLE_COUNT);
  view.setUint16(26, input.payload.byteLength);
  packet.set(input.payload, HEADER_SIZE);

  return packet;
}

// Cette fonction valide un paquet audio et renvoie son en-tete sans recopier le payload.
// Le relais l'utilise pour chaque paquet diffuse : il verifie la structure puis renvoie les
// memes octets aux listeners, donc il n'a jamais besoin d'une copie du payload Opus.
export function inspectAudioPacket(source: ArrayBuffer | Uint8Array): AudioPacketHeader {
  const bytes = toBytes(source);

  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error("audio_packet_truncated_header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadSize = view.getUint16(26);
  const expectedSize = HEADER_SIZE + payloadSize;

  assertMagic(bytes);

  const header: AudioPacketHeader = {
    protocolVersion: view.getUint8(4),
    codec: view.getUint8(5),
    flags: view.getUint8(6),
    channelCount: view.getUint8(7),
    sessionId: view.getUint32(8),
    sequenceNumber: view.getUint32(12),
    timestampMicros: view.getBigUint64(16),
    sampleCount: view.getUint16(24),
    payloadSize,
  };

  validateHeader(header);

  if (bytes.byteLength !== expectedSize) {
    throw new Error("audio_packet_payload_size_mismatch");
  }

  return header;
}

// Cette fonction lit un paquet audio et renvoie ses champs si le format est valide.
export function decodeAudioPacket(source: ArrayBuffer | Uint8Array): AudioPacket {
  const bytes = toBytes(source);
  const header = inspectAudioPacket(bytes);

  return {
    header,
    payload: new Uint8Array(bytes.subarray(HEADER_SIZE)),
  };
}

// Cette fonction convertit les entrees supportees vers Uint8Array sans modifier les octets.
function toBytes(source: ArrayBuffer | Uint8Array): Uint8Array {
  if (source instanceof Uint8Array) {
    return source;
  }

  return new Uint8Array(source);
}

// Cette fonction valide la signature fixe du protocole avant de lire le contenu audio.
function assertMagic(bytes: Uint8Array): void {
  for (let index = 0; index < MAGIC_BYTES.byteLength; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw new Error("audio_packet_invalid_magic");
    }
  }
}

// Cette fonction applique les constantes v1 que le serveur doit refuser si elles changent.
function validateHeader(header: AudioPacketHeader): void {
  if (header.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("audio_packet_invalid_version");
  }

  if (header.codec !== CODEC_OPUS) {
    throw new Error("audio_packet_invalid_codec");
  }

  if ((header.flags & ~DISCONTINUITY_FLAG) !== 0) {
    throw new Error("audio_packet_invalid_flags");
  }

  if (header.channelCount !== CHANNEL_COUNT) {
    throw new Error("audio_packet_invalid_channel_count");
  }

  if (header.sampleCount !== FRAME_SAMPLE_COUNT) {
    throw new Error("audio_packet_invalid_sample_count");
  }

  if (header.sessionId === 0) {
    throw new Error("audio_packet_invalid_session_id");
  }

  if (header.payloadSize < 1 || header.payloadSize > MAX_OPUS_PAYLOAD_SIZE) {
    throw new Error("audio_packet_invalid_payload_size");
  }
}

// Cette fonction refuse une valeur qui n'est pas un tableau d'octets.
function assertPayload(payload: Uint8Array): void {
  if (!(payload instanceof Uint8Array)) {
    throw new Error("payload_invalid_type");
  }
}

// Cette fonction refuse les bits de flags qui restent reserves dans la version 1.
function assertKnownFlags(flags: number): void {
  if ((flags & ~DISCONTINUITY_FLAG) !== 0) {
    throw new Error("flags_unsupported");
  }
}

// Cette fonction refuse les nombres hors limite avant l'ecriture binaire.
function assertIntegerRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}_out_of_range`);
  }
}

// Cette fonction refuse les grands entiers hors limite avant l'ecriture binaire.
function assertBigIntRange(name: string, value: bigint, min: bigint, max: bigint): void {
  if (typeof value !== "bigint" || value < min || value > max) {
    throw new Error(`${name}_out_of_range`);
  }
}
