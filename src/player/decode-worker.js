import { OpusDecoder } from "opus-decoder";

import { inspectAudioPacket, DISCONTINUITY_FLAG } from "../protocol/audio-packet.ts";
import { PcmRing } from "./pcm-worklet.js";

// Ce fichier decode les paquets Opus hors du thread principal.
//
// La classe `FrameDecoder` contient tout le travail et ne connait rien du worker : elle recoit des
// octets et rend des echantillons. Le branchement sur `self` est place a la fin, derriere une
// garde, pour que les tests puissent utiliser la classe directement sous Node.

// Le numero de sequence est un entier non signe de 32 bits, comme le fixe le protocole v1.
const SEQUENCE_MODULO = 4294967296;

// Ce type de message decrit ce que le decodeur rend a son appelant.
// - `discontinuity` : le son a saute, le thread principal doit rebufferiser ;
// - `refused` : un paquet n'a pas pu etre utilise, avec sa raison.

// Cette classe valide, decode et depose les echantillons dans la file PCM.
export class FrameDecoder {
  // `sink` recoit les blocs decodes. Il ecrit dans la file partagee ou envoie par un port, selon le
  // mode ; le decodeur ne fait pas la difference.
  constructor(sink, notify) {
    this.sink = sink;
    this.notify = notify;
    this.decoder = null;
    this.sessionId = 0;
    this.lastSequence = null;
    this.accepting = false;
    // Les paquets sont traites l'un apres l'autre : la remise a zero du decodeur est asynchrone, et
    // deux frames ne doivent jamais entrer dans le decodeur en meme temps.
    this.chain = Promise.resolve();
    // Ce numero distingue les paquets d'avant un vidage de ceux d'apres.
    //
    // Le worker appelle `flush`, `setSession` et `setAccepting` des la reception du message, donc en
    // dehors de la chaine. Une frame arretee sur le `await` de la remise a zero du decodeur reprend
    // ensuite son cours et ecrit dans une file que le vidage venait de nettoyer. C'est etroit — la
    // seule fenetre est celle d'une discontinuite — mais le son ecrit est alors du son que le moteur
    // avait justement decide de jeter. Chaque paquet retient le numero qui avait cours quand il est
    // entre dans la chaine ; il est abandonne si ce numero a change depuis.
    this.epoch = 0;
    // Ces compteurs ne servent qu'au diagnostic. Ils repondent a la seule question que le thread
    // principal ne peut pas trancher seul : les paquets qui arrivent produisent-ils du son ?
    this.accepted = 0;
    this.decoded = 0;
    this.refused = 0;
    this.discontinuities = 0;
    this.lastRefusal = null;
  }

  // Cette methode rend les compteurs du decodeur.
  stats() {
    return {
      accepted: this.accepted,
      decoded: this.decoded,
      refused: this.refused,
      discontinuities: this.discontinuities,
      lastRefusal: this.lastRefusal,
    };
  }

  // Cette methode jette le son en attente sans changer de session ni de decodeur.
  //
  // Elle sert quand le thread audio a pris du retard : le son garde en file est trop vieux pour un
  // direct. Le numero de sequence est oublie, sinon la frame suivante passerait pour un trou et
  // ferait rebufferiser une deuxieme fois.
  flush() {
    this.sink.clear();
    this.lastSequence = null;
    this.epoch += 1;
  }

  // Cette methode cree le decodeur Opus. Elle decrit un flux stereo couple, le seul que la v1
  // produit : un flux, deux canaux lies l'un a l'autre.
  async start() {
    this.decoder = new OpusDecoder({ channels: 2, streamCount: 1, coupledStreamCount: 1 });
    await this.decoder.ready;
  }

  // Cette methode libere la memoire du decodeur.
  stop() {
    if (this.decoder !== null) {
      this.decoder.free();
      this.decoder = null;
    }
  }

  // Cette methode ouvre une session. Tout ce qui restait de la precedente est jete : file PCM videe,
  // decodeur remis a son etat initial, numero de sequence oublie.
  setSession(sessionId) {
    this.sessionId = sessionId;
    this.lastSequence = null;
    this.sink.clear();
    this.epoch += 1;

    if (sessionId !== 0) {
      this.chain = this.chain.then(() => this.resetDecoder());
    }
  }

  // Cette methode dit si les echantillons decodes doivent entrer dans la file. Pendant une pause,
  // les paquets sont jetes au lieu d'etre empiles : reprendre doit repartir du direct, pas d'un
  // retard egal a la duree de la pause.
  setAccepting(accepting) {
    if (this.accepting === accepting) {
      return;
    }

    this.accepting = accepting;

    if (!accepting) {
      this.lastSequence = null;
      this.sink.clear();
      this.epoch += 1;
    }
  }

  // Cette methode prend un paquet du relais et fait avancer la file de traitement.
  push(bytes) {
    const epoch = this.epoch;

    this.chain = this.chain.then(() => this.handle(bytes, epoch)).catch(() => {});
    return this.chain;
  }

