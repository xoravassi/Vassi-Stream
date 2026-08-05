import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ce script recopie le moteur audio du navigateur dans le depot du site web, et verifie ensuite que
// les deux copies sont identiques.
//
// Il existe pour une raison de deploiement. Le site se construit depuis son seul dossier
// `frontend/` : rien d'exterieur a ce dossier n'existe au moment du build. Le moteur doit donc s'y
// trouver physiquement. La copie est mecanique et verifiee par `player:check`, donc personne n'a a
// la tenir a jour a la main.
//
// Deux commandes :
//   npm run player:sync   copie le moteur vers le site
//   npm run player:check  compare les deux copies et echoue si elles different
//
// L'explication complete est dans `docs/pont-site-web.md`.

const ICI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(ICI, "..");

// Le depot du site est le voisin de celui-ci. Les deux vivent cote a cote dans le meme dossier
// parent, et cette hypothese est verifiee avant chaque copie : une absence est annoncee clairement
// plutot que de produire un dossier au mauvais endroit.
const SITE = resolve(REPO, "..", "vassi.click");
const DESTINATION = join(SITE, "frontend", "src", "lib", "vassi-stream");

// Ces deux dossiers sont recopies en entier, en gardant leurs noms. Le decodeur importe
// `../protocol/audio-packet.ts` : garder les deux dossiers cote a cote laisse cet import valide sans
// toucher une seule ligne du moteur.
const DOSSIERS = ["player", "protocol"];

// Cette fonction rend la liste des fichiers du moteur, lue sur le disque.
//
// La liste n'est jamais ecrite en dur. Ajouter un module au moteur suffit donc a le faire voyager :
// il n'y a pas de second endroit a mettre a jour, donc pas d'oubli possible.
//
// La descente est recursive. Le moteur est plat aujourd'hui, mais un sous-dossier ajoute un jour ne
// doit pas faire echouer la copie sur une erreur de lecture obscure — ni, pire, voyager a moitie.
function listerFichiers(racine) {
  const trouves = [];

  for (const dossier of DOSSIERS) {
    if (existsSync(join(racine, dossier))) {
      collecter(racine, dossier, trouves);
    }
  }

  // Le tri porte sur la liste entiere plutot que sur chaque dossier : deux machines produisent ainsi
  // le meme manifeste, quel que soit l'ordre dans lequel leur systeme de fichiers rend les entrees.
  return trouves.sort();
}

// Cette fonction ajoute a `trouves` les fichiers d'un dossier et de ses sous-dossiers.
function collecter(racine, prefixe, trouves) {
  for (const entree of readdirSync(join(racine, prefixe), { withFileTypes: true })) {
    // Les chemins du manifeste utilisent toujours des barres obliques, sur Windows comme ailleurs :
    // sinon le meme moteur produirait deux manifestes differents selon la machine.
    const chemin = posix.join(prefixe, entree.name);

    if (entree.isDirectory()) {
      collecter(racine, chemin, trouves);
      continue;
    }

    trouves.push(chemin);
  }
}

// Cette fonction rend l'empreinte SHA-256 du contenu d'un fichier.
//
// L'empreinte porte sur les octets bruts, pas sur le texte : une fin de ligne changee par un editeur
// est une difference reelle, et elle doit se voir.
function empreinte(chemin) {
  return createHash("sha256").update(readFileSync(chemin)).digest("hex");
}

// Cette fonction rend le commit courant du depot, ou `null` quand git ne repond pas.
function commitCourant() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Cette fonction verifie que le depot du site est bien la, et arrete le script sinon.
function exigerLeSite() {
  if (existsSync(SITE)) {
    return;
  }

  console.error(`Le depot du site est introuvable : ${SITE}`);
  console.error("Les deux depots doivent etre voisins dans le meme dossier parent.");
  process.exit(1);
}

