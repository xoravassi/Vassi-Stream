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

// La file contient quatre secondes d'audio, soit dix fois le plus petit buffer cible et cinq fois
// le plus grand. Une capacite fixe, choisie une fois, evite toute allocation pendant le direct.
//
// Trois secondes suffisaient aux deux premiers profils, mais laissaient au profil Stable (800 ms,
// vidage a 1800 ms) une marge de 200 ms seulement avant que le filet ci-dessous n'intervienne — vu
// dans le journal du 6 aout 2026, ou une rafale de rattrapage faisait sauter les deux mecanismes
// presque ensemble (`sauts` +2, +3 d'affilee). Une seconde de plus donne 2666 ms de plafond, donc
// 866 ms de marge meme pour Stable : voir le calcul dans `applyCommands` (`audio-player.ts`).
export const PCM_CAPACITY_FRAMES = PCM_SAMPLE_RATE * 4;

// Le filet du processeur audio ne peut jamais etre place plus haut que les deux tiers de la file.
// Le tiers restant absorbe ce qu'une rafale ecrit entre deux blocs : le processeur ne verifie sa
// file qu'une fois toutes les 2,7 ms, et un plafond colle a la capacite la laisserait deborder dans
// cet intervalle — exactement ce que le filet est charge d'empecher.
//
// Quatre secondes de file donnent 2666 ms, et cette borne decide pour les trois profils de latence :
// aucun ne demande un plafond plus bas. Le tableau des valeurs reelles est dans `applyCommands`
// (`audio-player.ts`), qui est l'endroit ou le plafond se calcule.
export const NET_CEILING_MAX_MS = Math.round((PCM_CAPACITY_FRAMES * 2 * 1000) / (3 * PCM_SAMPLE_RATE));

// Ces cases du tableau de controle sont lues et ecrites avec `Atomics`.
export const CONTROL_WRITE_INDEX = 0;
export const CONTROL_READ_INDEX = 1;
export const CONTROL_UNDERRUNS = 2;
export const CONTROL_OVERFLOWS = 3;
export const CONTROL_SKIPS = 4;
// Les ebarbages a la reprise sont comptes a part des sauts du filet, et la distinction n'est pas
// cosmetique : un saut du filet est une anomalie — le vidage a ete distance — alors qu'un ebarbage
// est le fonctionnement normal, silencieux, d'une reprise. Les melanger ferait passer le remede pour
// le symptome dans le journal.
export const CONTROL_TRIMS = 5;

// Ecart relatif au seuil en dessous duquel la vitesse de lecture ne bouge pas.
//
// Le niveau de la file oscille naturellement de quelques dizaines de millisecondes au rythme des
// paquets. Corriger ce bruit ferait travailler le regulateur en permanence sans rien gagner.
export const RATE_DEADBAND = 0.15;

// Ecart relatif, au-dela de la zone morte, qui demande la correction maximale.
export const RATE_SPAN = 0.5;

// Correction maximale de la vitesse de lecture, en part de la vitesse nominale.
//
// Cinq pour mille valent 8,6 cents de desaccord : inaudible sur un mix, et de toute facon transitoire
// puisque la correction s'annule des que le niveau revient. C'est ce que fait NetEq dans WebRTC et ce
// que fait dash.js en basse latence, a ceci pres qu'ils vont jusqu'a dix pour cent sur de la parole.
// Un mix ne le supporterait pas, et n'en a pas besoin : les grandes marches sont reprises par
// l'ebarbage a la reprise, qui tombe a un instant ou le son est deja interrompu.
export const RATE_MAX = 0.005;

// Le tableau de controle occupe huit cases de quatre octets. Les quatre cases libres laissent la
// place a un compteur supplementaire sans changer la disposition memoire.
const CONTROL_SLOTS = 8;
const CONTROL_BYTES = CONTROL_SLOTS * 4;

