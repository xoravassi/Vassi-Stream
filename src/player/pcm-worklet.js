// Ce fichier contient la file PCM et le processeur audio qui la lit.
//
// Il ne contient aucun `import` : un module charge par `audioWorklet.addModule()` ne peut pas en
// utiliser sous Safari, et le professeur est sur macOS. Le worker de decodage et les tests
// importent ce meme fichier, donc la file n'existe qu'en un seul exemplaire dans tout le projet.
//
// L'appel a `registerProcessor` est place derriere une garde : importer ce fichier depuis un worker
// ou depuis Node ne declenche rien.

// Le nom sous lequel la page cree son noeud audio.
export const PCM_PROCESSOR_NAME = "vassi-pcm";

// La v1 est stereo. Les echantillons sont entrelaces : L, R, L, R.
export const PCM_CHANNELS = 2;

// La sortie audio du protocole est a 48 kHz.
export const PCM_SAMPLE_RATE = 48000;

// La file contient trois secondes d'audio, soit plus du triple du plus grand buffer cible.
// Une capacite fixe, choisie une fois, evite toute allocation pendant le direct.
export const PCM_CAPACITY_FRAMES = PCM_SAMPLE_RATE * 3;

// Ces cases du tableau de controle sont lues et ecrites avec `Atomics`.
export const CONTROL_WRITE_INDEX = 0;
export const CONTROL_READ_INDEX = 1;
export const CONTROL_UNDERRUNS = 2;
export const CONTROL_OVERFLOWS = 3;

// Le tableau de controle occupe huit cases de quatre octets. Les quatre cases libres laissent la
// place a un compteur supplementaire sans changer la disposition memoire.
const CONTROL_SLOTS = 8;
const CONTROL_BYTES = CONTROL_SLOTS * 4;

// Cette fonction cree la memoire d'une file PCM. Elle utilise un `SharedArrayBuffer` quand la page
// est isolee, ce qui permet au worker et au processeur audio de lire la meme memoire. Sinon elle
// utilise un tampon ordinaire : la file fonctionne pareil, mais elle appartient a un seul thread.
export function createPcmBuffer(shared, capacityFrames = PCM_CAPACITY_FRAMES) {
  const bytes = CONTROL_BYTES + capacityFrames * PCM_CHANNELS * 4;

  if (shared) {
    return new SharedArrayBuffer(bytes);
  }

  return new ArrayBuffer(bytes);
}

// Cette classe est une file circulaire d'echantillons stereo, de taille fixe.
//
// Un seul producteur ecrit, un seul consommateur lit : le worker de decodage d'un cote, le
// processeur audio de l'autre. Dans ce cas precis, les deux threads se passent les donnees sans
// verrou, avec deux index lus et ecrits par `Atomics`.
//
// Une case reste toujours libre. C'est elle qui distingue une file pleine d'une file vide sans
// ajouter de troisieme compteur : ecrire est possible tant que la case suivant l'ecriture n'est pas
// celle de la lecture.
export class PcmRing {
  constructor(buffer, capacityFrames = PCM_CAPACITY_FRAMES) {
    this.capacity = capacityFrames;
    this.control = new Int32Array(buffer, 0, CONTROL_SLOTS);
    this.samples = new Float32Array(buffer, CONTROL_BYTES, capacityFrames * PCM_CHANNELS);
  }

  // Cette methode donne le nombre d'echantillons par canal disponibles a la lecture.
  get available() {
    const write = Atomics.load(this.control, CONTROL_WRITE_INDEX);
    const read = Atomics.load(this.control, CONTROL_READ_INDEX);

    return write >= read ? write - read : write + this.capacity - read;
  }

  // Cette methode donne la duree d'audio en attente, en millisecondes.
  get availableMs() {
    return (this.available * 1000) / PCM_SAMPLE_RATE;
  }

  // Cette methode donne le nombre de fois ou la lecture a manque de donnees.
  get underruns() {
    return Atomics.load(this.control, CONTROL_UNDERRUNS);
  }

  // Cette methode donne le nombre de blocs abandonnes faute de place.
  get overflows() {
    return Atomics.load(this.control, CONTROL_OVERFLOWS);
  }

  // Cette methode abandonne tout l'audio en attente : nouvelle session, discontinuite, ou reprise
  // apres une pause.
  //
  // Elle ramene l'index d'ecriture sur l'index de lecture, et ne touche pas a ce dernier. C'est la
  // regle de cette file : le producteur n'ecrit que l'index d'ecriture, le consommateur n'ecrit que
  // l'index de lecture. Remettre les deux a zero depuis le producteur ecraserait la position d'un
  // consommateur en train de lire, sur le thread audio, au moment precis d'une discontinuite.
  clear() {
    Atomics.store(this.control, CONTROL_WRITE_INDEX, Atomics.load(this.control, CONTROL_READ_INDEX));
  }

