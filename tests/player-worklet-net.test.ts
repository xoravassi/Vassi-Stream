import assert from "node:assert/strict";
import test from "node:test";

// Ce fichier verifie le filet du processeur audio : les trois lignes de `process()` qui jettent le
// son le plus ancien quand la file a depasse son plafond.
//
// C'est la seule partie de `pcm-worklet.js` qui ne tourne que dans un AudioWorklet. `dropOldest` a
// ses propres tests ; ce fichier couvre l'autre moitie de la question — qui l'appelle, et quand.
// C'est la que le plafond calcule par `audio-player.ts` est consomme.
//
// Aucun harnais de navigateur n'est necessaire. Le module s'enregistre lui-meme au chargement en
// appelant `registerProcessor`, donc il suffit de poser les deux globales d'un AudioWorklet avant de
// l'importer pour recevoir la classe du processeur.

// Cette classe imite le port par lequel le thread principal commande le processeur.
class FakePort {
  readonly sent: Record<string, unknown>[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(data: Record<string, unknown>): void {
    this.sent.push(data);
  }

  // Cette methode remet un ordre au processeur, comme le ferait le thread principal.
  deliver(data: Record<string, unknown>): void {
    this.onmessage?.({ data });
  }
}

const globales = globalThis as unknown as Record<string, unknown>;
let ProcesseurEnregistre: unknown = null;

// Un AudioWorklet fournit ces deux globales. La classe de base ne sert qu'a porter le port : le
// processeur n'utilise rien d'autre de son heritage.
globales.AudioWorkletProcessor = class {
  readonly port = new FakePort();
};
globales.registerProcessor = (_nom: string, classe: unknown): void => {
  ProcesseurEnregistre = classe;
};

// L'import est dynamique parce qu'il doit venir apres les deux globales : un import statique serait
// evalue avant elles, et le module ne s'enregistrerait pas.
const { createPcmBuffer, PcmRing, PCM_SAMPLE_RATE } = await import("../src/player/pcm-worklet.js");

// Cette fonction convertit une duree en echantillons.
//
// Le filet, lui, se juge sur des rapports de tailles et se contente d'une file minuscule. Le
// regulateur de vitesse non : depuis le 11 aout 2026 sa zone morte et sa pente sont des durees fixes
// — 150 et 500 ms — et non plus des parts du seuil, parce qu'en proportion elles enflaient avec lui
// et le rendaient d'autant plus paresseux que la situation etait mauvaise. Les tests du regulateur
// travaillent donc a l'echelle reelle, seule ou ces durees veulent dire quelque chose.
function echantillons(ms: number): number {
  return Math.round((ms * PCM_SAMPLE_RATE) / 1000);
}

assert.ok(ProcesseurEnregistre !== null, "le module doit enregistrer son processeur au chargement");

// Ce type decrit la surface du processeur utilisee ici.
type Processeur = {
  port: FakePort;
  process: (entrees: unknown[], sorties: Float32Array[][]) => boolean;
};

// Cette fonction cree un processeur et la file que le worker de decodage remplirait.
//
// La capacite est volontairement minuscule : le filet se juge sur des rapports de tailles, pas sur
// des secondes, et une petite file rend les nombres lisibles dans les assertions.
function monter(capaciteFrames = 1000): { processeur: Processeur; file: InstanceType<typeof PcmRing> } {
  const buffer = createPcmBuffer(false, capaciteFrames);
  const Classe = ProcesseurEnregistre as new (options: unknown) => Processeur;
  const processeur = new Classe({ processorOptions: { buffer, capacityFrames: capaciteFrames } });

  return { processeur, file: new PcmRing(buffer, capaciteFrames) };
}

// Cette fonction ecrit `nombre` frames reconnaissables dans la file, comme le ferait le decodeur.
function remplir(file: InstanceType<typeof PcmRing>, nombre: number): void {
  const left = new Float32Array(nombre);
  const right = new Float32Array(nombre);

  for (let index = 0; index < nombre; index += 1) {
    left[index] = index;
    right[index] = -index;
  }

  assert.equal(file.write(left, right), true);
}

// Cette fonction cree le bloc de sortie que la carte son demande, et garde ses deux canaux sous la
// main pour que les tests puissent les relire sans redescendre dans le tableau.
function blocDeSortie(taille = 128): { sorties: Float32Array[][]; gauche: Float32Array; droite: Float32Array } {
  const gauche = new Float32Array(taille);
  const droite = new Float32Array(taille);

  return { sorties: [[gauche, droite]], gauche, droite };
}

// Ce test couvre le cas pour lequel le filet existe : la file grossit pendant la bufferisation,
// quand personne ne consomme. C'est justement la que le vidage demande par la machine d'etats peut
// etre distance, puisque son aller-retour dure au moins quarante millisecondes.
test("saute au direct au-dessus du plafond, meme lecture arretee", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  remplir(file, 700);

  processeur.process([], blocDeSortie().sorties);

  assert.equal(file.available, 200, "la file doit redescendre a ce qu'on demande de garder");
  assert.equal(file.skips, 1, "le saut doit etre compte, sinon il n'est raconte nulle part");
});