// Cette fonction copie le moteur vers le site.
//
// Les deux chemins sont des parametres pour que les tests puissent la lancer sur des dossiers
// temporaires. En usage normal, ce sont les deux depots voisins.
function synchroniser(source = join(REPO, "src"), destination = DESTINATION) {
  const fichiers = listerFichiers(source);

  if (fichiers.length === 0) {
    console.error(`Aucun fichier de moteur trouve dans ${source}. Rien n'est copie.`);
    process.exit(1);
  }

  // Les anciens fichiers partent avant la copie. Sans ce nettoyage, un module supprime du moteur
  // resterait indefiniment dans le site, ou il continuerait d'etre lu et compile.
  for (const dossier of DOSSIERS) {
    rmSync(join(destination, dossier), { recursive: true, force: true });
  }

  const empreintes = {};

  for (const fichier of fichiers) {
    const origine = join(source, fichier);
    const cible = join(destination, fichier);

    mkdirSync(dirname(cible), { recursive: true });
    writeFileSync(cible, readFileSync(origine));
    empreintes[fichier] = empreinte(origine);
  }

  ecrireManifeste(empreintes, destination);
  ecrireLisezMoi(destination);

  console.log(`Moteur copie vers ${relative(process.cwd(), destination)}`);
  console.log(`${fichiers.length} fichiers, ${DOSSIERS.length} dossiers.`);
  console.log("Pense a committer le depot du site : la copie en fait partie.");

  return fichiers;
}

// Cette fonction ecrit le manifeste des empreintes.
//
// Le manifeste n'est reecrit que si le contenu du moteur a change. Une copie qui ne change rien ne
// doit pas produire de difference dans git a cause de la seule date.
function ecrireManifeste(empreintes, destination) {
  const chemin = join(destination, "manifest.json");
  const ancien = lireManifeste(chemin);

  if (ancien !== null && JSON.stringify(ancien.fichiers) === JSON.stringify(empreintes)) {
    return;
  }

  const manifeste = {
    _lisezMoi: "Fichier genere par `npm run player:sync` dans le depot vassi-stream. Ne pas editer.",
    source: "https://github.com/xoravassi/Vassi-Stream",
    commit: commitCourant(),
    copieLe: new Date().toISOString().slice(0, 10),
    fichiers: empreintes,
  };

  mkdirSync(destination, { recursive: true });
  writeFileSync(chemin, `${JSON.stringify(manifeste, null, 2)}\n`, "utf8");
}

// Cette fonction lit un manifeste existant, ou rend `null` quand il n'existe pas ou ne se lit pas.
function lireManifeste(chemin) {
  if (!existsSync(chemin)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch {
    return null;
  }
}

// Cette fonction ecrit l'avertissement lu par quiconque ouvre le dossier depuis le site.
function ecrireLisezMoi(destination) {
  const texte = `# Moteur audio Vassi Stream — copie automatique

**N'editez aucun fichier de ce dossier.** Ils sont copies depuis un autre depot et
toute modification faite ici sera ecrasee a la prochaine copie.

## D'ou viennent ces fichiers

Ils viennent du depot **Vassi Stream** (https://github.com/xoravassi/Vassi-Stream),
qui contient le device Max for Live d'Ableton, le relais WebSocket et ce moteur audio.
Ce dossier n'en contient que la partie qui tourne dans le navigateur.

Pourquoi une copie plutot qu'une dependance npm ou un sous-module git : le site se
construit depuis son seul dossier \`frontend/\` (voir \`deploy.sh\` et \`frontend/Dockerfile\`).
Rien d'exterieur a ce dossier n'existe au moment du build, donc le moteur doit s'y trouver
physiquement. La copie est mecanique et automatiquement verifiee, ce qui evite d'ajouter
une etape fragile a une chaine de deploiement qui fonctionne.

## Comment modifier le moteur

1. Ouvrir le depot **Vassi Stream** (voisin de celui-ci sur le disque).
2. Modifier le code dans \`src/player/\` ou \`src/protocol/\`.
3. Y lancer \`npm run check\` — les tests du moteur y vivent.
4. Y lancer \`npm run player:sync\` — ce dossier est reecrit.
5. Committer **les deux depots**.

## Comment savoir si la copie est a jour

Dans le depot Vassi Stream : \`npm run player:check\`.
Il compare les empreintes de \`manifest.json\` et dit exactement quel fichier differe.
Cette commande fait partie de \`npm run check\`, la verification lancee a chaque etape
du projet : une copie oubliee se voit donc immediatement, la-bas et non ici.

## Ce qu'il y a dedans

| Dossier | Role |
|---|---|
| \`player/\` | connexion au relais, machine d'etats, decodage Opus, lecture audio |
| \`protocol/\` | lecture de l'en-tete binaire des paquets audio |

Le seul fichier a importer est \`player/index.ts\` : c'est la surface publique du moteur.
Tout le reste est interne.

La page qui l'utilise est \`src/routes/session/\` — voir sa cheat sheet.
`;

  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "README.md"), texte, "utf8");
}