  // Cette methode traite un paquet complet : validation, detection de trou, decodage, ecriture.
  //
  // `epoch` est le numero qui avait cours quand ce paquet est entre dans la chaine. Un paquet plus
  // vieux qu'un vidage est abandonne sans etre compte : il n'est ni accepte ni refuse, exactement
  // comme un paquet recu pendant une pause. Le compteur de paquets refuses garde ainsi son sens —
  // il ne compte que ce que le decodeur n'a pas su lire.
  async handle(bytes, epoch) {
    if (epoch !== this.epoch) {
      return;
    }

    let header;

    try {
      header = inspectAudioPacket(bytes);
    } catch (error) {
      this.refuse(error instanceof Error ? error.message : "invalid_packet");
      return;
    }

    // Un paquet d'une autre session appartient a un direct precedent : il ne doit pas entrer dans
    // le son du direct courant.
    if (header.sessionId !== this.sessionId) {
      this.refuse("session_mismatch");
      return;
    }

    if (!this.accepting) {
      return;
    }

    this.accepted += 1;

    // Deux evenements produisent une discontinuite. Le device pose le bit apres une perte locale.
    // Le relais, lui, ne modifie jamais un paquet : quand il abandonne les paquets d'un auditeur en
    // retard, il ne laisse qu'un trou dans les numeros de sequence, que le player doit reconnaitre.
    const expected = this.lastSequence === null ? header.sequenceNumber : (this.lastSequence + 1) % SEQUENCE_MODULO;
    const marked = (header.flags & DISCONTINUITY_FLAG) !== 0;
    const gap = header.sequenceNumber !== expected;
    this.lastSequence = header.sequenceNumber;

    if (marked || gap) {
      // L'ordre compte : vider le PCM en attente, remettre le decodeur a zero, puis seulement
      // decoder la frame marquee. Rien ne remplace la duree abandonnee.
      this.sink.clear();
      await this.resetDecoder();
      this.discontinuities += 1;
      this.notify({ type: "discontinuity", reason: marked ? "flag" : "sequence_gap" });
    }

    // La remise a zero du decodeur est asynchrone : une nouvelle session, une pause ou un vidage a
    // pu arriver pendant ce temps. Cette frame appartient alors au direct precedent, et l'ecrire
    // deposerait vingt millisecondes de son perime en tete d'une file qu'on vient de vider.
    if (header.sessionId !== this.sessionId || !this.accepting || epoch !== this.epoch) {
      return;
    }

    this.decode(bytes.subarray(bytes.byteLength - header.payloadSize));
  }

  // Cette methode compte un paquet inutilisable et le signale une fois.
  refuse(reason) {
    this.refused += 1;
    this.lastRefusal = reason;
    this.notify({ type: "refused", reason });
  }

  // Cette methode decode une frame Opus et depose les deux canaux dans la file.
  decode(payload) {
    if (this.decoder === null) {
      return;
    }

    const result = this.decoder.decodeFrame(payload);

    if (result.samplesDecoded <= 0) {
      this.refuse("opus_decode_failed");
      return;
    }

    const left = result.channelData[0];
    const right = result.channelData[1] ?? left;
    this.decoded += 1;
    this.sink.write(left, right, result.samplesDecoded);
  }

  // Cette methode applique `OPUS_RESET_STATE` : le decodeur retrouve l'etat d'un decodeur neuf.
  async resetDecoder() {
    if (this.decoder !== null) {
      await this.decoder.reset();
    }
  }
}

// Cette fonction cree le depot d'echantillons qui ecrit directement dans la memoire partagee avec
// le processeur audio. C'est le chemin utilise quand la page est isolee.
export function createSharedSink(buffer, capacityFrames) {
  const ring = new PcmRing(buffer, capacityFrames);

  return {
    clear: () => ring.clear(),
    write: (left, right, count) => ring.write(left.subarray(0, count), right.subarray(0, count)),
  };
}

// Cette fonction cree le depot qui transfere chaque bloc au processeur audio par un port. C'est le
// chemin utilise quand `SharedArrayBuffer` n'est pas disponible.
//
// Le decodeur reutilise ses propres tableaux d'une frame a l'autre : les echantillons sont donc
// copies une fois, puis le tampon de cette copie est transfere. Le transfert evite la copie que la
// remise du message ferait autrement, ce qui ramene le mode messages a une seule copie par frame.
export function createPortSink(port) {
  return {
    clear: () => port.postMessage({ type: "clear" }),
    write: (left, right, count) => {
      const leftCopy = left.slice(0, count);
      const rightCopy = right.slice(0, count);

      port.postMessage({ type: "pcm", left: leftCopy, right: rightCopy }, [leftCopy.buffer, rightCopy.buffer]);
    },
  };
}

// Le branchement sur le worker n'a lieu que dans un worker. Sous Node et dans une page ordinaire,
// ce fichier ne fournit que la classe et les deux depots ci-dessus.
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  let decoder = null;
  let workletPort = null;
  // Les compteurs partent une fois par seconde, pas a chaque paquet : ils servent a un affichage
  // humain, et cinquante messages par seconde sur le thread principal ne diraient rien de plus.
  let sinceStats = 0;

  self.onmessage = async (event) => {
    const message = event.data;

    if (message.type === "configure") {
      workletPort = message.port ?? null;
      const sink = workletPort === null
        ? createSharedSink(message.buffer, message.capacityFrames)
        : createPortSink(workletPort);

      decoder = new FrameDecoder(sink, (note) => self.postMessage(note));

      try {
        await decoder.start();
        self.postMessage({ type: "ready" });
      } catch (error) {
        self.postMessage({ type: "error", reason: error instanceof Error ? error.message : "opus_start_failed" });
      }

      return;
    }

    if (decoder === null) {
      return;
    }

    if (message.type === "session") {
      decoder.setSession(message.sessionId);
      return;
    }

    if (message.type === "accepting") {
      decoder.setAccepting(message.accepting);
      return;
    }

    if (message.type === "flush") {
      decoder.flush();
      return;
    }

    if (message.type === "packet") {
      decoder.push(new Uint8Array(message.packet));
      sinceStats += 1;

      if (sinceStats >= 50) {
        sinceStats = 0;
        self.postMessage({ type: "stats", ...decoder.stats() });
      }

      return;
    }

    if (message.type === "stop") {
      decoder.stop();
      decoder = null;
    }
  };
}
