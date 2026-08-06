// Ce module applique la partie JSON de `docs/protocol-v1.md` du cote du relais : il lit les
// messages du publisher et construit les messages du serveur. Il ne touche jamais a l'audio.

export const PROTOCOL_VERSION = 1;

// Ces valeurs sont les seules acceptees par la version 1.1. Toute autre valeur est refusee.
export const ALLOWED_BITRATES = [128000, 192000, 256000];
export const ALLOWED_LATENCY_PROFILES = ["low", "balanced", "stable"];
export const ALLOWED_STOP_REASONS = ["user_stop", "error"];
export const OUTPUT_SAMPLE_RATE = 48000;
export const CHANNEL_COUNT = 2;
export const FRAME_DURATION_MS = 40;
export const MAX_SESSION_ID = 4294967295;

// Ce type decrit la session annoncee par `stream_start` et rediffusee aux listeners.
export type SessionConfig = {
  sessionId: number;
  bitrate: number;
  latencyProfile: string;
};

// Cette fonction lit un message JSON du publisher et refuse tout ce qui n'est pas du protocole v1.
export function parseClientMessage(text: string): Record<string, unknown> {
  let message: unknown = null;

  try {
    message = JSON.parse(text);
  } catch {
    throw new Error("invalid_json");
  }

  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("invalid_json");
  }

  const record = message as Record<string, unknown>;

  if (typeof record.type !== "string" || record.type === "") {
    throw new Error("missing_type");
  }

  if (record.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("unsupported_protocol_version");
  }

  return record;
}

// Cette fonction lit un `stream_start` et refuse une session que le player ne saurait pas jouer.
// Le relais ne decode pas l'audio : ces champs sont la seule description de la session, donc ils
// doivent etre exacts avant d'etre rediffuses aux listeners.
export function readStreamStart(message: Record<string, unknown>): SessionConfig {
  const sessionId = readSessionId(message.sessionId);

  if (message.codec !== "opus") {
    throw new Error("invalid_codec");
  }

  if (typeof message.bitrate !== "number" || !ALLOWED_BITRATES.includes(message.bitrate)) {
    throw new Error("invalid_bitrate");
  }

  if (message.sampleRate !== OUTPUT_SAMPLE_RATE) {
    throw new Error("invalid_sample_rate");
  }

  if (message.channels !== CHANNEL_COUNT) {
    throw new Error("invalid_channels");
  }

  if (message.frameDurationMs !== FRAME_DURATION_MS) {
    throw new Error("invalid_frame_duration");
  }

  if (typeof message.latencyProfile !== "string" || !ALLOWED_LATENCY_PROFILES.includes(message.latencyProfile)) {
    throw new Error("invalid_latency_profile");
  }

  return {
    sessionId,
    bitrate: message.bitrate,
    latencyProfile: message.latencyProfile,
  };
}

// Cette fonction lit un `stream_stop` et renvoie la session visee.
export function readStreamStop(message: Record<string, unknown>): number {
  const sessionId = readSessionId(message.sessionId);

  if (typeof message.reason !== "string" || !ALLOWED_STOP_REASONS.includes(message.reason)) {
    throw new Error("invalid_stop_reason");
  }

  return sessionId;
}

// Cette fonction refuse un identifiant de session hors de la plage du protocole.
// La valeur zero reste invalide : elle signalerait une session non initialisee.
function readSessionId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SESSION_ID) {
    throw new Error("invalid_session_id");
  }

  return value;
}

// Cette fonction construit la reponse envoyee quand le token est accepte.
export function buildAuthOk(): string {
  return JSON.stringify({ type: "auth_ok", protocolVersion: PROTOCOL_VERSION });
}

// Cette fonction construit la reponse envoyee quand le token est absent ou refuse.
export function buildAuthError(reason: string): string {
  return JSON.stringify({ type: "auth_error", protocolVersion: PROTOCOL_VERSION, reason });
}

// Cette fonction construit le message d'erreur recuperable envoye au publisher.
export function buildServerError(reason: string): string {
  return JSON.stringify({ type: "server_error", protocolVersion: PROTOCOL_VERSION, reason });
}

// Cette fonction construit l'etat envoye aux listeners. Une session absente donne l'etat hors ligne.
export function buildStreamState(session: SessionConfig | null): string {
  if (session === null) {
    return JSON.stringify({ type: "stream_state", protocolVersion: PROTOCOL_VERSION, live: false });
  }

  return JSON.stringify({
    type: "stream_state",
    protocolVersion: PROTOCOL_VERSION,
    live: true,
    sessionId: session.sessionId,
    codec: "opus",
    bitrate: session.bitrate,
    sampleRate: OUTPUT_SAMPLE_RATE,
    channels: CHANNEL_COUNT,
    frameDurationMs: FRAME_DURATION_MS,
    latencyProfile: session.latencyProfile,
  });
}
