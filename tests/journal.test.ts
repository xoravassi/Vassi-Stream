// Ces tests couvrent le journal du device : ce qu'il garde, ce qu'il refuse de garder, et ce qui
// sort quand Vassi clique sur Copier ou sur Exporter.
//
// Ils tiennent une place particuliere : le journal est l'outil qu'on ouvre quand plus rien d'autre
// ne repond, donc celui qui n'a pas le droit d'etre faux. Un journal qui perd les lignes anciennes
// au mauvais moment, ou qui laisse passer un token, fait plus de mal que pas de journal du tout.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { Journal, plain } = require("../device/node/journal.js");

// Cette horloge avance d'une seconde a chaque ligne : les heures affichees restent previsibles.
function fixedClock(): () => Date {
  let seconds = 0;

  return () => {
    const date = new Date(2026, 7, 10, 21, 14, seconds);
    seconds += 1;
    return date;
  };
}

// Cette fonction cree un journal de test : horloge figee, dossier temporaire, presse-papiers factice.
function makeJournal(options: Record<string, unknown> = {}): {
  journal: any;
  folder: string;
  copied: string[];
  cleanup: () => void;
} {
  const folder = mkdtempSync(join(tmpdir(), "vassi-journal-"));
  const copied: string[] = [];
  const journal = new Journal({
    now: fixedClock(),
    folder: () => folder,
    copyText: (text: string) => {
      copied.push(text);
      return Promise.resolve();
    },
    ...options,
  });

  return { journal, folder, copied, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("date chaque ligne et aligne la categorie", () => {
  const { journal, cleanup } = makeJournal();

  journal.record("direct", "en direct");

  assert.deepEqual(journal.lines(), ["21:14:00 direct    en direct"]);
  cleanup();
});

// Une reconnexion qui echoue toujours de la meme facon ne doit pas chasser du journal ce qui
// explique pourquoi elle echoue.
test("regroupe une ligne repetee au lieu de la repeter", () => {
  const { journal, cleanup } = makeJournal();

  journal.record("direct", "RECONNECTING : relais silencieux");
  journal.record("direct", "RECONNECTING : relais silencieux");
  journal.record("direct", "RECONNECTING : relais silencieux");

  assert.equal(journal.lines().length, 1);
  assert.match(journal.lines()[0], /relais silencieux \(x3\)$/);
  // L'heure suivie est celle de la derniere occurrence, pas de la premiere.
  assert.match(journal.lines()[0], /^21:14:02/);
  cleanup();
});

test("garde les dernieres lignes et laisse partir les plus anciennes", () => {
  const { journal, cleanup } = makeJournal({ capacity: 3 });

  for (const index of [1, 2, 3, 4, 5]) {
    journal.record("sante", `passage ${index}`);
  }

  assert.equal(journal.lines().length, 3);
  assert.match(journal.lines()[0], /passage 3$/);
  assert.match(journal.lines()[2], /passage 5$/);
  cleanup();
});

// L'onglet du device montre la ligne la plus recente en haut : c'est l'inverse du fichier.
test("rend les lignes du device de la plus recente a la plus ancienne", () => {
  const { journal, cleanup } = makeJournal();

  journal.record("config", "premiere");
  journal.record("config", "seconde");

  const rows: string[] = journal.recent(4);

  assert.equal(rows.length, 4);
  assert.match(rows[0], /seconde$/);
  assert.match(rows[1], /premiere$/);
  // Les places sans ligne portent un espace, jamais un symbole vide.
  assert.deepEqual(rows.slice(2), [" ", " "]);
  cleanup();
});

// Trois passages n'aiment pas les accents : un symbole Max, `clip` sous Windows, et un fichier
// ouvert dans le Bloc-notes. Une lettre accentuee doit perdre son accent, pas devenir illisible.
test("ramene les accents et les retours a la ligne a de l'ASCII sur une ligne", () => {
  assert.equal(plain("Arrêté"), "Arrete");
  assert.equal(plain("deux\nlignes\tet   des espaces"), "deux lignes et des espaces");
  assert.equal(plain("flèche →"), "fleche ?");
});

test("coupe une ligne trop longue", () => {
  const { journal, cleanup } = makeJournal();

  journal.record("relais", "x".repeat(500));

  // L'heure, un espace, la categorie sur neuf colonnes, un espace, puis le message plafonne.
  assert.equal(journal.lines()[0].length, 8 + 1 + 9 + 1 + 160);
  cleanup();
});

test("previent a chaque ligne ecrite", () => {
  let changes = 0;
  const { journal, cleanup } = makeJournal({ onChange: () => (changes += 1) });

  journal.record("direct", "une");
  journal.record("direct", "une");
  journal.clear();

  // Une repetition compte : l'affichage doit montrer le compteur qui avance.
  assert.equal(changes, 3);
  assert.deepEqual(journal.lines(), []);
  cleanup();
});

test("copie le journal complet, en-tete comprise", async () => {
  const { journal, copied, cleanup } = makeJournal({ context: () => ["v0.1.0 build 12"] });

  journal.record("demarrage", "device pret");
  await journal.copy();

  assert.equal(copied.length, 1);
  assert.match(copied[0], /Vassi Stream - journal du device/);
  assert.match(copied[0], /v0\.1\.0 build 12/);
  assert.match(copied[0], /1 ligne\(s\)/);
  assert.match(copied[0], /device pret/);
  cleanup();
});

test("ecrit un fichier date et rend son chemin", () => {
  const { journal, folder, cleanup } = makeJournal();

  journal.record("demarrage", "device pret");
  const file: string = journal.save();

  assert.equal(file, join(folder, "journal-20260810-211401.log"));
  assert.match(readFileSync(file, "utf8"), /device pret/);
  cleanup();
});
