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

// Duree d'une frame du protocole v1, en microsecondes.
const FRAME_MICROS = 40000n;

// Au-dela de ce trou, combler la duree manquante n'a plus de sens : le silence s'entendrait plus
// longtemps que la rebufferisation qu'il evite, et le son garde en file serait de toute facon
// separe du direct par plus que le seuil du profil le plus court. En dessous, combler est toujours
// le bon choix, et c'est le cas de tous les trous ordinaires d'un lien qui hoquette.
export const MAX_CONCEAL_MICROS = 500000n;

// Ce bloc de silence sert a combler un trou. Il est cree une fois : combler alloue alors zero octet,
// ce qui compte parce qu'un lien degrade produit des trous en rafale. Sa taille vaut une trame du
// protocole, mais rien n'en depend : `fillGap` le repete autant de fois qu'il faut.
const SILENCE = new Float32Array(1920);

// Duree du fondu applique de part et d'autre d'un trou, en millisecondes.
//
// Un trou comble par du silence ne commence pas en silence : il commence par une **marche**. Le
// signal passe de sa valeur courante a zero en un echantillon, puis de zero a la valeur suivante en
// sortant. Une marche a un spectre plat, donc elle s'entend — c'est la definition d'un clic.
//
// La mesure est dans `scripts/bench-continuite.mjs`, section `clic` : sur un signal qui n'a rien
// au-dessus de 880 Hz, l'energie fabriquee au-dessus de 2 kHz par un trou de 40 ms vaut -27,7 dB au
// bord d'entree et -17,1 dB au bord de sortie, contre -64,3 dB pour le meme signal sans trou. Le
// bord de sortie est le plus bruyant des deux, de dix decibels.
//
// Trois millisecondes ramenent ces deux bords a -57,1 et -63,7 dB, soit un bord de sortie
// indistinguable du signal intact. Cette valeur n'est pas un compromis prudent, c'est un optimum
// mesure : en dessous d'une milliseconde le fondu ne sert a rien, au-dela de trois il retire du
// signal utile et le chiffre se degrade a nouveau.
const FADE_MS = 3;
const FADE_SAMPLES = Math.round((FADE_MS * 48000) / 1000);

// Cette table tient le gain du fondu, calcule une fois.
//
// La forme est une cosinus surelevee et non une rampe droite : une rampe droite laisse une
// discontinuite de *pente* a chacune de ses extremites, et une discontinuite de pente s'entend
// encore, plus faiblement. La cosinus surelevee arrive a plat aux deux bouts.
const FADE_GAIN = new Float32Array(FADE_SAMPLES);

