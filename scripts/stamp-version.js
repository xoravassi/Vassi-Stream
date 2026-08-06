// Ce script grave la version du projet dans `device/node/version.json`, que le device lit au
// demarrage pour l'afficher.
//
// La version repond a une seule question : ce qui tourne dans Ableton est-il bien ce qui vient
// d'etre ecrit. Elle doit donc changer a chaque modification, sans que personne ait a y penser.
// Trois valeurs y suffisent, et aucune n'est saisie a la main :
//
//   `numero`  le nombre de commits du depot, qui augmente de un a chaque modification enregistree ;
//   `commit`  les sept premiers caracteres du commit, qui identifient exactement le code installe ;
//   `etat`    la marque des modifications non commitees, parce qu'un device installe depuis un
//             dossier modifie ne correspond a aucun commit.
//
// Le fichier produit part avec `device/node/` a l'installation : le device le lit donc dans la
// bibliotheque de Max, sans jamais avoir besoin de git.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "device", "node", "version.json");

// Cette fonction lance une commande git et rend sa sortie, ou une chaine vide si git ne repond pas.
// Un depot absent ne doit pas empecher de fabriquer le device.
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Cette fonction rend la version complete, telle que le device l'affiche.
export function readVersion() {
  const paquet = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const numero = git("rev-list", "--count", "HEAD");
  const commit = git("rev-parse", "--short=7", "HEAD");
  const modifie = git("status", "--porcelain") !== "";

  return {
    version: paquet.version,
    numero: numero === "" ? 0 : Number(numero),
    commit: commit === "" ? "inconnu" : commit,
    etat: modifie ? "modifie" : "propre",
  };
}

// Cette fonction rend la ligne affichee dans le device.
//
// Le numero de build suffit a identifier un commit : il vaut le nombre de commits du depot, donc il
// augmente de un a chacun. Le commit lui-meme reste dans le fichier, ou une demande de support ira
// le chercher ; l'afficher couterait la moitie de la ligne d'etat de l'encodeur, qui la partage.
//
// Le suffixe n'apparait que sur un dossier modifie, et c'est la seule information que le numero ne
// porte pas : un device installe depuis un dossier modifie ne correspond a aucun commit.
export function formatVersion(version) {
  const suffixe = version.etat === "propre" ? "" : "+";

  return `v${version.version} · build ${version.numero}${suffixe}`;
}

const version = readVersion();
writeFileSync(TARGET, `${JSON.stringify(version, null, 2)}\n`);
console.log(`Version gravee : ${formatVersion(version)}`);
