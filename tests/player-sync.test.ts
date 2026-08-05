import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DOSSIERS, listerFichiers, synchroniser, verifier } from "../scripts/sync-player.js";

// Ce fichier verifie le pont qui recopie le moteur audio vers le depot du site.
//
// Il porte sur le seul risque reel de cette solution : que les deux copies divergent sans que
// personne ne le voie. Chaque test travaille sur des dossiers temporaires, jamais sur le vrai depot
// du site, pour qu'une machine sans le site puisse quand meme lancer `npm run check`.

// Ces trois fonctions coupent le bavardage du script pendant les tests.
function sansBruit<T>(action: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};

  try {
    return action();
  } finally {
    console.log = log;
    console.error = error;
  }
}

// Cette fonction cree un faux moteur de deux fichiers dans un dossier temporaire.
function faireUnFauxMoteur(): { racine: string; source: string; destination: string } {
  const racine = mkdtempSync(join(tmpdir(), "vassi-sync-"));
  const source = join(racine, "src");
  const destination = join(racine, "site");

  mkdirSync(join(source, "player"), { recursive: true });
  mkdirSync(join(source, "protocol"), { recursive: true });
  writeFileSync(join(source, "player", "index.ts"), "export const moteur = 1;\n");
  writeFileSync(join(source, "protocol", "audio-packet.ts"), "export const paquet = 2;\n");

  return { racine, source, destination };
}

test("la liste des fichiers est lue sur le disque, jamais ecrite en dur", () => {
  const { racine, source } = faireUnFauxMoteur();

  try {
    // Un fichier ajoute au moteur apparait dans la liste sans qu'aucun code ne change. C'est la
    // garantie qui empeche un module d'etre oublie pendant une copie.
    writeFileSync(join(source, "player", "nouveau-module.ts"), "export const neuf = 3;\n");

    const fichiers = listerFichiers(source);

    assert.deepEqual(fichiers, [
      "player/index.ts",
      "player/nouveau-module.ts",
      "protocol/audio-packet.ts",
    ]);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

// Ce test couvre un moteur range en sous-dossiers. Il n'en a pas aujourd'hui, et c'est justement le
// risque : une descente arretee au premier niveau ne se voit pas tant que le moteur reste plat, puis
// le jour ou un sous-dossier apparait la copie s'arrete sur une erreur de lecture qui ne dit pas ce
// qu'il faut corriger — ou pire, part a moitie.
test("un sous-dossier du moteur voyage comme le reste", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    mkdirSync(join(source, "player", "decodeurs"), { recursive: true });
    writeFileSync(join(source, "player", "decodeurs", "opus.ts"), "export const opus = 5;\n");

    const fichiers = listerFichiers(source);
    assert.ok(fichiers.includes("player/decodeurs/opus.ts"), "le fichier imbrique doit etre liste");

    sansBruit(() => synchroniser(source, destination));

    assert.equal(
      readFileSync(join(destination, "player", "decodeurs", "opus.ts"), "utf8"),
      "export const opus = 5;\n",
    );
    assert.equal(sansBruit(() => verifier(source, destination)), true);

    // Et la verification doit voir une divergence aussi loin dans l'arborescence qu'ailleurs.
    writeFileSync(join(destination, "player", "decodeurs", "opus.ts"), "export const opus = 6;\n");
    assert.equal(sansBruit(() => verifier(source, destination)), false);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la copie reproduit les octets a l'identique", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    sansBruit(() => synchroniser(source, destination));

    for (const fichier of listerFichiers(source)) {
      assert.deepEqual(
        readFileSync(join(destination, fichier)),
        readFileSync(join(source, fichier)),
        `${fichier} doit etre copie octet pour octet`,
      );
    }
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la copie ecrit un avertissement et un manifeste couvrant tous les fichiers", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    sansBruit(() => synchroniser(source, destination));

    const lisezMoi = readFileSync(join(destination, "README.md"), "utf8");
    assert.match(lisezMoi, /N'editez aucun fichier de ce dossier/);

    const manifeste = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifeste.fichiers).sort(), listerFichiers(source));
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la verification accepte deux copies identiques", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    sansBruit(() => synchroniser(source, destination));
    assert.equal(sansBruit(() => verifier(source, destination)), true);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la verification refuse un seul octet different", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    sansBruit(() => synchroniser(source, destination));

    // C'est le scenario que ce pont doit attraper : le moteur evolue et la copie reste en arriere.
    writeFileSync(join(source, "player", "index.ts"), "export const moteur = 2;\n");

    assert.equal(sansBruit(() => verifier(source, destination)), false);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la verification refuse un fichier ajoute au moteur mais absent du site", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    sansBruit(() => synchroniser(source, destination));
    writeFileSync(join(source, "player", "ajout.ts"), "export const ajout = 3;\n");

    assert.equal(sansBruit(() => verifier(source, destination)), false);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("un module supprime du moteur disparait aussi du site", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    writeFileSync(join(source, "player", "ancien-module.ts"), "export const ancien = 4;\n");
    sansBruit(() => synchroniser(source, destination));
    assert.ok(existsSync(join(destination, "player", "ancien-module.ts")));

    // Un fichier laisse derriere continuerait d'etre compile par le site alors qu'il n'existe plus
    // dans le moteur. La copie efface donc les dossiers avant de les remplir.
    rmSync(join(source, "player", "ancien-module.ts"));
    sansBruit(() => synchroniser(source, destination));

    assert.equal(existsSync(join(destination, "player", "ancien-module.ts")), false);
    assert.deepEqual(readdirSync(join(destination, "player")), ["index.ts"]);
    assert.equal(sansBruit(() => verifier(source, destination)), true);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("la verification reussit quand le depot du site est absent", () => {
  const { racine, source, destination } = faireUnFauxMoteur();

  try {
    // Une machine sans le depot du site doit pouvoir lancer `npm run check` sans echouer.
    assert.equal(sansBruit(() => verifier(source, destination)), true);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test("le moteur reel tient dans les deux dossiers que la copie transporte", () => {
  // Ce test relie le script au vrai projet : si un module du moteur naissait ailleurs que dans
  // `src/player` ou `src/protocol`, il ne serait jamais copie, et la page du site casserait en
  // production sans qu'aucun test ne l'ait dit.
  const fichiers = listerFichiers(join(import.meta.dirname, "..", "src"));

  assert.ok(fichiers.includes("player/index.ts"), "la surface publique du moteur doit etre copiee");
  assert.ok(fichiers.includes("protocol/audio-packet.ts"), "le lecteur d'en-tete doit etre copie");
  assert.deepEqual(DOSSIERS, ["player", "protocol"]);

  for (const fichier of fichiers) {
    assert.ok(
      fichier.startsWith("player/") || fichier.startsWith("protocol/"),
      `${fichier} sort des dossiers transportes`,
    );
  }
});