for (let i = 0; i < FADE_SAMPLES; i += 1) {
  // De 1 vers 0. Le fondu d'entree lit cette table a l'envers.
  FADE_GAIN[i] = 0.5 + 0.5 * Math.cos((Math.PI * i) / FADE_SAMPLES);
}

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
    // Ce timestamp est la position du dernier paquet sur la chronologie audio de la session. C'est
    // lui, et non le numero de sequence, qui mesure une duree manquante : une perte survenue sur le
    // poste Ableton avant l'envoi ne saute aucun numero — l'encodeur ne construit pas les paquets
    // perdus — mais elle avance le timestamp de la duree perdue (`audio_encoder.cpp`,
    // `audio_encoder_reset_after_loss`). Le numero de sequence, lui, ne voit que ce que le reseau a
    // perdu apres l'envoi. Les deux ensemble disent donc *ou* le son a disparu.
    this.lastTimestamp = null;
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
    // Ce compteur separe les trous que le player encaisse de ceux qui le coupent, et cette
    // distinction est desormais la premiere a lire. `discontinuities` les comptait ensemble : un
    // compteur qui melange un trou comble — la lecture continue, personne n'entend de blanc — et un
    // vidage de file — rebufferisation, silence, reprise — ne peut pas dire si le direct va bien.
    // C'est exactement la forme d'aveuglement qui a produit l'erreur d'analyse du 11 aout 2026.
    this.flushes = 0;
    // Duree totale comblee par du silence depuis le debut, en millisecondes. C'est la mesure directe
    // de ce que le lien a perdu : elle ne depend d'aucun seuil et ne se remet pas a zero.
    this.concealedMs = 0;
    this.lastRefusal = null;
    // Ces trois champs portent le fondu aux bords des trous. Voir `FADE_MS`.
    //
    // La fin de chaque bloc decode est **retenue** au lieu d'etre ecrite tout de suite : c'est la
    // seule facon de pouvoir encore la mettre en fondu si un trou survient juste apres. Une fois
    // ecrite dans la file partagee, elle est hors de portee — le processeur audio peut la lire a tout
    // instant, et la reprendre serait une course.
    //
    // Le prix est de trois millisecondes de latence constante, sur un seuil qui vaut entre 200 et
    // 2000 ms. La chronologie, elle, ne bouge pas : les memes echantillons sortent dans le meme
    // ordre, simplement decales d'un bloc de fondu.
    this.tailLeft = new Float32Array(FADE_SAMPLES);
    this.tailRight = new Float32Array(FADE_SAMPLES);
    this.tailCount = 0;
    // Ce drapeau dit que le prochain bloc decode sort d'un trou, et doit donc entrer en fondu.
    this.fadeInPending = false;
  }

  // Cette methode rend les compteurs du decodeur.
  stats() {
    return {
      accepted: this.accepted,
      decoded: this.decoded,
      refused: this.refused,
      discontinuities: this.discontinuities,
      flushes: this.flushes,
      concealedMs: this.concealedMs,
      lastRefusal: this.lastRefusal,
    };
  }

  // Cette methode vide la file et abandonne ce que le fondu retenait.
  //
  // Elle remplace tout appel direct a `sink.clear()`. La queue en attente appartient au son qu'on
  // vient de jeter : l'ecrire apres coup deposerait trois millisecondes de son perime en tete d'une
  // file qu'on vient de vider, et le fondu d'entree s'appliquerait a un bloc qui ne suit plus rien.
  clearSink() {
    this.sink.clear();
    this.tailCount = 0;
    this.fadeInPending = false;
  }

  // Cette methode jette le son en attente sans changer de session ni de decodeur.
  //
  // Elle sert quand le thread audio a pris du retard : le son garde en file est trop vieux pour un
  // direct. Le numero de sequence est oublie, sinon la frame suivante passerait pour un trou et
  // ferait rebufferiser une deuxieme fois.
  flush() {
    this.clearSink();
    this.forgetPosition();
    this.epoch += 1;
  }

  // Cette methode oublie la position du flux sur la chronologie de la session.
  //
  // Elle est appelee partout ou la file est videe. Sans elle, le paquet suivant paraitrait separe du
  // dernier par toute la duree ecoulee, et le decodeur comblerait un trou qui n'existe pas.
  forgetPosition() {
    this.lastSequence = null;
    this.lastTimestamp = null;
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
    this.forgetPosition();
    this.clearSink();
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
      this.forgetPosition();
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

    // Deux mesures independantes disent ce qui manque, et leur combinaison dit *ou* le son a disparu.
    //
    // Le bit de discontinuite est pose par le device quand il a perdu de l'audio chez lui : file de
    // l'external pleine parce que le processeur sature, pont loopback coupe, ou sortie reseau en
    // retard. Le trou dans les numeros de sequence, lui, ne peut venir que d'apres l'envoi : le
    // relais abandonne les paquets d'un auditeur en retard, sans jamais modifier un octet.
    //
    //   bit + trou   le publisher a jete faute de lien montant : il consomme un numero et n'envoie pas
    //   bit seul     l'encodeur a perdu avant de construire le paquet : aucun numero n'est saute
    //   trou seul    le relais a jete pour cet auditeur
    //
    // La duree manquante, elle, vient toujours du timestamp : c'est le seul champ qui compte le temps
    // audio et non les paquets, donc le seul juste dans les trois cas.
    const expected = this.lastSequence === null ? header.sequenceNumber : (this.lastSequence + 1) % SEQUENCE_MODULO;
    const marked = (header.flags & DISCONTINUITY_FLAG) !== 0;
    const gap = header.sequenceNumber !== expected;
    const missingMicros = this.missingMicros(header.timestampMicros);
    this.lastSequence = header.sequenceNumber;
    this.lastTimestamp = header.timestampMicros;

    if (marked || gap || missingMicros > 0n) {
      const reason = gap ? (marked ? "publisher_drop" : "relay_drop") : "encoder_loss";
      const long = missingMicros > MAX_CONCEAL_MICROS;

      if (long) {
        // Un trou de cette taille depasse le seuil de tous les profils : le combler ferait entendre
        // plus de silence que la rebufferisation qu'il evite. La file part, et la lecture reprend au
        // direct. C'est le seul cas ou vider gagne quelque chose.
        this.clearSink();
        this.flushes += 1;
        await this.resetDecoder();
      } else {
        // La duree manquante entre dans la file, et c'est ce qui garde la chronologie juste. Sans
        // elle le trou disparaitrait de la timeline et le niveau de la file baisserait
        // definitivement d'autant : production et consommation tournant toutes deux a 48 kHz, rien
        // ne le ferait remonter, et la marge anti-gigue s'userait trou apres trou.
        //
        // Le son deja decode reste en place. Le jeter ne rapprocherait pas du direct — le
        // consommateur trouverait la file vide et ecrirait du silence jusqu'a la fin de la
        // rebufferisation, pour retrouver le meme retard qu'avant — donc cela ne couterait que du
        // son, et sur un lien qui perd souvent cela viderait la file plus vite qu'elle se remplit.
        this.fillGap(missingMicros);

        // Le decodeur suit l'encodeur : il se remet a zero quand le bit dit que l'encodeur l'a fait
        // (`audio_encoder_reset_after_loss`), et seulement alors. Apres un simple trou de sequence
        // l'encodeur, lui, n'a rien remis a zero — il ignore que le relais a jete ces paquets — et
        // effacer un etat encore aligne sur le sien allongerait l'artefact au lieu de l'ecourter.
        if (marked) {
          await this.resetDecoder();
        }
      }

      this.discontinuities += 1;
      this.notify({
        type: "discontinuity",
        reason,
        missingMs: Number(missingMicros / 1000n),
        // Ce drapeau dit a la machine d'etats si elle doit rebufferiser. Un trou comble ne
        // l'interesse pas : la lecture continue, et l'interrompre produirait exactement le
        // rattrapage brutal que la file cherche a eviter.
        recovered: !long,
      });
    }

    // La remise a zero du decodeur est asynchrone : une nouvelle session, une pause ou un vidage a
    // pu arriver pendant ce temps. Cette frame appartient alors au direct precedent, et l'ecrire
    // deposerait vingt millisecondes de son perime en tete d'une file qu'on vient de vider.
    if (header.sessionId !== this.sessionId || !this.accepting || epoch !== this.epoch) {
      return;
    }

    this.decode(bytes.subarray(bytes.byteLength - header.payloadSize));
  }

  // Cette methode rend la duree audio absente entre le dernier paquet et celui-ci.
  //
  // Elle vaut zero pour un flux continu, pour le premier paquet d'une session, et pour un paquet en
  // retard ou repete — un timestamp qui n'avance pas de plus d'une frame ne decrit aucun trou.
  missingMicros(timestampMicros) {
    if (this.lastTimestamp === null) {
      return 0n;
    }

    const advance = timestampMicros - this.lastTimestamp;

    return advance > FRAME_MICROS ? advance - FRAME_MICROS : 0n;
  }

  // Cette methode ecrit dans la file la duree exacte du trou, sous forme de silence, entre deux
  // fondus.
  //
  // Le silence tient ce role parce qu'il est le seul remplissage disponible ici : `opus-decoder`
  // n'expose aucun chemin pour un paquet nul, donc la dissimulation integree de libopus — qui
  // prolongerait le son au lieu de le couper — reste hors de portee tant que ce paquet n'est pas
  // remplace. Ce que le silence garantit, une chronologie exacte a l'echantillon pres, ne depend pas
  // de ce choix, et une dissimulation le remplacerait sans rien changer autour.
  //
  // Les fondus, eux, ne dependent d'aucun decodeur. Ils suppriment les deux marches qui bordent le
  // silence, et c'est la moitie audible du probleme : mesure au banc, un trou de 40 ms comble sans
  // fondu fabrique 37 dB de bruit large bande a son bord d'entree et 47 dB a son bord de sortie.
  fillGap(missingMicros) {
    if (missingMicros <= 0n) {
      return;
    }

    // Le son retenu part en fondu : c'est le bord d'entree du trou.
    this.writeTail(true);

    const frames = Number((missingMicros * 48n) / 1000n);
    let written = 0;

    while (written < frames) {
      const count = Math.min(SILENCE.length, frames - written);
      this.sink.write(SILENCE, SILENCE, count);
      written += count;
    }

    this.concealedMs += Number(missingMicros / 1000n);
    // Le bloc suivant sortira du trou : il entrera en fondu.
    this.fadeInPending = true;
  }

  // Cette methode ecrit la fin de bloc retenue, en fondu ou telle quelle.
  //
  // Elle est appelee de deux endroits, et l'ordre est le meme dans les deux : ce qui est retenu
  // precede toujours ce qui vient. `fillGap` l'appelle en fondu parce qu'un trou suit ; `emit`
  // l'appelle sans fondu parce que le bloc suivant est arrive et que le son est continu.
  writeTail(fade) {
    if (this.tailCount === 0) {
      return;
    }

    if (fade) {
      for (let i = 0; i < this.tailCount; i += 1) {
        const gain = FADE_GAIN[i];
        this.tailLeft[i] *= gain;
        this.tailRight[i] *= gain;
      }
    }

    this.sink.write(this.tailLeft, this.tailRight, this.tailCount);
    this.tailCount = 0;
  }

  // Cette methode ecrit un bloc decode en retenant sa fin, et en le faisant entrer en fondu quand il
  // sort d'un trou.
  //
  // Elle est le seul chemin par lequel du son decode entre dans la file. La retenue vaut toujours la
  // meme duree, donc elle ne decale rien : elle ajoute un retard constant de trois millisecondes, une
  // fois, au premier bloc.
  emit(left, right, count) {
    if (this.fadeInPending) {
      this.fadeInPending = false;
      const fade = Math.min(FADE_SAMPLES, count);

      for (let i = 0; i < fade; i += 1) {
        // La table descend de 1 vers 0 : lue a l'envers, elle monte de 0 vers 1.
        const gain = FADE_GAIN[fade - 1 - i];
        left[i] *= gain;
        // Un flux mono force en stereo rend deux fois le meme tableau. Appliquer le gain deux fois
        // l'eleverait au carre, ce qui creuserait le fondu au lieu de le suivre.
        if (right !== left) {
          right[i] *= gain;
        }
      }
    }

    this.writeTail(false);

    // Un bloc plus court que le fondu ne peut rien retenir : il part en entier, et le bloc suivant
    // fournira la fin a mettre en fondu. Aucune frame du protocole v1 n'est dans ce cas — elles
    // valent 40 ms contre 3 — mais rien ici n'a besoin de le supposer.
    if (count <= FADE_SAMPLES) {
      this.sink.write(left, right, count);
      return;
    }

    const body = count - FADE_SAMPLES;
    this.sink.write(left, right, body);
    this.tailLeft.set(left.subarray(body, count));
    this.tailRight.set(right.subarray(body, count));
    this.tailCount = FADE_SAMPLES;
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
    this.emit(left, right, result.samplesDecoded);
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
  // Les compteurs partent sur une minuterie, pas au rythme des paquets recus. La difference compte
  // precisement quand le diagnostic sert : un lien qui ne laisse plus passer qu'un tiers des paquets
  // espacerait d'autant les rapports, et un lien muet n'en enverrait plus aucun. La cadence doit
  // decrire l'incident, pas le subir.
  //
  // Une fois par seconde suffit : ces compteurs alimentent un affichage humain, et le journal de la
  // page les releve quatre fois par seconde.
  const STATS_INTERVAL_MS = 1000;
  let statsTimer = null;

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
        // La minuterie ne part qu'une fois le decodeur pret, et elle lit `decoder` a chaque tour
        // plutot que de le capturer : un worker reconfigure garde ainsi une seule minuterie, et elle
        // decrit toujours le decodeur vivant.
        clearInterval(statsTimer);
        statsTimer = setInterval(() => {
          if (decoder !== null) {
            self.postMessage({ type: "stats", ...decoder.stats() });
          }
        }, STATS_INTERVAL_MS);
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
      return;
    }

    if (message.type === "stop") {
      clearInterval(statsTimer);
      statsTimer = null;
      decoder.stop();
      decoder = null;
    }
  };
}