  // Cette methode ecrit un bloc stereo. Elle renvoie `false` et compte un abandon quand la place
  // manque : la file ne grandit jamais, parce que de l'audio ancien n'a pas d'interet dans un
  // direct. Le bloc est ecrit entierement ou pas du tout.
  write(left, right) {
    const count = Math.min(left.length, right.length);
    const write = Atomics.load(this.control, CONTROL_WRITE_INDEX);
    const read = Atomics.load(this.control, CONTROL_READ_INDEX);
    const used = write >= read ? write - read : write + this.capacity - read;

    if (count > this.capacity - 1 - used) {
      Atomics.add(this.control, CONTROL_OVERFLOWS, 1);
      return false;
    }

    let position = write;

    for (let index = 0; index < count; index += 1) {
      const slot = position * PCM_CHANNELS;
      this.samples[slot] = left[index];
      this.samples[slot + 1] = right[index];
      position = position + 1 === this.capacity ? 0 : position + 1;
    }

    // L'index d'ecriture est publie apres les echantillons : le consommateur ne peut donc jamais
    // lire une case que le producteur n'a pas fini d'ecrire.
    Atomics.store(this.control, CONTROL_WRITE_INDEX, position);
    return true;
  }

  // Cette methode remplit deux sorties avec les echantillons disponibles et complete par du silence
  // quand la file se vide. Elle renvoie le nombre d'echantillons reellement lus.
  //
  // Le silence est prefere a une repetition du dernier bloc : une repetition s'entend beaucoup plus
  // qu'un court silence.
  read(left, right) {
    const wanted = Math.min(left.length, right.length);
    const write = Atomics.load(this.control, CONTROL_WRITE_INDEX);
    const read = Atomics.load(this.control, CONTROL_READ_INDEX);
    const used = write >= read ? write - read : write + this.capacity - read;
    const count = Math.min(wanted, used);

    let position = read;

    for (let index = 0; index < count; index += 1) {
      const slot = position * PCM_CHANNELS;
      left[index] = this.samples[slot];
      right[index] = this.samples[slot + 1];
      position = position + 1 === this.capacity ? 0 : position + 1;
    }

    for (let index = count; index < wanted; index += 1) {
      left[index] = 0;
      right[index] = 0;
    }

    Atomics.store(this.control, CONTROL_READ_INDEX, position);

    if (count < wanted) {
      Atomics.add(this.control, CONTROL_UNDERRUNS, 1);
    }

    return count;
  }
}

// Le processeur audio n'est enregistre que dans un AudioWorklet. Ailleurs, ce fichier ne sert qu'a
// fournir la file ci-dessus.
if (typeof AudioWorkletProcessor !== "undefined" && typeof registerProcessor === "function") {
  // Ce processeur lit la file a chaque bloc demande par la carte son. Il n'alloue rien, ne prend
  // aucun verrou et ne fait aucun appel couteux : c'est la seule facon de tenir le temps reel.
  class VassiPcmProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();

      const settings = options.processorOptions;

      this.ring = new PcmRing(settings.buffer, settings.capacityFrames);
      this.running = true;
      // Tant que ce drapeau est faux, le processeur sort du silence sans vider la file. C'est ce
      // qui permet a la bufferisation de remplir la file : un processeur qui lirait pendant ce
      // temps la reviderait aussitot et le seuil ne serait jamais atteint.
      this.playing = false;
      this.blocksSinceReport = 0;

      // Le thread principal pilote la lecture et l'arret par ce port.
      this.port.onmessage = (event) => {
        const message = event.data;

        // En mode messages, le thread principal transfere ici le port qui relie le worker au
        // processeur. Ce port ne peut pas voyager dans les options de construction : celles-ci sont
        // copiees, et un port se transfere, il ne se copie pas.
        if (message.type === "port") {
          this.listenTo(message.port);
          return;
        }

        if (message.type === "play") {
          this.playing = true;
          return;
        }

        if (message.type === "pause") {
          this.playing = false;
          return;
        }

        if (message.type === "stop") {
          this.running = false;
        }
      };
    }

    // Cette methode branche le port du worker. Les blocs decodes arrivent dessus et entrent dans la
    // file, exactement comme le worker les y ecrirait lui-meme en memoire partagee.
    listenTo(port) {
      port.onmessage = (event) => {
        const message = event.data;

        if (message.type === "pcm") {
          this.ring.write(message.left, message.right);
          return;
        }

        if (message.type === "clear") {
          this.ring.clear();
        }
      };
    }

    process(_inputs, outputs) {
      const output = outputs[0];

      if (!output || output.length < PCM_CHANNELS) {
        return this.running;
      }

      const left = output[0];
      const right = output[1];

      if (this.playing) {
        this.ring.read(left, right);
      } else {
        left.fill(0);
        right.fill(0);
      }

      this.report();
      return this.running;
    }

    // Cette methode annonce au thread principal le niveau de la file. Elle le fait une fois sur
    // seize blocs, soit environ toutes les quarante millisecondes : assez souvent pour decider de
    // jouer ou de rebufferiser, assez rarement pour ne pas charger le thread audio.
    report() {
      this.blocksSinceReport += 1;

      if (this.blocksSinceReport < 16) {
        return;
      }

      this.blocksSinceReport = 0;
      this.port.postMessage({
        type: "level",
        availableMs: this.ring.availableMs,
        underruns: this.ring.underruns,
      });
    }
  }

  registerProcessor(PCM_PROCESSOR_NAME, VassiPcmProcessor);
}