// Nombre d'essais accordes au vidage de la file. Le consommateur n'avance qu'une fois par bloc, soit
// toutes les 2,7 ms environ, alors qu'un essai dure quelques nanosecondes : deux essais suffisent
// toujours en pratique. La limite existe pour qu'un vidage ne puisse jamais retenir son thread.
const CLEAR_ATTEMPTS = 4;

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
    // Ce drapeau retient si la lecture precedente a manque de donnees. Il appartient au seul
    // consommateur, donc il vit dans l'objet et non dans la memoire partagee.
    this.starving = false;
    // Position de lecture entre deux echantillons, dans [0, 1). Elle n'existe que lorsque la lecture
    // tourne a une vitesse autre que la vitesse nominale, et elle appartient elle aussi au seul
    // consommateur : l'index partage reste entier, et cette fraction dit ou en est la lecture a
    // l'interieur de l'echantillon suivant.
    this.fraction = 0;
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

  // Cette methode donne le nombre de fois ou le consommateur a saute au direct.
  get skips() {
    return Atomics.load(this.control, CONTROL_SKIPS);
  }

  // Cette methode donne le nombre de fois ou la file a ete ramenee au seuil a la reprise.
  get trims() {
    return Atomics.load(this.control, CONTROL_TRIMS);
  }

  // Cette methode jette le son le plus ancien pour ne garder que `keepFrames` echantillons.
  //
  // Elle existe parce que le vidage demande par la machine d'etats est un aller-retour : le niveau
  // part du thread audio, la decision revient quarante millisecondes plus tard, et l'ordre traverse
  // encore le worker. Une rafale de paquets livree d'un coup — ce que fait le navigateur au degel du
  // thread principal, puisqu'il vide la socket dans sa memoire meme quand rien ne tourne — remplit
  // les trois secondes de la file avant que cet aller-retour n'aboutisse. La file bute alors sur sa
  // capacite et compte des blocs abandonnes, qui sont du son perdu.
  //
  // Le consommateur, lui, tourne toutes les 2,7 ms et possede l'index de lecture : il ne peut pas
  // etre distance. Il ne remplace pas le vidage, qui garde son role et son diagnostic ; il est le
  // filet en dessous, et son compteur dit exactement quand ce filet a servi.
  //
  // Seul l'index de lecture est ecrit, comme le veut la regle de cette file : c'est celui du
  // consommateur, et c'est le consommateur qui appelle cette methode.
  // `counter` dit lequel des deux compteurs enregistre l'operation : le filet du processeur audio
  // compte des sauts, l'ebarbage d'une reprise compte des ebarbages. Les deux jettent exactement de
  // la meme facon, et c'est bien pour cela qu'ils partagent ce code — mais ils ne racontent pas la
  // meme histoire, et le journal doit pouvoir les distinguer.
  dropOldest(keepFrames, counter = CONTROL_SKIPS) {
    const write = Atomics.load(this.control, CONTROL_WRITE_INDEX);
    const read = Atomics.load(this.control, CONTROL_READ_INDEX);
    const used = write >= read ? write - read : write + this.capacity - read;

    if (used <= keepFrames) {
      return false;
    }

    const advance = used - keepFrames;
    let position = read + advance;

    if (position >= this.capacity) {
      position -= this.capacity;
    }

    Atomics.store(this.control, CONTROL_READ_INDEX, position);
    // La lecture repart sur un echantillon entier : la fraction en cours decrivait une position dans
    // un son qui vient d'etre jete.
    this.fraction = 0;
    Atomics.add(this.control, counter, 1);
    return true;
  }

  // Cette methode abandonne tout l'audio en attente : nouvelle session, discontinuite, ou reprise
  // apres une pause.
  //
  // Elle ramene l'index d'ecriture sur l'index de lecture, et ne touche pas a ce dernier. C'est la
  // regle de cette file : le producteur n'ecrit que l'index d'ecriture, le consommateur n'ecrit que
  // l'index de lecture. Remettre les deux a zero depuis le producteur ecraserait la position d'un
  // consommateur en train de lire, sur le thread audio, au moment precis d'une discontinuite.
  //
  // Lire un index puis en ecrire un autre ne forme pas une operation indivisible : le consommateur
  // peut avancer entre les deux, et l'index d'ecriture se retrouve alors *derriere* celui de
  // lecture. La file se croit pleine a trois secondes, le seuil de lecture est atteint aussitot, et
  // l'auditeur entend jusqu'a trois secondes de memoire perimee. La valeur ecrite est donc relue :
  // si le consommateur a bouge, la remise est refaite sur sa nouvelle position.
  clear() {
    // La position fractionnaire decrivait un son qui n'existe plus. Elle n'a de sens que pour le
    // consommateur, donc cette remise n'a d'effet que lorsque producteur et consommateur partagent
    // le meme objet — le mode messages. En memoire partagee, la fraction laissee derriere vaut moins
    // d'un echantillon : rien qui merite de traverser le tableau de controle.
    this.fraction = 0;

    for (let attempt = 0; attempt < CLEAR_ATTEMPTS; attempt += 1) {
      const read = Atomics.load(this.control, CONTROL_READ_INDEX);
      Atomics.store(this.control, CONTROL_WRITE_INDEX, read);

      if (Atomics.load(this.control, CONTROL_READ_INDEX) === read) {
        return;
      }
    }
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
  //
  // Un manque de donnees compte une fois par episode, pas une fois par bloc. La carte son demande un
  // bloc toutes les 2,7 ms, et le thread principal ne relit le compteur que toutes les 40 ms : un
  // seul creux, entendu comme un seul trou, ajouterait une quinzaine d'unites. Le nombre affiche ne
  // dirait alors plus rien de la gravite, et la regle « la file s'est videe depuis le dernier
  // rapport » compterait quinze fois le meme evenement.
  // `ratio` est la vitesse de lecture, en part de la vitesse nominale. Il vaut un la plupart du
  // temps ; il s'en ecarte de quelques millimes quand le niveau de la file s'eloigne du seuil, et
  // c'est ce qui ramene la latence sans jamais couper le son.
  //
  // Ce reglage remplace le seul outil que le player avait pour corriger sa latence : jeter la file.
  // Jeter s'entend, et le journal du 6 aout 2026 en montrait onze en vingt-neuf minutes. Consommer
  // cinq pour mille plus vite ne s'entend pas, et rend le meme service en une minute.
  read(left, right, ratio = 1) {
    const wanted = Math.min(left.length, right.length);
    const write = Atomics.load(this.control, CONTROL_WRITE_INDEX);
    const read = Atomics.load(this.control, CONTROL_READ_INDEX);
    const used = write >= read ? write - read : write + this.capacity - read;

    // A vitesse nominale et sur un echantillon entier, chaque sortie consomme exactement une entree.
    // C'est le cas de tres loin le plus frequent, et il ne paie ni interpolation ni flottants.
    if (ratio === 1 && this.fraction === 0) {
      return this.readAligned(left, right, wanted, read, used);
    }

    // Nombre d'echantillons qu'il faut avoir en file pour produire `wanted` sorties a cette vitesse.
    // Le dernier echantillon interpole lit la case suivante : d'ou le `+ 2` et non `+ 1`.
    const needed = Math.floor(this.fraction + (wanted - 1) * ratio) + 2;

    if (used < needed) {
      // La file n'a pas de quoi tenir cette vitesse. La vitesse n'est alors plus la question : la
      // lecture alignee sait completer par du silence et compter le manque, ce que ce chemin-ci ne
      // sait pas faire. La fraction repart de zero, soit moins d'un echantillon de saut.
      this.fraction = 0;
      return this.readAligned(left, right, wanted, read, used);
    }

    let position = read;
    let fraction = this.fraction;

    for (let index = 0; index < wanted; index += 1) {
      const next = position + 1 === this.capacity ? 0 : position + 1;
      const slot = position * PCM_CHANNELS;
      const nextSlot = next * PCM_CHANNELS;

      left[index] = this.samples[slot] + (this.samples[nextSlot] - this.samples[slot]) * fraction;
      right[index] =
        this.samples[slot + 1] + (this.samples[nextSlot + 1] - this.samples[slot + 1]) * fraction;

      fraction += ratio;

      while (fraction >= 1) {
        fraction -= 1;
        position = position + 1 === this.capacity ? 0 : position + 1;
      }
    }

    this.fraction = fraction;
    Atomics.store(this.control, CONTROL_READ_INDEX, position);
    this.starving = false;

    return wanted;
  }

  // Cette methode lit a la vitesse nominale, un echantillon de file par echantillon de sortie.
  readAligned(left, right, wanted, read, used) {
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
      if (!this.starving) {
        this.starving = true;
        Atomics.add(this.control, CONTROL_UNDERRUNS, 1);
      }
    } else {
      this.starving = false;
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
      // Ces deux bornes viennent du thread principal, qui seul connait le profil de la session. Tant
      // qu'elles valent zero, le filet est inactif : une file non bornee vaut mieux qu'une file
      // tronquee sur une valeur devinee. `keepFrames` est aussi le seuil de bufferisation, donc la
      // valeur que le regulateur de vitesse cherche a tenir.
      this.ceilingFrames = 0;
      this.keepFrames = 0;
      // Vitesse de lecture appliquee au dernier bloc, remontee au thread principal pour le journal.
      this.ratio = 1;
      // Cette demande d'ebarbage est posee a chaque reprise de lecture et honoree au bloc suivant.
      //
      // C'est le correctif du defaut le plus couteux du player. Une rebufferisation s'arrete des que
      // la file atteint le seuil, mais elle ne s'arrete pas *au* seuil : TCP relache d'un coup ce
      // qu'il retenait — le journal du 6 aout 2026 montre des pointes a 96 paquets par seconde pour
      // une cadence nominale de 25 — et la lecture repartait sur tout ce qui etait arrive. Chaque
      // manque de donnees ajoutait ainsi 150 a 530 ms de latence definitive, jusqu'a ce que le vidage
      // de derive coupe le son. Ramener la file au seuil coute ici exactement zero : le son vient
      // d'etre interrompu, l'oreille est deja au milieu d'une coupure.
      this.trimPending = false;

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

        if (message.type === "limit") {
          this.ceilingFrames = message.ceilingFrames;
          this.keepFrames = message.keepFrames;
          return;
        }

        if (message.type === "play") {
          // Une reprise deja en cours ne redemande rien : `setPlaying` ne transmet que les vraies
          // transitions, mais ce processeur ne depend pas de cette politesse.
          this.trimPending = !this.playing;
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

      // Le filet agit avant la lecture, et aussi quand la lecture est arretee : c'est justement
      // pendant la bufferisation que personne ne consomme et que la file grossit sans frein.
      if (this.ceilingFrames > 0 && this.ring.available > this.ceilingFrames) {
        this.ring.dropOldest(this.keepFrames);
      }

      // L'ebarbage de reprise vient juste apres, et l'ordre compte : le filet traite le cas ou la
      // file a explose, l'ebarbage traite le cas ordinaire ou elle depasse simplement le seuil.
      if (this.trimPending) {
        this.trimPending = false;

        if (this.keepFrames > 0) {
          this.ring.dropOldest(this.keepFrames, CONTROL_TRIMS);
        }
      }

      if (this.playing) {
        this.ratio = this.consumptionRatio();
        this.ring.read(left, right, this.ratio);
      } else {
        this.ratio = 1;
        left.fill(0);
        right.fill(0);
      }

      this.report();
      return this.running;
    }

    // Cette methode rend la vitesse a laquelle la file doit etre consommee maintenant.
    //
    // Elle est proportionnelle a l'ecart au seuil, nulle dans une zone morte, et bornee a quelques
    // millimes. C'est la forme la plus simple qui converge : au-dela de la zone morte la correction
    // croit lineairement jusqu'a son maximum, et elle s'annule d'elle-meme des que le niveau revient.
    //
    // Elle sert deux causes a la fois, et c'est voulu. La premiere est le residu que l'ebarbage
    // laisse derriere lui. La seconde est la derive d'horloge entre le poste Ableton et l'auditeur :
    // mesuree a moins de 30 ppm sur les journaux du 6 aout 2026, donc negligeable aujourd'hui, mais
    // un regulateur qui tient le niveau la corrige sans avoir jamais eu a la nommer.
    consumptionRatio() {
      if (this.keepFrames <= 0) {
        return 1;
      }

      const error = this.ring.available - this.keepFrames;
      const deadband = this.keepFrames * RATE_DEADBAND;

      if (error > -deadband && error < deadband) {
        return 1;
      }

      // L'ecart est compte a partir du bord de la zone morte, pas du seuil : la correction part donc
      // de zero au bord au lieu de sauter, et rien ne s'entend au passage.
      const excess = error > 0 ? error - deadband : error + deadband;
      const correction = Math.max(-1, Math.min(1, excess / (this.keepFrames * RATE_SPAN)));

      return 1 + RATE_MAX * correction;
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
        // Les abandons faute de place sont la mesure directe du mode messages sous charge : un
        // port qui n'arrive plus a suivre les fait monter.
        overflows: this.ring.overflows,
        // Les sauts au direct disent que le filet a servi, donc que le vidage a ete distance.
        skips: this.ring.skips,
        // Les ebarbages disent combien de reprises ont ramene la file au seuil. Contrairement aux
        // sauts, en voir beaucoup est bon signe : chacun est une latence qui n'a pas ete gardee.
        trims: this.ring.trims,
        // La vitesse appliquee dit si le regulateur travaille, et dans quel sens.
        ratio: this.ratio,
      });
    }
  }

  registerProcessor(PCM_PROCESSOR_NAME, VassiPcmProcessor);
}
