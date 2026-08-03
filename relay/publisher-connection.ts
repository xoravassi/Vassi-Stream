import { WebSocket, type RawData } from "ws";

import { checkAudioPacket, errorCode, toBuffer } from "./incoming.ts";
import {
  buildAuthError,
  buildAuthOk,
  buildServerError,
  parseClientMessage,
  readStreamStart,
  readStreamStop,
  type SessionConfig,
} from "./protocol.ts";
import { tokensMatch } from "./token.ts";
import type { LogFields } from "./log.ts";

// Ce module tient une connexion publisher : authentification, ouverture de session, validation des
// paquets audio. Il ne connait ni les auditeurs ni le serveur HTTP : il previent par des rappels.

// Le publisher doit envoyer son token tout de suite. Une connexion muette est fermee.
export const AUTH_TIMEOUT_MS = 5000;
// Un publisher qui ne repond pas a deux pings de suite est considere disparu.
export const MISSED_PONG_LIMIT = 2;
// Un paquet refuse est signale au plus une fois par seconde. Sans cette limite, un publisher qui
// envoie cinquante paquets invalides par seconde recevrait cinquante messages d'erreur par seconde.
export const ERROR_INTERVAL_MS = 1000;

// Ces codes de fermeture WebSocket viennent de la RFC 6455.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_POLICY_VIOLATION = 1008;

// Ce type regroupe les rappels que le serveur fournit a chaque connexion publisher.
export type PublisherCallbacks = {
  onAuthenticated: (connection: PublisherConnection) => void;
  onSessionStart: (connection: PublisherConnection, session: SessionConfig) => void;
  onSessionStop: (connection: PublisherConnection, reason: string) => void;
  onAudio: (connection: PublisherConnection, packet: Buffer) => void;
  onPacketRefused: (connection: PublisherConnection, reason: string) => void;
  onClosed: (connection: PublisherConnection) => void;
  onEvent: (event: string, fields?: LogFields) => void;
};

// Cette classe applique le protocole v1 a une seule connexion publisher.
export class PublisherConnection {
  authenticated = false;
  session: SessionConfig | null = null;
  // Ce compteur totalise les paquets refuses depuis l'ouverture de la connexion. Il ne redemarre pas
  // a chaque session : un publisher qui perd des paquets entre deux sessions reste visible.
  packetsRefused = 0;

  private socket: WebSocket;
  private token: string;
  private callbacks: PublisherCallbacks;
  private authTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  // Cette valeur de depart laisse toujours passer le premier message d'erreur, quelle que soit
  // l'origine de l'horloge utilisee.
  private lastErrorAt = Number.NEGATIVE_INFINITY;
  private now: () => number;

  constructor(socket: WebSocket, token: string, callbacks: PublisherCallbacks, now: () => number = Date.now) {
    this.socket = socket;
    this.token = token;
    this.callbacks = callbacks;
    this.now = now;
  }

  // Cette methode branche les evenements de la connexion et limite l'attente du token.
  start(): void {
    this.authTimer = setTimeout(() => this.refuse("auth_timeout"), AUTH_TIMEOUT_MS);

    this.socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
    this.socket.on("ping", () => this.markAlive());
    this.socket.on("pong", () => this.markAlive());
    this.socket.on("error", () => this.terminate());
    this.socket.on("close", () => this.handleClose());
  }

  // Cette methode envoie un ping et coupe la connexion restee sans reponse.
  pingRound(): void {
    if (this.missedPongs >= MISSED_PONG_LIMIT) {
      this.callbacks.onEvent("publisher_silencieux");
      this.terminate();
      return;
    }

    this.missedPongs += 1;

    try {
      this.socket.ping();
    } catch {
      this.terminate();
    }
  }

  // Cette methode ferme la connexion quand un autre publisher authentifie prend la place.
  replace(): void {
    this.send(buildServerError("publisher_replaced"));
    this.close(CLOSE_NORMAL, "publisher_replaced");
  }

  // Cette methode ferme la connexion en annoncant un code clair.
  close(code: number, reason: string): void {
    this.clearAuthTimer();

    try {
      this.socket.close(code, reason);
    } catch {
      this.terminate();
    }
  }

  // Cette methode coupe la connexion sans attendre la fin de sa file d'envoi.
  terminate(): void {
    this.clearAuthTimer();

    try {
      this.socket.terminate();
    } catch {
      // Une connexion deja fermee n'a plus rien a couper.
    }
  }

  // Cette methode traite un message recu. Un message binaire est un paquet audio, un message texte
  // fait partie du protocole JSON.
  private handleMessage(data: RawData, isBinary: boolean): void {
    this.markAlive();

    if (isBinary) {
      this.handleAudio(toBuffer(data));
      return;
    }

    let message: Record<string, unknown>;

    try {
      message = parseClientMessage(toBuffer(data).toString("utf8"));
    } catch (error) {
      this.refuse(errorCode(error));
      return;
    }

    if (message.type === "publisher_auth") {
      this.handleAuth(message);
      return;
    }

    // Tout le reste demande un token accepte : sans lui, la connexion n'a aucun droit.
    if (!this.authenticated) {
      this.refuse("not_authenticated");
      return;
    }

    if (message.type === "stream_start") {
      this.handleStreamStart(message);
      return;
    }

    if (message.type === "stream_stop") {
      this.handleStreamStop(message);
      return;
    }

    this.sendLimitedError("unsupported_message");
  }

