import { WebSocket } from "ws";

import { encodeAudioPacket } from "../src/protocol/audio-packet.ts";
import type { RelayConfig } from "../relay/config.ts";
import type { LogFields } from "../relay/log.ts";
import { RelayServer } from "../relay/server.ts";

// Ce fichier fournit le materiel commun aux tests du relais : un relais sur un port libre et un
// client WebSocket qui garde tout ce qu'il recoit. Aucun test n'ecrit dans la sortie standard.

// Ce token respecte la longueur minimale exigee par la configuration du relais.
export const TEST_TOKEN = "token_de_test_du_relais_vassi_stream_0123456789";

// Ce type decrit un relais demarre pour un test.
export type TestRelay = {
  relay: RelayServer;
  publisherUrl: string;
  listenerUrl: string;
  baseUrl: string;
  events: { event: string; fields: LogFields }[];
  close: () => Promise<void>;
};

// Cette fonction demarre un relais sur un port libre et renvoie ses adresses.
export async function startRelay(overrides: Partial<RelayConfig> = {}): Promise<TestRelay> {
  const events: { event: string; fields: LogFields }[] = [];
  const config: RelayConfig = {
    port: 0,
    publisherToken: TEST_TOKEN,
    maxListeners: 10,
    ...overrides,
  };

  const relay = new RelayServer(config, {
    onEvent: (event, fields = {}) => {
      events.push({ event, fields });
    },
  });

  const port = await relay.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    relay,
    events,
    baseUrl,
    publisherUrl: `ws://127.0.0.1:${port}/publisher`,
    listenerUrl: `ws://127.0.0.1:${port}/listener`,
    close: () => relay.close(),
  };
}

// Cette classe garde tout ce qu'un client recoit, pour que les tests puissent l'attendre.
export class TestClient {
  readonly json: Record<string, unknown>[] = [];
  readonly binary: Buffer[] = [];
  readonly socket: WebSocket;
  closeCode = 0;
  closed = false;
  failed = false;

  constructor(socket: WebSocket) {
    this.socket = socket;

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.binary.push(Buffer.from(data));
        return;
      }

      this.json.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });

    socket.on("error", () => {
      this.failed = true;
    });

    socket.on("close", (code: number) => {
      this.closed = true;
      this.closeCode = code;
    });
  }

  // Cette methode ouvre une connexion et attend son acceptation.
  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const client = new TestClient(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error: Error) => reject(error));
    });

    return client;
  }

  // Cette methode envoie un message JSON du protocole.
  sendJson(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  // Cette methode envoie des octets bruts, comme un paquet audio.
  sendBinary(data: Buffer): void {
    this.socket.send(data, { binary: true });
  }

  // Cette methode rend les messages JSON d'un type donne, dans leur ordre d'arrivee.
  messagesOfType(type: string): Record<string, unknown>[] {
    return this.json.filter((message) => message.type === type);
  }

  // Cette methode ferme la connexion sans attendre.
  stop(): void {
    this.socket.terminate();
  }
}

// Cette classe imite le strict necessaire d'une connexion WebSocket ouverte. Elle sert aux tests
// qui doivent provoquer une situation qu'un vrai socket local ne produit pas : une file d'envoi
// bloquee, une absence de reponse aux pings, ou un message envoye a un instant precis.
export class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  pings = 0;
  terminated = false;
  closedWith: { code: number; reason: string } | null = null;
  readonly texts: string[] = [];
  readonly binaries: Buffer[] = [];
  // Tant que ce drapeau est vrai, `send()` rend la main a son rappel tout de suite, comme un envoi
  // qui part sans attendre. Un test qui simule un lien lent le passe a faux : les rappels
  // s'accumulent alors dans `pendingAcks` au lieu de partir, et `ackOldest` les libere un par un,
  // comme le ferait le systeme quand la socket peut enfin ecrire.
  autoAck = true;
  private pendingAcks: (() => void)[] = [];

  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  send(data: string | Buffer, options?: { binary: boolean } | (() => void), done?: () => void): void {
    if (typeof options === "object" && options.binary) {
      this.binaries.push(data as Buffer);
    } else {
      this.texts.push(String(data));
    }

    const callback = typeof options === "function" ? options : done;

    if (callback === undefined) {
      return;
    }

    if (this.autoAck) {
      callback();
      return;
    }

    this.pendingAcks.push(callback);
  }

  // Cette methode remet la main aux rappels d'envoi les plus anciens encore en attente, jusqu'a
  // `count`. Elle sert aux tests qui simulent un lien lent : ils laissent d'abord `autoAck` a faux,
  // envoient plusieurs paquets, puis liberent les rappels au rythme voulu.
  ackOldest(count = 1): void {
    for (let index = 0; index < count && this.pendingAcks.length > 0; index += 1) {
      this.pendingAcks.shift()!();
    }
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = 2;
  }

  // Cette methode rend les messages JSON deja envoyes sur cette connexion.
  jsonMessages(): Record<string, unknown>[] {
    return this.texts.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

// Cette fonction convertit un faux socket vers le type attendu par le code du relais.
export function asSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

// Cette fonction attend qu'une condition devienne vraie, avec une limite de temps claire.
export async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`attente_depassee: ${label}`);
}

// Cette fonction construit le message d'ouverture de session d'un publisher conforme.
export function streamStartMessage(sessionId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "stream_start",
    protocolVersion: 1,
    sessionId,
    codec: "opus",
    bitrate: 256000,
    sampleRate: 48000,
    channels: 2,
    frameDurationMs: 20,
    latencyProfile: "balanced",
    ...overrides,
  };
}

// Cette fonction construit un paquet audio valide dont le payload est reconnaissable.
export function audioPacket(sessionId: number, sequenceNumber: number, marker: number): Buffer {
  return Buffer.from(
    encodeAudioPacket({
      sessionId,
      sequenceNumber,
      timestampMicros: BigInt(sequenceNumber) * 20000n,
      payload: new Uint8Array([marker, 11, 22, 33, 44]),
    }),
  );
}

// Cette fonction ouvre une connexion publisher deja authentifiee et deja en session.
//
// `overrides` sert aux tests qui ont besoin d'une session autrement configuree, le profil de latence
// en particulier : c'est lui qui fixe le seuil de lecture et les bornes du filet.
export async function startLive(
  relay: TestRelay,
  sessionId: number,
  overrides: Record<string, unknown> = {},
): Promise<TestClient> {
  const publisher = await TestClient.connect(relay.publisherUrl);

  publisher.sendJson({ type: "publisher_auth", protocolVersion: 1, token: TEST_TOKEN });
  await waitFor(() => publisher.messagesOfType("auth_ok").length === 1, "auth_ok");

  publisher.sendJson(streamStartMessage(sessionId, overrides));
  await waitFor(() => relay.relay.health().live, "direct ouvert");

  return publisher;
}

// Cette fonction lit la route de sante du relais.
export async function readHealth(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/health`);

  if (!response.ok) {
    throw new Error(`sante_indisponible: ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}
