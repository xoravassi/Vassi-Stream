// Ce module lit les messages JSON qu'un listener recoit du relais et applique les seuils de
// latence du protocole v1. Il ne touche jamais a l'audio.

export const PROTOCOL_VERSION = 1;

// Ces seuils sont normatifs : `docs/protocol-v1.md` fixe la quantite de PCM attendue avant de
// lancer ou de relancer la lecture pour chaque nom de profil. Le player n'en choisit pas d'autres.
export const LATENCY_TARGET_MS: Record<string, number> = {
  low: 200,
  balanced: 400,
  stable: 800,
};

// Un profil inconnu prend ce seuil. Refuser la session serait pire : mieux vaut un direct un peu
// long a demarrer qu'un direct qui ne demarre pas du tout.
export const DEFAULT_LATENCY_PROFILE = "balanced";

// Ce type decrit la session en cours, telle que la page a besoin de la connaitre.
export type LiveSession = {
  sessionId: number;
  bitrate: number;
  latencyProfile: string;
  targetBufferMs: number;
};

// Ce type decrit l'etat annonce par le relais : soit un direct, soit rien.
export type StreamState = {
  live: boolean;
  session: LiveSession | null;
};

// Cette fonction rend le seuil de bufferisation associe a un profil.
export function targetBufferMs(latencyProfile: string): number {
  return LATENCY_TARGET_MS[latencyProfile] ?? LATENCY_TARGET_MS[DEFAULT_LATENCY_PROFILE] ?? 400;
}

// Cette fonction lit un message `stream_state`. Elle renvoie `null` quand le texte recu n'est pas un
// etat utilisable : une page publique ne doit pas planter devant un message inattendu.
export function readStreamState(text: string): StreamState | null {
  let message: unknown = null;

  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }

  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const record = message as Record<string, unknown>;

  if (record.type !== "stream_state" || record.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }

  if (record.live !== true) {
    return { live: false, session: null };
  }

  const session = readSession(record);

  // Un etat annonce en direct mais impossible a lire est traite comme un etat hors ligne. La page
  // affiche alors « pas pret » au lieu de tenter de jouer un flux qu'elle ne sait pas decrire.
  if (session === null) {
    return { live: false, session: null };
  }

  return { live: true, session };
}

// Cette fonction lit la description d'une session en direct et refuse toute valeur hors de la v1.
function readSession(record: Record<string, unknown>): LiveSession | null {
  const sessionId = record.sessionId;
  const bitrate = record.bitrate;
  const latencyProfile = record.latencyProfile;

  if (typeof sessionId !== "number" || !Number.isInteger(sessionId) || sessionId < 1) {
    return null;
  }

  if (record.codec !== "opus" || record.channels !== 2 || record.sampleRate !== 48000) {
    return null;
  }

  if (record.frameDurationMs !== 40) {
    return null;
  }

  if (typeof bitrate !== "number" || !Number.isInteger(bitrate) || bitrate < 1) {
    return null;
  }

  const profile = typeof latencyProfile === "string" ? latencyProfile : DEFAULT_LATENCY_PROFILE;

  return {
    sessionId,
    bitrate,
    latencyProfile: profile,
    targetBufferMs: targetBufferMs(profile),
  };
}
