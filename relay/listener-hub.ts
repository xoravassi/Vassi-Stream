import { WebSocket } from "ws";

import { buildStreamState, type SessionConfig } from "./protocol.ts";
import type { LogFields } from "./log.ts";

// Ce module tient la liste des auditeurs et leur envoie l'etat puis les paquets audio.
// Il ne lit jamais le contenu des paquets : il rediffuse les memes octets.

// Ces valeurs recopient le mapping de `LATENCY_TARGET_MS` dans `src/player/player-protocol.ts`. Le
// relais ne peut pas l'importer — il ne connait rien du navigateur, et ce module tourne sous Node
// seul — mais un seuil de rejet qui ignore le profil choisi par l'auditeur reproduit exactement le
// defaut mesure le 6 aout 2026 (`docs/validation/incident-meet-2026-08-06.md`, section 4) : le
// relais gardait un backlog plus genereux (1,95 s, `DROP_BYTES` a l'ancienne valeur en octets) que
// ce que l'auditeur tolere lui-meme avant de tout jeter (1,4 s pour Equilibree). Une rafale liberee
// par le relais apres une congestion poussait alors mecaniquement le player au-dessus de son propre
// seuil de vidage : les deux mecanismes travaillaient l'un contre l'autre.
const LATENCY_TARGET_MS: Record<string, number> = { low: 200, balanced: 400, stable: 800 };
// Meme valeur que `LATENCY_TARGET_MS.balanced`, ecrite a part : un acces par cle sur un `Record`
// reste `number | undefined` pour le compilateur, y compris pour une cle connue a l'ecriture.
const DEFAULT_TARGET_MS = 400;

// Cette marge rejoue exactement celle du player (`LATE_MARGIN_MS`, `src/player/player-state.ts`) :
// au-dela, l'auditeur jette lui-meme tout le son en attente et repart du direct. Le relais doit se
// delester avant ce point, pas apres : sinon il continue d'envoyer un backlog que l'auditeur va de
// toute facon jeter des qu'il arrive, ce qui gaspille la bande passante et grossit la rafale de
// rattrapage qui declenche ce vidage cote player.
const RELAY_LATE_MARGIN_MS = 1000;

// Au-dela de cette duree de retard, la connexion est consideree bloquee : elle ne rattrapera pas et
// sa file grandirait sans fin. Une valeur fixe, independante du profil : il ne s'agit plus ici de
// suivre la tolerance de lecture de l'auditeur, mais de detecter un lien qui ne repond plus du tout.
export const CLOSE_MS = 8000;
// Un listener qui ne repond pas a deux pings de suite est considere disparu.
export const MISSED_PONG_LIMIT = 2;

// Cette fonction rend la duree de retard au-dela de laquelle un auditeur de cette session perd des
// paquets plutot que d'en accumuler. C'est un temps, pas un nombre d'octets : le debit reel d'une
// session Opus VBR varie trame a trame (mesure a ~173 kbit/s reels pour un plafond annonce de
// 256 kbit/s dans l'incident du 6 aout), donc convertir un budget de latence en octets via un debit
// nominal ou moyen serait systematiquement faux dans un sens ou dans l'autre. Comparer un temps a un
// temps n'a pas cette approximation.
function dropThresholdMs(session: SessionConfig | null): number {
  const target = session === null ? DEFAULT_TARGET_MS : (LATENCY_TARGET_MS[session.latencyProfile] ?? DEFAULT_TARGET_MS);

  return target + RELAY_LATE_MARGIN_MS;
}

// Ce code de fermeture WebSocket signale que le serveur s'arrete.
const CLOSE_GOING_AWAY = 1001;
// Ce code de fermeture WebSocket signale une donnee que le serveur n'accepte pas.
const CLOSE_UNSUPPORTED_DATA = 1003;
// Ce code de fermeture WebSocket signale un serveur temporairement plein.
const CLOSE_TRY_AGAIN_LATER = 1013;

// Ce type decrit ce que le hub retient pour chaque auditeur connecte.
type Listener = {
  socket: WebSocket;
  missedPongs: number;
  // Horodatages des paquets audio confies a `send()` mais dont le rappel n'est pas encore revenu :
  // c'est le systeme qui n'a pas fini de les ecrire. L'age du plus ancien mesure le retard reel de
  // cet auditeur, exactement comme `pendingSends`/`oldestPendingMs` le font deja cote publisher
  // (`device/node/publisher.js`) pour la meme raison : `bufferedAmount` reste nul tant que le
  // tampon du noyau n'est pas plein, puis saute d'un coup — un signal binaire retarde, pas une
  // duree comparable au budget de latence.
  pendingSends: number[];
};