// Ce test verifie que le filet ne touche a rien tant que la file tient dans sa borne. Un filet qui
// se declencherait trop tot jetterait du son que le vidage aurait rattrape proprement, avec son
// diagnostic et sa rebufferisation.
test("ne touche pas a une file qui tient dans son plafond", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  remplir(file, 500);

  processeur.process([], blocDeSortie().sorties);

  assert.equal(file.available, 500);
  assert.equal(file.skips, 0);
});

// Ce test verifie l'ordre a l'interieur d'un bloc : le filet agit avant la lecture, donc les
// echantillons entendus juste apres un saut sont les plus recents.
//
// Sans cet ordre, le bloc en cours serait lu dans le son ancien avant que celui-ci soit jete : le
// saut s'entendrait deux fois, une premiere en retard puis une seconde au direct.
test("laisse entendre le son le plus recent apres un saut", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  processeur.port.deliver({ type: "play" });
  remplir(file, 700);

  const bloc = blocDeSortie();
  processeur.process([], bloc.sorties);

  // Sur 700 frames, garder les 200 dernieres commence a la frame 500. Le bloc lu commence donc la,
  // et non a la frame 0.
  assert.equal(bloc.gauche[0], 500);
  assert.equal(bloc.gauche[127], 627);
  assert.equal(bloc.droite[0], -500);
  assert.equal(file.available, 200 - 128);
});

// Ce test couvre l'etat de depart du processeur : tant que le thread principal n'a pas annonce le
// profil de la session, aucune borne n'est connue. Une file non bornee vaut alors mieux qu'une file
// tronquee sur une valeur devinee, qui jetterait du son sans raison des la premiere seconde.
test("ne saute jamais tant qu'aucun plafond n'est connu", () => {
  const { processeur, file } = monter();

  remplir(file, 900);
  processeur.process([], blocDeSortie().sorties);

  assert.equal(file.available, 900);
  assert.equal(file.skips, 0);
});

// Ce test couvre le poste de latence le plus couteux du player, celui que le journal du 6 aout
// 2026 montre onze fois en vingt-neuf minutes.
//
// Une rebufferisation s'arrete des que la file atteint le seuil, mais elle ne s'arrete pas *au*
// seuil : TCP relache d'un coup ce qu'il retenait, et la file passe de zero a bien plus que le seuil
// entre deux releves. Sans ebarbage, cet exces restait la pour toujours — rien dans le player ne
// pouvait le reprendre — jusqu'a ce que le vidage de derive coupe le son. La latence montait ainsi
// en cliquet, de 800 ms a 1500, manque de donnees apres manque de donnees.
test("ramene la file au seuil a la reprise de lecture", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  // 500 frames : bien au-dessus du seuil, mais sous le plafond du filet. C'est la zone que seul le
  // filet couvre.
  remplir(file, 500);
  processeur.port.deliver({ type: "play" });

  const bloc = blocDeSortie();
  processeur.process([], bloc.sorties);

  assert.equal(file.trims, 1, "l'ebarbage doit etre compte");
  assert.equal(file.skips, 0, "le filet n'a pas a intervenir : la file tenait dans son plafond");
  assert.equal(file.available, 200 - 128, "la file doit repartir du seuil, moins le bloc consomme");
  // Garder les 200 dernieres de 500 commence a la frame 300 : la lecture repart bien du son recent.
  assert.equal(bloc.gauche[0], 300);
});

// Ce test verifie que l'ebarbage ne se declenche qu'a la reprise. Applique a chaque bloc, il
// empecherait la file de porter la moindre marge au-dessus du seuil, et le premier soubresaut du
// reseau produirait un manque de donnees.
test("n'ebarbe qu'a la reprise, pas a chaque bloc", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  remplir(file, 500);
  processeur.port.deliver({ type: "play" });

  processeur.process([], blocDeSortie().sorties);
  remplir(file, 300);
  processeur.process([], blocDeSortie().sorties);

  assert.equal(file.trims, 1, "un seul ebarbage pour une seule reprise");
  assert.equal(file.available, 200 - 128 + 300 - 128);
});

// Ce test verifie que la lecture arretee n'ebarbe rien : pendant une bufferisation, la file doit
// pouvoir monter jusqu'au seuil sans que personne y touche.
test("n'ebarbe pas tant que la lecture n'a pas repris", () => {
  const { processeur, file } = monter();

  processeur.port.deliver({ type: "limit", ceilingFrames: 600, keepFrames: 200 });
  remplir(file, 500);

  processeur.process([], blocDeSortie().sorties);

  assert.equal(file.trims, 0);
  assert.equal(file.available, 500);
});

