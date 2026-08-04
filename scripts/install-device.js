// Ce script installe le device du bloc 10 la ou Ableton et Max vont le chercher.
// Apres son passage, il ne reste qu'a lancer Ableton et deposer le device sur la piste Master.
//
// Usage : npm.cmd run device:install
//
// Le device n'est pas gele : il lance `node/index.js` par un chemin relatif a lui-meme. Le dossier
// `device/node/` doit donc etre copie a cote du `.amxd`, sans quoi le device s'ouvre mais ne parle
// a rien. C'est la raison du sous-dossier « Vassi Stream » : un `.amxd` pose seul dans le dossier
// des devices ne trouverait pas son script. Le gel du device, au bloc 11, supprimera ce besoin.
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from "node:fs";
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

const MAX_LIBRARY = join(HOME, "Documents", "Max 8", "Library", "Vassi Stream", "externals");
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
			cpSync(NODE_SOURCE, join(LIVE_DEVICES, "node"), { recursive: true });
			record(true, `node/ copie dans ${LIVE_DEVICES}`);
		} catch (error) {
			record(false, `node/ non copie : ${error.message}. Fermer Ableton Live et Max puis relancer.`);
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
	console.log("Le device installe est une copie. Une retouche faite dans Max sur cette copie ne");
	console.log("revient pas dans le depot : la rapporter dans patchers/vassi-stream.maxpat.");
} else {
	console.log(`${blocked.length} etape(s) a corriger avant l'essai.`);
	process.exitCode = 1;
}