// Ce type regroupe les compteurs affiches par la route de sante.
export type ListenerStats = {
  accepted: number;
  refused: number;
  closedSlow: number;
  closedSilent: number;
  framesDropped: number;
  framesSent: number;
};

// Cette classe garde les auditeurs, leur envoie l'etat courant et diffuse les paquets audio.
export class ListenerHub {
  readonly stats: ListenerStats = {
    accepted: 0,
    refused: 0,
    closedSlow: 0,
    closedSilent: 0,
    framesDropped: 0,
    framesSent: 0,
  };

  private listeners = new Map<WebSocket, Listener>();
  private stateMessage = buildStreamState(null);
  // Retenue a part du message JSON deja construit : c'est elle qui donne le profil de latence, et
  // donc le seuil de rejet, sans avoir a la relire depuis le texte du message a chaque diffusion.
  private session: SessionConfig | null = null;
  private onEvent: (event: string, fields?: LogFields) => void;
  private maxListeners: number;
  private now: () => number;

  constructor(options: {
    maxListeners: number;
    onEvent?: (event: string, fields?: LogFields) => void;
    // Remplacee par les tests, qui ne peuvent pas attendre des secondes reelles pour simuler un
    // retard d'envoi.
    now?: () => number;
  }) {
    this.maxListeners = options.maxListeners;
    this.onEvent = options.onEvent ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  // Cette methode donne le nombre d'auditeurs connectes.
  get size(): number {
    return this.listeners.size;
  }

  // Cette methode dit si un auditeur de plus peut etre accepte.
  get hasRoom(): boolean {
    return this.listeners.size < this.maxListeners;
  }

  // Cette methode compte un auditeur refuse faute de place. Le refus lui-meme est prononce avant
  // l'ouverture de la connexion WebSocket, par une reponse HTTP du serveur.
  countRefused(): void {
    this.stats.refused += 1;
  }

  // Cette methode accepte un auditeur : elle lui envoie l'etat courant avant de l'inscrire dans la
  // liste de diffusion. Cet ordre garantit qu'aucun paquet audio n'arrive avant son `stream_state`.
  add(socket: WebSocket): void {
    // La place est deja verifiee avant l'ouverture de la connexion, mais la limite est verifiee une
    // seconde fois ici : c'est cette liste qui la porte, donc c'est ici qu'elle doit tenir.
    if (!this.hasRoom) {
      this.stats.refused += 1;
      this.closeListener(socket, CLOSE_TRY_AGAIN_LATER, "too_many_listeners");
      return;
    }

    const listener: Listener = { socket, missedPongs: 0, pendingSends: [] };

    socket.on("close", () => this.remove(socket));
    socket.on("error", () => this.drop(socket));
    // Un signe de vie quelconque prouve que la connexion repond encore.
    socket.on("pong", () => this.markAlive(listener));
    socket.on("ping", () => this.markAlive(listener));
    // La page `/session` n'envoie rien. Une connexion qui parle ne suit pas le protocole.
    socket.on("message", () => {
      this.closeListener(socket, CLOSE_UNSUPPORTED_DATA, "listener_message_refuse");
    });

    this.send(socket, this.stateMessage, false);

    // Une connexion partie pendant cet envoi n'entre pas dans la liste de diffusion : l'inscrire
    // ferait croire a un auditeur de plus jusqu'a l'arrivee de son evenement de fermeture.
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.listeners.set(socket, listener);
    this.stats.accepted += 1;
    this.onEvent("listener_connected", { listeners: this.listeners.size });
  }

  // Cette methode annonce une nouvelle session ou la fin du direct a tous les auditeurs.
  // Elle memorise l'etat : un auditeur qui arrive ensuite recoit exactement le meme message.
  setSession(session: SessionConfig | null): void {
    this.session = session;
    this.stateMessage = buildStreamState(session);

    // La liste est copiee avant l'envoi : une erreur de socket retire son auditeur pendant la
    // boucle, et la boucle ne doit pas dependre de ce que fait la liste sous elle.
    for (const listener of [...this.listeners.values()]) {
      this.send(listener.socket, this.stateMessage, false);
    }
  }

  // Cette methode diffuse un paquet audio deja valide, sans en modifier un seul octet.
  broadcast(packet: Buffer): void {
    const now = this.now();
    const dropMs = dropThresholdMs(this.session);

    for (const listener of [...this.listeners.values()]) {
      const socket = listener.socket;

      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      const oldest = listener.pendingSends[0];
      const oldestPendingMs = oldest === undefined ? 0 : now - oldest;

      // Une file d'envoi bloquee ne se videra plus : la connexion est coupee tout de suite.
      if (oldestPendingMs > CLOSE_MS) {
        this.stats.closedSlow += 1;
        this.onEvent("listener_closed_slow", { oldestPendingMs });
        this.drop(socket);
        continue;
      }

      // Un retard au-dela de ce que cet auditeur tolere lui-meme laisse passer le paquet suivant
      // plutot que d'empiler de l'audio qu'il jettera de toute facon des qu'il arrivera.
      if (oldestPendingMs > dropMs) {
        this.stats.framesDropped += 1;
        continue;
      }

      this.sendTracked(listener, packet);
      this.stats.framesSent += 1;
    }
  }

  // Cette methode envoie un ping a chaque auditeur et coupe ceux qui ne repondent plus.
  // Elle detecte les connexions que le systeme croit encore ouvertes, par exemple apres la
  // disparition brutale d'un reseau mobile.
  pingRound(): void {
    for (const listener of [...this.listeners.values()]) {
      if (listener.missedPongs >= MISSED_PONG_LIMIT) {
        this.stats.closedSilent += 1;
        this.onEvent("listener_closed_silent");
        this.drop(listener.socket);
        continue;
      }

      listener.missedPongs += 1;

      try {
        listener.socket.ping();
      } catch {
        this.drop(listener.socket);
      }
    }
  }

  // Cette methode ferme proprement tous les auditeurs, par exemple a l'arret du relais.
  closeAll(): void {
    for (const listener of [...this.listeners.values()]) {
      this.closeListener(listener.socket, CLOSE_GOING_AWAY, "relais_arrete");
    }

    this.listeners.clear();
  }

  // Cette methode remet a zero le compte de pings sans reponse.
  private markAlive(listener: Listener): void {
    listener.missedPongs = 0;
  }

  // Cette methode retire un auditeur de la liste de diffusion.
  private remove(socket: WebSocket): void {
    if (this.listeners.delete(socket)) {
      this.onEvent("listener_closed", { listeners: this.listeners.size });
    }
  }

  // Cette methode coupe une connexion sans attendre la fin de sa file d'envoi.
  private drop(socket: WebSocket): void {
    this.listeners.delete(socket);

    try {
      socket.terminate();
    } catch {
      // Une connexion deja fermee n'a plus rien a couper.
    }
  }

  // Cette methode ferme une connexion en annoncant la raison, puis la retire de la liste.
  private closeListener(socket: WebSocket, code: number, reason: string): void {
    this.listeners.delete(socket);

    try {
      socket.close(code, reason);
    } catch {
      // Une connexion deja fermee n'a plus rien a annoncer.
    }
  }

  // Cette methode envoie sans jamais laisser une erreur de socket arreter le relais.
  private send(socket: WebSocket, data: string | Buffer, binary: boolean): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(data, { binary }, () => {});
    } catch {
      this.drop(socket);
    }
  }

  // Cette methode envoie un paquet audio en notant combien de temps la socket met a l'accepter.
  //
  // `ws` rend la main a ce rappel quand les octets sont ecrits sur le socket, donc acceptes par le
  // systeme. Tant qu'il ne revient pas, cet auditeur est en retard, et c'est cette duree que
  // `broadcast` lit avant le prochain paquet. Les rappels arrivent dans l'ordre des envois : retirer
  // le plus ancien suffit. Meme principe que `trackedSend` dans `device/node/publisher.js`.
  private sendTracked(listener: Listener, packet: Buffer): void {
    const socket = listener.socket;

    listener.pendingSends.push(this.now());

    try {
      socket.send(packet, { binary: true }, () => {
        listener.pendingSends.shift();
      });
    } catch {
      listener.pendingSends.pop();
      this.drop(socket);
    }
  }
}
