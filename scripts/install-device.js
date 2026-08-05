// Ce script installe le device du bloc 10 la ou Ableton et Max vont le chercher.
// Apres son passage, il ne reste qu'a lancer Ableton et deposer le device sur la piste Master.
//
// Usage : npm.cmd run device:install
//
// Le device n'est pas gele : il demande son script Node par son seul nom de fichier, et c'est Max
// qui doit le retrouver. Or Max n'indexe pas la bibliotheque d'Ableton — pas un fichier de
// `Documents\Ableton\User Library` n'entre dans sa base de recherche. Poser le dossier `node/` a
// cote du `.amxd` ne servait donc a rien : le script restait invisible et ne demarrait jamais.
//
// Les deux morceaux vont a deux endroits : le `.amxd` dans la bibliotheque d'Ableton, qui le montre
// dans son navigateur, et le dossier `node/` dans la bibliotheque de Max, que Max indexe. C'est
// deja par la que `vassi.encoder~` est trouve. Le gel du device, au bloc 11, emportera le script
// dans le `.amxd` et supprimera ce second depot.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE ?? "";

const EXTERNAL_NAME = "vassi.encoder~.mxe64";
const DEVICE_NAME = "Vassi Stream.amxd";

const DEVICE = join(ROOT, "device", DEVICE_NAME);
const MAXPAT = join(ROOT, "patchers", "vassi-stream.maxpat");
const NODE_SOURCE = join(ROOT, "device", "node");
const EXTERNAL = join(ROOT, "externals", EXTERNAL_NAME);

// La bibliotheque de Max : le seul des deux dossiers que Max indexe, donc le seul ou il retrouve
// un fichier demande par son nom.
const MAX_PACKAGE = join(HOME, "Documents", "Max 8", "Library", "Vassi Stream");
const MAX_LIBRARY = join(MAX_PACKAGE, "externals");
const MAX_NODE = join(MAX_PACKAGE, "node");
// Ce dossier est celui que Live montre sous Categories > Audio Effects > Max Audio Effect.
const LIVE_DEVICES = join(HOME, "Documents", "Ableton", "User Library", "Presets", "Audio Effects", "Max Audio Effect", "Vassi Stream");

const steps = [];

// Cette fonction enregistre le resultat d'une etape pour le rapport final.
function record(ok, message) {
	steps.push({ ok, message });
	console.log(`${ok ? "OK  " : "STOP"} ${message}`);
}

// Cette fonction copie un fichier et explique le blocage le plus courant : un logiciel ouvert.
function copyInto(source, targetDirectory, targetName) {
	const target = join(targetDirectory, targetName);
	try {
		mkdirSync(targetDirectory, { recursive: true });
		copyFileSync(source, target);
		record(true, `${targetName} copie dans ${targetDirectory}`);
	} catch (error) {
		record(false, `${targetName} non copie : ${error.message}. Fermer Ableton Live et Max puis relancer.`);
	}
}

if (!existsSync(DEVICE)) {
	record(false, `Device introuvable : lancer d'abord npm.cmd run device:build.`);
} else {
	// Le .amxd est fabrique a partir du .maxpat. Un .maxpat plus recent signale une retouche faite
	// dans Max qui n'a pas ete rebattue dans le device : l'installer irait poser l'ancienne version.
	if (existsSync(MAXPAT) && statSync(MAXPAT).mtime > statSync(DEVICE).mtime) {
		record(false, "Le patcher est plus recent que le device : lancer npm.cmd run device:build avant d'installer.");
	} else {
		copyInto(DEVICE, LIVE_DEVICES, DEVICE_NAME);
		try {
			// `node_modules` part avec le reste : le script Node a besoin de `ws` pour joindre le relais.
			cpSync(NODE_SOURCE, MAX_NODE, { recursive: true });
			record(true, `node/ copie dans ${MAX_NODE}`);
		} catch (error) {
			record(false, `node/ non copie : ${error.message}. Fermer Ableton Live et Max puis relancer.`);
		}

		// Les versions precedentes posaient le script a cote du `.amxd`, ou Max ne le trouvait pas.
		// Cette copie morte est effacee : deux exemplaires du meme script, dont un que rien ne lit,
		// est la meilleure facon de corriger un fichier sans effet.
		const stale = join(LIVE_DEVICES, "node");
		if (existsSync(stale)) {
			try {
				rmSync(stale, { recursive: true, force: true });
				record(true, `ancienne copie de node/ effacee dans ${LIVE_DEVICES}`);
			} catch (error) {
				record(false, `ancienne copie de node/ non effacee : ${error.message}.`);
			}
		}
	}
}

if (existsSync(EXTERNAL)) {
	// Max verrouille l'external tant qu'il est charge. Le recopier echouerait alors qu'il est deja
	// a jour : la version installee est comparee d'abord, et seule une version differente bloque.
	const installed = join(MAX_LIBRARY, EXTERNAL_NAME);
	if (existsSync(installed) && statSync(installed).size === statSync(EXTERNAL).size && statSync(installed).mtime >= statSync(EXTERNAL).mtime) {
		record(true, `${EXTERNAL_NAME} deja installe dans ${MAX_LIBRARY}`);
	} else {
		copyInto(EXTERNAL, MAX_LIBRARY, EXTERNAL_NAME);
	}
} else {
	record(false, "External introuvable : lancer d'abord npm.cmd run build:external.");
}

const blocked = steps.filter((step) => !step.ok);

console.log("");
if (blocked.length === 0) {
	console.log("Tout est en place. Dans Ableton Live :");
	console.log("  1. Categories > Audio Effects > Max Audio Effect > Vassi Stream");
	console.log(`  2. Deposer "${DEVICE_NAME}" sur la piste Master.`);
	console.log("  3. Cliquer sur Reglages, coller l'adresse et le token, puis Enregistrer.");
	console.log("");
	console.log("Max ne relit sa bibliotheque qu'au demarrage : si Live tournait pendant cette");
	console.log("installation, le fermer et le rouvrir avant de reposer le device.");
	console.log("");
	console.log("Le device installe est une copie. Une retouche faite dans Max sur cette copie ne");
	console.log("revient pas dans le depot : la rapporter dans patchers/vassi-stream.maxpat.");
} else {
	console.log(`${blocked.length} etape(s) a corriger avant l'essai.`);
	process.exitCode = 1;
}
