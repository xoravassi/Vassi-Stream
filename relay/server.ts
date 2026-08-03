import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { RelayConfig } from "./config.ts";
import { handleHttpRequest, pathOf, rejectUpgrade } from "./http-routes.ts";
import { ListenerHub } from "./listener-hub.ts";
import { log, type LogFields } from "./log.ts";
import { PublisherConnection } from "./publisher-connection.ts";
import type { SessionConfig } from "./protocol.ts";

// Ce module assemble le relais : un serveur HTTP pour la sante, deux chemins WebSocket, un seul
// publisher en direct et la liste des auditeurs. Il ne decode jamais l'audio.

// Le protocole demande un ping serveur toutes les vingt secondes. Il garde aussi la connexion
// vivante a travers les proxys, qui ferment souvent une connexion inactive.
export const PING_INTERVAL_MS = 20000;
// Plusieurs connexions publisher peuvent attendre leur token en meme temps, par exemple pendant une
// reconnexion. Cette limite empeche un inconnu d'ouvrir des connexions sans jamais s'authentifier.
export const MAX_PENDING_PUBLISHERS = 4;
// Le plus grand paquet audio du protocole fait 1304 octets. Cette limite refuse tout de suite une
// trame plus grande, avant qu'elle occupe la memoire du relais.
const PUBLISHER_MAX_PAYLOAD = 2048;
// Les auditeurs n'envoient rien : une trame de leur part est deja une faute.
const LISTENER_MAX_PAYLOAD = 512;

// Ce type decrit l'etat public renvoye par la route de sante.
export type RelayHealth = {
  status: string;
  live: boolean;
  sessionId: number | null;
  listeners: number;
  lastPacketAgeMs: number | null;
  uptimeSeconds: number;
  framesRelayed: number;
  bytesRelayed: number;
  packetsRefused: number;
  sessions: number;
  listenersRefused: number;
  listenersClosedSlow: number;
  listenersClosedSilent: number;
  listenerFramesDropped: number;
};

// Cette classe tient le relais complet et reste utilisable directement dans un test.
export class RelayServer {
  readonly hub: ListenerHub;

  private config: RelayConfig;
  private http: Server;
  private publisherServer: WebSocketServer;
  private listenerServer: WebSocketServer;
  private publishers = new Set<PublisherConnection>();
  private current: PublisherConnection | null = null;
  private session: SessionConfig | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private lastPacketAt = 0;
  private stats = { framesRelayed: 0, bytesRelayed: 0, packetsRefused: 0, sessions: 0 };
  private onEvent: (event: string, fields?: LogFields) => void;

  constructor(config: RelayConfig, options: { onEvent?: (event: string, fields?: LogFields) => void } = {}) {
    this.config = config;
    this.onEvent = options.onEvent ?? log;
    this.hub = new ListenerHub({ maxListeners: config.maxListeners, onEvent: this.onEvent });

    // L'audio Opus est deja compresse : `perMessageDeflate` couterait du temps sans rien gagner.
    this.publisherServer = new WebSocketServer({
      noServer: true,
      maxPayload: PUBLISHER_MAX_PAYLOAD,
      perMessageDeflate: false,
    });
    this.listenerServer = new WebSocketServer({
      noServer: true,
      maxPayload: LISTENER_MAX_PAYLOAD,
      perMessageDeflate: false,
    });

    this.http = createServer((request, response) => handleHttpRequest(request, response, () => this.health()));
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.publisherServer.on("connection", (socket) => this.acceptPublisher(socket));
    this.listenerServer.on("connection", (socket) => this.hub.add(socket));
  }

