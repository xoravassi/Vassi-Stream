import { WebSocketServer, type WebSocket } from "ws";

// Ce type decrit ce que le faux relais a recu d'un publisher pendant un test.
export type RelayRecord = {
  jsonMessages: Record<string, unknown>[];
  binaryMessages: Buffer[];
};

// Cette classe imite le relais du bloc 7 avec le strict minimum du protocole v1.
// Elle sert seulement a verifier le publisher : elle ne diffuse rien a des listeners.
export class FakeRelay {
  readonly received: RelayRecord = { jsonMessages: [], binaryMessages: [] };
  readonly connections: WebSocket[] = [];

  // Ce comportement imite un relais en panne : il accepte le token puis coupe aussitot.
  cutAfterAuth = false;

  private server: WebSocketServer | null = null;
  private acceptedToken: string;
  private connectionCount = 0;
  private pingCount = 0;

  constructor(acceptedToken: string) {
    this.acceptedToken = acceptedToken;
  }

  // Cette methode ouvre le faux relais sur un port libre et renvoie son adresse.
  async listen(): Promise<string> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server = server;

    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => this.accept(socket));

    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("adresse_du_faux_relais_absente");
    }

    return `ws://127.0.0.1:${address.port}/publisher`;
  }

  // Cette methode applique la seule regle d'authentification utile aux tests.
  private accept(socket: WebSocket): void {
    this.connectionCount += 1;
    this.connections.push(socket);
    socket.on("error", () => {});
    // `ws` repond automatiquement au ping : ce compteur sert seulement a le constater.
    socket.on("ping", () => {
      this.pingCount += 1;
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.received.binaryMessages.push(Buffer.from(data));
        return;
      }

      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      this.received.jsonMessages.push(message);

      if (message.type !== "publisher_auth") {
        return;
      }

      if (message.token === this.acceptedToken) {
        socket.send(JSON.stringify({ type: "auth_ok", protocolVersion: 1 }));
        if (this.cutAfterAuth) {
          socket.terminate();
        }
        return;
      }

      socket.send(JSON.stringify({ type: "auth_error", protocolVersion: 1, reason: "invalid_token" }));
      socket.close(1008);
    });
  }

  // Cette methode donne le nombre de connexions publisher vues depuis le demarrage.
  get connectionsSeen(): number {
    return this.connectionCount;
  }

  // Cette methode donne le nombre de pings recus des publishers depuis le demarrage.
  get pingsSeen(): number {
    return this.pingCount;
  }

  // Cette methode coupe brutalement la connexion courante, comme une perte de reseau.
  cutCurrentConnection(): void {
    const socket = this.connections[this.connections.length - 1];
    if (socket !== undefined) {
      socket.terminate();
    }
  }

  // Cette methode envoie un message JSON quelconque au publisher courant. Elle sert a verifier
  // ce que fait le publisher devant un relais qui ne suit pas l'ordre attendu du protocole.
  sendToCurrentConnection(message: Record<string, unknown>): void {
    const socket = this.connections[this.connections.length - 1];
    if (socket !== undefined) {
      socket.send(JSON.stringify(message));
    }
  }

  // Cette methode rend les messages JSON d'un type donne dans leur ordre d'arrivee.
  messagesOfType(type: string): Record<string, unknown>[] {
    return this.received.jsonMessages.filter((message) => message.type === type);
  }

  // Cette methode ferme le faux relais et toutes ses connexions.
  async close(): Promise<void> {
    for (const socket of this.connections) {
      socket.terminate();
    }

    const server = this.server;
    if (server === null) {
      return;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Cette fonction attend qu'une condition devienne vraie, avec une limite de temps claire.
// Elle evite les attentes fixes, qui rendent les tests lents ou instables selon la machine.
export async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`attente_depassee: ${label}`);
}
