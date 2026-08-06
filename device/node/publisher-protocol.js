"use strict";

const crypto = require("crypto");

// Ces constantes sont celles de docs/protocol-v1.md. Elles ne changent pas dans la version 1.1.
const PROTOCOL_VERSION = 1;
const CODEC_OPUS = 1;
const CHANNEL_COUNT = 2;
const FRAME_SAMPLE_COUNT = 1920;
const FRAME_DURATION_MS = 40;
const OUTPUT_SAMPLE_RATE = 48000;
const HEADER_SIZE = 28;
const MAX_PAYLOAD_SIZE = 2560;
const DISCONTINUITY_FLAG = 1;
const MAX_UINT32 = 4294967295;
const MAX_UINT64 = 18446744073709551615n;
const MAGIC = Buffer.from("VSA1", "ascii");

// Ces valeurs sont les seules acceptees par le relais pour un `stream_start`.
const ALLOWED_BITRATES = [128000, 192000, 256000];
const ALLOWED_LATENCY_PROFILES = ["low", "balanced", "stable"];

// Ces valeurs sont les defauts de la roadmap : Studio pour la qualite, Equilibree pour la latence.
const DEFAULT_BITRATE = 256000;
const DEFAULT_LATENCY_PROFILE = "balanced";

// Cette fonction tire un identifiant de session sur quatre octets aleatoires.
// Elle recommence tant que le resultat vaut zero ou repete la session precedente,
// parce que le protocole reserve zero a une valeur non initialisee.
function createSessionId(previousSessionId = 0) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidate = crypto.randomBytes(4).readUInt32BE(0);
		if (candidate !== 0 && candidate !== previousSessionId) {
			return candidate;
		}
	}

	throw new Error("session_id_indisponible");
}

// Cette fonction construit le message d'authentification envoye juste apres l'ouverture.
function buildAuthMessage(token) {
	return JSON.stringify({
		type: "publisher_auth",
		protocolVersion: PROTOCOL_VERSION,
		token
	});
}

// Cette fonction construit le message qui ouvre une session avant la premiere frame audio.
function buildStreamStart(session) {
	return JSON.stringify({
		type: "stream_start",
		protocolVersion: PROTOCOL_VERSION,
		sessionId: checkedSessionId(session.sessionId),
		codec: "opus",
		bitrate: checkedBitrate(session.bitrate),
		sampleRate: OUTPUT_SAMPLE_RATE,
		channels: CHANNEL_COUNT,
		frameDurationMs: FRAME_DURATION_MS,
		latencyProfile: checkedLatencyProfile(session.latencyProfile)
	});
}

// Cette fonction construit le message qui ferme proprement une session.
function buildStreamStop(sessionId, reason) {
	if (reason !== "user_stop" && reason !== "error") {
		throw new Error("stream_stop_raison_invalide");
	}

	return JSON.stringify({
		type: "stream_stop",
		protocolVersion: PROTOCOL_VERSION,
		sessionId: checkedSessionId(sessionId),
		reason
	});
}

// Cette fonction lit un message JSON du relais et refuse tout ce qui n'est pas du protocole v1.
function parseServerMessage(text) {
	let message = null;

	try {
		message = JSON.parse(text);
	} catch (error) {
		throw new Error("message_json_invalide");
	}

	if (message === null || typeof message !== "object" || Array.isArray(message)) {
		throw new Error("message_json_invalide");
	}

	if (typeof message.type !== "string" || message.type === "") {
		throw new Error("message_type_absent");
	}

	if (message.protocolVersion !== PROTOCOL_VERSION) {
		throw new Error("message_version_invalide");
	}

	return message;
}

// Cette fonction construit le paquet binaire public a partir d'une frame du pont loopback.
// Le payload Opus est recopie tel quel : le publisher ne touche jamais aux octets de l'encodeur.
function encodeAudioPacket(input) {
	const payload = input.payload;

	if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
		throw new Error("payload_type_invalide");
	}

	if (payload.length < 1 || payload.length > MAX_PAYLOAD_SIZE) {
		throw new Error("payload_taille_invalide");
	}

	const flags = input.flags ?? 0;
	if (!Number.isInteger(flags) || (flags & ~DISCONTINUITY_FLAG) !== 0) {
		throw new Error("flags_invalides");
	}

	checkedSessionId(input.sessionId);

	if (!Number.isInteger(input.sequenceNumber) || input.sequenceNumber < 0 || input.sequenceNumber > MAX_UINT32) {
		throw new Error("sequence_hors_limites");
	}

	const timestamp = BigInt(input.timestampMicros);
	if (timestamp < 0n || timestamp > MAX_UINT64) {
		throw new Error("timestamp_hors_limites");
	}

	const packet = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
	MAGIC.copy(packet, 0);
	packet.writeUInt8(PROTOCOL_VERSION, 4);
	packet.writeUInt8(CODEC_OPUS, 5);
	packet.writeUInt8(flags, 6);
	packet.writeUInt8(CHANNEL_COUNT, 7);
	packet.writeUInt32BE(input.sessionId, 8);
	packet.writeUInt32BE(input.sequenceNumber, 12);
	packet.writeBigUInt64BE(timestamp, 16);
	packet.writeUInt16BE(FRAME_SAMPLE_COUNT, 24);
	packet.writeUInt16BE(payload.length, 26);
	Buffer.from(payload.buffer, payload.byteOffset, payload.length).copy(packet, HEADER_SIZE);

	return packet;
}

// Cette fonction refuse un identifiant de session hors de la plage du protocole.
function checkedSessionId(value) {
	if (!Number.isInteger(value) || value < 1 || value > MAX_UINT32) {
		throw new Error("session_id_invalide");
	}

	return value;
}

// Cette fonction refuse un debit qui ne fait pas partie des trois profils de qualite.
function checkedBitrate(value) {
	if (!ALLOWED_BITRATES.includes(value)) {
		throw new Error("bitrate_invalide");
	}

	return value;
}

// Cette fonction refuse un profil de latence inconnu du player.
function checkedLatencyProfile(value) {
	if (!ALLOWED_LATENCY_PROFILES.includes(value)) {
		throw new Error("profil_latence_invalide");
	}

	return value;
}

module.exports = {
	PROTOCOL_VERSION,
	HEADER_SIZE,
	MAX_PAYLOAD_SIZE,
	MAX_UINT32,
	DISCONTINUITY_FLAG,
	FRAME_DURATION_MS,
	OUTPUT_SAMPLE_RATE,
	ALLOWED_BITRATES,
	ALLOWED_LATENCY_PROFILES,
	DEFAULT_BITRATE,
	DEFAULT_LATENCY_PROFILE,
	createSessionId,
	buildAuthMessage,
	buildStreamStart,
	buildStreamStop,
	parseServerMessage,
	encodeAudioPacket
};
