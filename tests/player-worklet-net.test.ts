import assert from "node:assert/strict";
import test from "node:test";

// Ce fichier verifie le filet du processeur audio : les trois lignes de `process()` qui jettent le
// son le plus ancien quand la file a depasse son plafond.
//
// C'est la seule partie de `pcm-worklet.js` qui ne tourne que dans un AudioWorklet, et elle etait
// jusqu'ici la seule non couverte : `dropOldest` avait ses tests, mais rien ne verifiait qui
// l'appelle, ni quand. C'est pourtant la que le plafond calcule par `audio-player.ts` est consomme.
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
const { createPcmBuffer, PcmRing } = await import("../src/player/pcm-worklet.js");

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