  // Cette methode ouvre le port et renvoie le port reellement obtenu. Le port zero sert aux tests.
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.http.once("error", onError);
      this.http.listen(this.config.port, "0.0.0.0", () => {
        this.http.removeListener("error", onError);
        resolve();
      });
    });

    this.startedAt = Date.now();
    this.pingTimer = setInterval(() => this.pingRound(), PING_INTERVAL_MS);
    // Le serveur HTTP suffit a garder le processus vivant : ce minuteur n'a pas a le faire.
    this.pingTimer.unref();

    const address = this.http.address();
    return typeof address === "object" && address !== null ? address.port : this.config.port;
  }

  // Cette methode ferme tout : auditeurs, publisher, minuteur et port HTTP.
  async close(): Promise<void> {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.hub.closeAll();

    for (const publisher of [...this.publishers]) {
      publisher.terminate();
    }

    this.publishers.clear();
    this.current = null;
    this.session = null;

    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      // Les connexions WebSocket restantes empecheraient la fermeture du port.
      this.http.closeAllConnections();
    });
  }

  // Cette methode annonce la fin du direct aux auditeurs avant l'arret du relais, pour qu'ils
  // affichent l'etat hors ligne au lieu d'une simple coupure.
  announceShutdown(): void {
    this.setSession(null, "relay_shutdown");
  }

  // Cette methode rend l'etat public du relais, sans aucun secret.
  health(): RelayHealth {
    const now = Date.now();

    return {
      status: "ok",
      live: this.session !== null,
      sessionId: this.session === null ? null : this.session.sessionId,
      listeners: this.hub.size,
      lastPacketAgeMs: this.lastPacketAt === 0 ? null : now - this.lastPacketAt,
      uptimeSeconds: Math.round((now - this.startedAt) / 1000),
      framesRelayed: this.stats.framesRelayed,
      bytesRelayed: this.stats.bytesRelayed,
      packetsRefused: this.stats.packetsRefused,
      sessions: this.stats.sessions,
      listenersRefused: this.hub.stats.refused,
      listenersClosedSlow: this.hub.stats.closedSlow,
      listenersClosedSilent: this.hub.stats.closedSilent,
      // Ce compteur est le premier a regarder quand un auditeur signale des trous dans le son :
      // il distingue un probleme de reception chez lui d'un probleme entre Ableton et le relais.
      listenerFramesDropped: this.hub.stats.framesDropped,
    };
  }

  // Cette methode dirige une demande de connexion WebSocket vers le bon chemin.
  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = pathOf(request.url);

    if (path === "/publisher") {
      if (this.pendingPublishers() >= MAX_PENDING_PUBLISHERS) {
        this.onEvent("publisher_refuse_limite");
        rejectUpgrade(socket, 503, "too_many_publishers");
        return;
      }

      this.publisherServer.handleUpgrade(request, socket, head, (client) => {
        this.publisherServer.emit("connection", client, request);
      });
      return;
    }

    if (path === "/listener") {
      if (!this.hub.hasRoom) {
        this.hub.countRefused();
        this.onEvent("listener_refuse_limite", { listeners: this.hub.size });
        rejectUpgrade(socket, 503, "too_many_listeners");
        return;
      }

      this.listenerServer.handleUpgrade(request, socket, head, (client) => {
        this.listenerServer.emit("connection", client, request);
      });
      return;
    }

    rejectUpgrade(socket, 404, "unknown_path");
  }

  // Cette methode prepare une connexion publisher et attend son token.
  private acceptPublisher(socket: WebSocket): void {
    const connection = new PublisherConnection(socket, this.config.publisherToken, {
      onAuthenticated: (publisher) => this.handleAuthenticated(publisher),
      onSessionStart: (publisher, session) => this.handleSessionStart(publisher, session),
      onSessionStop: (publisher, reason) => this.handleSessionStop(publisher, reason),
      onAudio: (publisher, packet) => this.handleAudio(publisher, packet),
      onPacketRefused: () => {
        this.stats.packetsRefused += 1;
      },
      onClosed: (publisher) => this.handleClosed(publisher),
      onEvent: this.onEvent,
    });

    this.publishers.add(connection);
    this.onEvent("publisher_connecte", { pending: this.pendingPublishers() });
    connection.start();
  }

  // Cette methode garde un seul publisher en direct. Le dernier authentifie remplace le precedent :
  // une connexion morte que le relais n'a pas encore detectee bloquerait sinon tout nouveau live
  // jusqu'a son propre delai de silence.
  private handleAuthenticated(connection: PublisherConnection): void {
    const previous = this.current;

    if (previous !== null && previous !== connection) {
      this.setSession(null, "publisher_replaced");
      previous.replace();
      this.publishers.delete(previous);
    }

    this.current = connection;
    this.onEvent("publisher_authentifie");
  }

  // Cette methode ouvre la session annoncee et previent les auditeurs avant tout paquet audio.
  private handleSessionStart(connection: PublisherConnection, session: SessionConfig): void {
    if (connection !== this.current) {
      return;
    }

    this.stats.sessions += 1;
    this.setSession(session, "session_ouverte");
  }

  // Cette methode ferme la session courante a la demande du publisher.
  private handleSessionStop(connection: PublisherConnection, reason: string): void {
    if (connection !== this.current) {
      return;
    }

    this.setSession(null, reason);
  }

  // Cette methode diffuse un paquet deja valide, sans modifier un seul octet.
  private handleAudio(connection: PublisherConnection, packet: Buffer): void {
    if (connection !== this.current || this.session === null) {
      return;
    }

    this.stats.framesRelayed += 1;
    this.stats.bytesRelayed += packet.length;
    this.lastPacketAt = Date.now();
    this.hub.broadcast(packet);
  }

  // Cette methode traite la disparition d'une connexion publisher.
  private handleClosed(connection: PublisherConnection): void {
    this.publishers.delete(connection);

    if (connection !== this.current) {
      return;
    }

    this.current = null;
    // Le publisher a disparu sans `stream_stop` : les auditeurs repassent hors ligne tout de suite.
    this.setSession(null, "publisher_disparu");
  }

  // Cette methode change l'etat du direct et l'annonce aux auditeurs une seule fois.
  private setSession(session: SessionConfig | null, reason: string): void {
    if (session === null && this.session === null) {
      return;
    }

    this.session = session;
    this.hub.setSession(session);
    this.onEvent(session === null ? "direct_arrete" : "direct_demarre", {
      reason,
      sessionId: session === null ? null : session.sessionId,
      listeners: this.hub.size,
    });
  }

  // Cette methode envoie un ping a tout le monde et coupe les connexions qui ne repondent plus.
  private pingRound(): void {
    this.hub.pingRound();

    for (const publisher of [...this.publishers]) {
      publisher.pingRound();
    }
  }

  // Cette methode compte les connexions publisher qui n'ont pas encore donne de token valide.
  private pendingPublishers(): number {
    let pending = 0;

    for (const publisher of this.publishers) {
      if (!publisher.authenticated) {
        pending += 1;
      }
    }

    return pending;
  }
}