// Cette fonction compare les deux copies et rend `true` quand elles sont identiques.
//
// Elle compare trois choses : la liste des fichiers, leur contenu, et le manifeste. Le manifeste
// seul ne suffirait pas — il pourrait avoir ete recopie sans les fichiers — et les fichiers seuls
// ne diraient pas de quel commit ils viennent.
function verifier(source = join(REPO, "src"), destination = DESTINATION) {
  // Une machine qui n'a pas le depot du site n'a rien a verifier. Le script le dit et reussit :
  // `npm run check` doit rester utilisable partout, y compris la ou le site n'existe pas.
  if (!existsSync(destination)) {
    console.log("Copie du moteur dans le site : absente, rien a verifier.");
    console.log(`Attendue dans ${destination}`);
    return true;
  }

  const attendus = listerFichiers(source);
  const presents = listerFichiers(destination);
  const problemes = [];

  for (const fichier of attendus) {
    if (!presents.includes(fichier)) {
      problemes.push(`manquant dans le site : ${fichier}`);
      continue;
    }

    if (empreinte(join(source, fichier)) !== empreinte(join(destination, fichier))) {
      problemes.push(`contenu different : ${fichier}`);
    }
  }

  // Un fichier supprime du moteur mais reste dans le site continuerait d'y etre compile. Il compte
  // donc comme une difference, au meme titre qu'un fichier manquant.
  for (const fichier of presents) {
    if (!attendus.includes(fichier)) {
      problemes.push(`en trop dans le site : ${fichier}`);
    }
  }

  const manifeste = lireManifeste(join(destination, "manifest.json"));

  if (manifeste === null) {
    problemes.push("manifest.json absent ou illisible");
  } else {
    for (const fichier of attendus) {
      if (manifeste.fichiers?.[fichier] !== empreinte(join(source, fichier))) {
        problemes.push(`manifeste perime : ${fichier}`);
      }
    }
  }

  if (problemes.length === 0) {
    console.log(`Copie du moteur dans le site : a jour (${attendus.length} fichiers).`);
    return true;
  }

  console.error("La copie du moteur dans le site ne correspond plus a la source :");

  for (const probleme of problemes) {
    console.error(`  - ${probleme}`);
  }

  console.error("");
  console.error("Corriger avec : npm run player:sync");
  return false;
}

export { DESTINATION, DOSSIERS, listerFichiers, SITE, synchroniser, verifier };

// Ce branchement laisse les tests importer les fonctions ci-dessus sans rien declencher. La
// comparaison passe par `pathToFileURL` parce qu'un chemin Windows ne devient pas une URL valide en
// remplacant seulement ses barres obliques.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    process.exit(verifier() ? 0 : 1);
  } else {
    exigerLeSite();
    synchroniser();
  }
}