// Cette fonction fait tourner assez de blocs pour recevoir un releve, et rend le dernier.
//
// La file est regarnie d'un bloc avant chaque tour, comme le ferait le decodeur d'un direct sain :
// le niveau reste alors celui que le test a voulu, au lieu de fondre en une poignee de blocs et de
// faire mesurer une correction qui ne repond plus a la question posee.
function dernierReleve(
  processeur: Processeur,
  file: InstanceType<typeof PcmRing>,
  blocs = 17,
): Record<string, unknown> {
  for (let index = 0; index < blocs; index += 1) {
    remplir(file, 128);
    processeur.process([], blocDeSortie().sorties);
  }

  const releves = processeur.port.sent.filter((message) => message.type === "level");
  const dernier = releves[releves.length - 1];

  assert.ok(dernier !== undefined, "le processeur doit avoir annonce au moins un niveau");
  return dernier;
}

// Ce test verifie que le regulateur de vitesse se tait quand le niveau est celui qu'on veut. Une
// correction permanente ferait travailler l'interpolation pour rien, et desaccorderait le son en
// continu au lieu de le faire seulement le temps de converger.
test("ne corrige pas la vitesse quand le niveau tient le seuil", () => {
  const { processeur, file } = monter(4000);

  processeur.port.deliver({ type: "limit", ceilingFrames: 3000, keepFrames: 1000 });
  remplir(file, 1000);
  processeur.port.deliver({ type: "play" });

  assert.equal(dernierReleve(processeur, file).ratio, 1);
});

// Ce test verifie que le regulateur accelere quand la file est trop pleine, et qu'il reste dans ses
// bornes. C'est ce qui remplace le vidage : cinq pour mille valent 8,6 cents de desaccord, la ou
// jeter une seconde de son s'entend comme une coupure.
test("accelere la lecture quand la file depasse le seuil, sans depasser sa borne", () => {
  const { processeur, file } = monter(echantillons(1600));

  processeur.port.deliver({
    type: "limit",
    ceilingFrames: echantillons(1400),
    keepFrames: echantillons(400),
  });
  remplir(file, echantillons(400));
  processeur.port.deliver({ type: "play" });
  // Ce premier bloc consomme l'ebarbage de la reprise. Sans lui, l'ebarbage ramenerait la file au
  // seuil et le test mesurerait une correction nulle : c'est bien ce qu'on veut a la reprise, mais
  // ce n'est pas ce que ce test-ci pose comme question.
  processeur.process([], blocDeSortie().sorties);

  // Un excedent de 700 ms : au-dela de la zone morte de 150 ms **et** de la pente de 500 ms, donc la
  // correction maximale.
  remplir(file, echantillons(700));

  const ratio = dernierReleve(processeur, file).ratio as number;

  assert.ok(ratio > 1, "la lecture doit consommer plus vite pour resorber l'exces");
  assert.ok(ratio <= 1.005, `la correction doit rester inaudible, recu ${ratio}`);
});

// Ce test fixe la consequence directe du passage a une zone morte en millisecondes : elle ne doit
// plus enfler avec le seuil. A 2000 ms de seuil, la version proportionnelle a 15 % laissait le
// regulateur muet jusqu'a 1700 ms de file — c'est ce silence qui a laisse la file du 11 aout 2026
// descendre a 982 ms de mediane sans qu'aucune correction ne parte.
test("corrige aussi vite a seuil eleve qu'a seuil bas", () => {
  const { processeur, file } = monter(echantillons(4000));

  processeur.port.deliver({
    type: "limit",
    ceilingFrames: echantillons(3500),
    keepFrames: echantillons(2000),
  });
  // 1750 ms pour un seuil de 2000 : la version proportionnelle rendait exactement 1 ici.
  remplir(file, echantillons(1750));
  processeur.port.deliver({ type: "play" });

  const ratio = dernierReleve(processeur, file).ratio as number;

  assert.ok(ratio < 1, `le regulateur doit corriger a seuil eleve, recu ${ratio}`);
});

// Ce test verifie l'autre sens : une file trop maigre se consomme plus lentement, ce qui laisse au
// reseau le temps de la regarnir au lieu de la vider jusqu'au manque de donnees.
test("ralentit la lecture quand la file passe sous le seuil", () => {
  const { processeur, file } = monter(echantillons(1600));

  processeur.port.deliver({
    type: "limit",
    ceilingFrames: echantillons(1400),
    keepFrames: echantillons(400),
  });
  remplir(file, echantillons(100));
  processeur.port.deliver({ type: "play" });

  const ratio = dernierReleve(processeur, file).ratio as number;

  assert.ok(ratio < 1, "la lecture doit ralentir pour laisser la file se regarnir");
  assert.ok(ratio >= 0.995, `la correction doit rester inaudible, recu ${ratio}`);
});
