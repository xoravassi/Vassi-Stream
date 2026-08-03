// Ce script installe tout ce qu'Ableton doit trouver pour le test manuel du bloc 5.
// Apres son passage, il ne reste qu'a lancer Ableton et deposer le device sur le Master.
// Usage : node scripts/prepare-ableton-test.js
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestDevice } from "./build-test-device.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE ?? "";

const EXTERNAL_NAME = "vassi.encoder~.mxe64";
const DEVICE_NAME = "Vassi Stream - Test pont.amxd";
const SAMPLE_NAME = "vassi-stereo-test-48k-24bit.wav";

const MAXPAT = join(ROOT, "patchers", "vassi.encoder.bridge-test.maxpat");
const AMXD = join(ROOT, "patchers", "vassi.encoder.bridge-test.amxd");
const ARTIFACT = join(ROOT, ".local", "artifacts", EXTERNAL_NAME);
const SAMPLE = join(ROOT, "assets", "audio", SAMPLE_NAME);

const MAX_LIBRARY = join(HOME, "Documents", "Max 8", "Library", "Vassi Stream", "externals");
const LIVE_DEVICES = join(HOME, "Documents", "Ableton", "User Library", "Presets", "Audio Effects", "Max Audio Effect");
const LIVE_SAMPLES = join(HOME, "Documents", "Ableton", "User Library", "Samples", "Vassi Stream");

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

if (!existsSync(ARTIFACT)) {
	record(false, "External introuvable : lancer d'abord npm run build:external.");
} else {
	const built = new Date(statSync(ARTIFACT).mtime).toLocaleString();
	record(true, `External compile le ${built}`);
	copyInto(ARTIFACT, join(ROOT, "externals"), EXTERNAL_NAME);
	copyInto(ARTIFACT, MAX_LIBRARY, EXTERNAL_NAME);
}

const deviceBytes = buildTestDevice(MAXPAT, AMXD);
record(true, `Device construit : ${AMXD} (${deviceBytes} octets)`);
copyInto(AMXD, LIVE_DEVICES, DEVICE_NAME);

if (existsSync(SAMPLE)) {
	copyInto(SAMPLE, LIVE_SAMPLES, SAMPLE_NAME);
} else {
	record(false, `Fichier audio de test introuvable : ${SAMPLE}`);
}

const blocked = steps.filter((step) => !step.ok);

console.log("");
if (blocked.length === 0) {
	console.log("Tout est en place. Dans Ableton Live :");
	console.log("  1. Categories > User Library > Presets > Audio Effects > Max Audio Effect");
	console.log(`  2. Deposer "${DEVICE_NAME}" sur la piste Master.`);
	console.log("  3. Places > User Library > Samples > Vassi Stream : deposer le wav sur une piste audio.");
	console.log("  4. Lancer la lecture et lire les compteurs sur le device.");
} else {
	console.log(`${blocked.length} etape(s) a corriger avant le test.`);
	process.exitCode = 1;
}
