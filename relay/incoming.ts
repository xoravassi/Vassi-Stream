import type { RawData } from "ws";

import { inspectAudioPacket } from "../src/protocol/audio-packet.ts";

// Ce module lit et controle ce qui arrive sur une connexion, avant toute decision. Il ne garde
// aucun etat : il repond seulement « ces octets sont utilisables » ou « voici pourquoi ils ne le
// sont pas ».

// Cette fonction ramene toutes les formes de donnees de `ws` a un seul Buffer. Une trame decoupee
// par le reseau arrive sous forme de plusieurs morceaux : ils sont recolles ici.
export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

// Cette fonction rend le code court porte par une erreur de validation.
export function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "invalid_message";
}

// Cette fonction dit si un paquet audio peut etre diffuse tel quel. Elle renvoie `null` quand le
// paquet est utilisable, sinon la raison du refus.
//
// La validation vient de `src/protocol/audio-packet.ts`, le module partage avec le device et la
// page : il n'existe donc qu'une seule definition de ce qu'est un paquet valide. Le payload Opus
// n'est jamais recopie ni decode, seulement verifie a travers son en-tete.
export function checkAudioPacket(packet: Buffer, activeSessionId: number): string | null {
  let sessionId = 0;

  try {
    sessionId = inspectAudioPacket(packet).sessionId;
  } catch {
    return "invalid_packet";
  }

  if (sessionId !== activeSessionId) {
    return "session_mismatch";
  }

  return null;
}