  // Cette methode verifie le token en temps constant et ouvre les droits du publisher.
  private handleAuth(message: Record<string, unknown>): void {
    if (this.authenticated) {
      // Une seconde authentification ne change rien et ne doit pas rouvrir de session.
      this.sendLimitedError("already_authenticated");
      return;
    }

    if (!tokensMatch(this.token, message.token)) {
      this.callbacks.onEvent("publisher_token_refuse");
      this.send(buildAuthError("invalid_token"));
      this.close(CLOSE_POLICY_VIOLATION, "invalid_token");
      return;
    }

    this.authenticated = true;
    this.clearAuthTimer();
    this.send(buildAuthOk());
    this.callbacks.onAuthenticated(this);
  }

  // Cette methode ouvre une session. Une session deja ouverte est remplacee : le protocole prevoit
  // qu'un nouveau `stream_start` produise un nouvel etat pour les auditeurs.
  private handleStreamStart(message: Record<string, unknown>): void {
    let session: SessionConfig;

    try {
      session = readStreamStart(message);
    } catch (error) {
      this.refuse(errorCode(error));
      return;
    }

    this.session = session;
    this.callbacks.onSessionStart(this, session);
  }

  // Cette methode ferme la session visee. Un `stream_stop` qui vise une autre session est refuse,
  // sinon un message en retard couperait le direct qui vient de commencer.
  private handleStreamStop(message: Record<string, unknown>): void {
    let sessionId: number;

    try {
      sessionId = readStreamStop(message);
    } catch (error) {
      this.refuse(errorCode(error));
      return;
    }

    if (this.session === null || this.session.sessionId !== sessionId) {
      this.sendLimitedError("unknown_session");
      return;
    }

    this.session = null;
    this.callbacks.onSessionStop(this, "user_stop");
  }

  // Cette methode valide un paquet audio avant de le confier au serveur. Un paquet invalide est
  // compte et signale, mais il ne ferme pas la connexion : un octet abime ne doit pas couper le
  // direct. Une frame recue sans droit ferme la connexion, parce que c'est une faute de protocole.
  private handleAudio(packet: Buffer): void {
    if (!this.authenticated) {
      this.refuse("not_authenticated");
      return;
    }

    const session = this.session;

    if (session === null) {
      this.rejectPacket("no_active_session");
      return;
    }

    const refus = checkAudioPacket(packet, session.sessionId);

    if (refus !== null) {
      this.rejectPacket(refus);
      return;
    }

    this.callbacks.onAudio(this, packet);
  }

  // Cette methode compte un paquet refuse et le signale sans inonder le publisher de messages.
  // Le serveur est prevenu a chaque refus, pas seulement a la fermeture : la route de sante doit
  // montrer le probleme pendant qu'il se produit, c'est le moment ou quelqu'un la consulte.
  private rejectPacket(reason: string): void {
    this.packetsRefused += 1;
    this.callbacks.onPacketRefused(this, reason);
    this.sendLimitedError(reason);
  }

  // Cette methode ferme la connexion apres une faute de protocole, en donnant la raison.
  // Elle envoie `server_error` et non `auth_error` : le publisher traite un token refuse comme une
  // panne definitive qui demande une action de Vassi, alors qu'une faute de protocole ou une
  // authentification trop lente doit rester une coupure ordinaire, suivie d'une reconnexion.
  private refuse(reason: string): void {
    this.callbacks.onEvent("publisher_refuse", { reason });
    this.send(buildServerError(reason));
    this.close(this.authenticated ? CLOSE_PROTOCOL_ERROR : CLOSE_POLICY_VIOLATION, reason);
  }

  // Cette methode envoie au plus un message d'erreur par seconde.
  private sendLimitedError(reason: string): void {
    const now = this.now();

    if (now - this.lastErrorAt < ERROR_INTERVAL_MS) {
      return;
    }

    this.lastErrorAt = now;
    this.callbacks.onEvent("publisher_paquet_refuse", { reason, refused: this.packetsRefused });
    this.send(buildServerError(reason));
  }

  // Cette methode remet a zero le compte de pings sans reponse.
  private markAlive(): void {
    this.missedPongs = 0;
  }

  // Cette methode previent le serveur que la connexion a disparu.
  private handleClose(): void {
    this.clearAuthTimer();
    this.callbacks.onClosed(this);
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  // Cette methode envoie sans jamais laisser une erreur de socket arreter le relais.
  private send(data: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.socket.send(data, () => {});
    } catch {
      this.terminate();
    }
  }
}
