import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

// Ce module contient les reponses HTTP ordinaires du relais : la route de sante, les refus, et le
// refus d'une demande de connexion WebSocket. Il ne connait ni le publisher ni les auditeurs.

// Cette fonction lit le chemin demande sans faire confiance a l'URL recue. Une URL illisible
// renvoie la racine plutot qu'une exception : une requete abimee ne doit pas arreter le relais.
export function pathOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://relay.invalid").pathname;
  } catch {
    return "/";
  }
}

// Cette fonction repond en JSON a une requete HTTP ordinaire.
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);

  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

// Cette fonction repond aux requetes HTTP qui ne sont pas des connexions WebSocket.
// La route de sante repond toujours 200 : un hebergeur qui recoit autre chose considere le service
// en panne et redemarre le conteneur. La racine repond pareil, parce que c'est le chemin interroge
// par defaut tant qu'aucun autre n'est configure.
export function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  health: () => unknown,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const path = pathOf(request.url);

  if (path === "/health" || path === "/") {
    sendJson(response, 200, health());
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

// Cette fonction refuse une demande de connexion WebSocket avant toute negociation. Refuser ici
// coute moins qu'ouvrir une connexion pour la fermer aussitot.
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch {
    // Le client est deja parti.
  }

  socket.destroy();
}
