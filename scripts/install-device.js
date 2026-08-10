// Ce script installe le device la ou Ableton et Max vont le chercher. Apres son passage, il ne
// reste qu'a lancer Ableton et deposer le device sur la piste Master.
//
// Usage : npm.cmd run device:install
//
// Le device n'est pas gele : il demande son script Node et son external par leur seul nom de
// fichier, et c'est Max qui doit les retrouver. Or Max n'indexe pas la bibliotheque d'Ableton — pas
// un fichier de `Ableton\User Library` n'entre dans sa base de recherche. Poser le dossier `node/` a
// cote du `.amxd` ne sert donc a rien : le script reste invisible et ne demarre jamais.
//
// Les deux morceaux vont a deux endroits : le `.amxd` dans la bibliotheque d'Ableton, qui le montre
// dans son navigateur, et `node/` avec `externals/` dans la bibliotheque de Max, que Max indexe.
// Ces deux emplacements ne se devinent pas : `scripts/install-paths.js` les deduit de l'etat de la
// machine, et explique pourquoi. Le gel du device, au bloc 11, emportera le script dans le `.amxd`
// et supprimera ce second depot.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestDevice } from "./build-test-device.js";
import { resolveTargets } from "./install-paths.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXTERNAL_NAME = "vassi.encoder~.mxe64";
const DEVICE_NAME = "Vassi Stream.amxd";

const DEVICE = join(ROOT, "device", DEVICE_NAME);
const MAXPAT = join(ROOT, "patchers", "vassi-stream.maxpat");
const NODE_SOURCE = join(ROOT, "device", "node");
const EXTERNAL = join(ROOT, "externals", EXTERNAL_NAME);

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

// Cette fonction lance npm dans `device/node`.
//
// Elle ne l'appelle pas par son nom : depuis Node 20, Windows refuse de lancer un `.cmd` sans passer
// par un shell — la protection contre l'injection d'arguments de CVE-2024-27980 — et l'appel echoue
// sur un `EINVAL` qui ne dit rien. Le script `npm-cli.js` livre avec Node est un fichier JavaScript
// ordinaire : le lancer avec le Node courant evite le shell, donc evite aussi la question du
// guillemet. Le passage par le shell ne reste que pour une installation de Node sans ce fichier.
function runNpm(args) {
	const options = { cwd: NODE_SOURCE, stdio: "inherit" };
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

	if (existsSync(npmCli)) {
		execFileSync(process.execPath, [npmCli, ...args], options);
		return;
	}

	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { ...options, shell: true });
}

// Cette fonction installe les dependances du script Node si elles manquent.
//
// Le publisher demande `ws` pour joindre le relais. Sans ce dossier, le device se charge, s'affiche,
// et echoue en silence a la premiere connexion : `node_modules` est ignore par git, donc un depot
// fraichement clone n'en a jamais. L'installer ici evite d'avoir a le savoir.
function ensureDependencies() {
	if (existsSync(join(NODE_SOURCE, "node_modules", "ws"))) {
		return true;
	}

	try {
		record(true, "dependance ws absente : installation avec npm");
		runNpm(["install", "--omit=dev", "--no-audit", "--no-fund"]);
	} catch (error) {
		record(false, `ws non installe : ${error.message}. Lancer npm.cmd install dans device/node.`);
		return false;
	}

	if (!existsSync(join(NODE_SOURCE, "node_modules", "ws"))) {
		record(false, "ws toujours absent apres npm install : le device ne pourra pas joindre le relais.");
		return false;
	}

	return true;
}

// La version est gravee ici, et pas seulement par le crochet npm `predevice:install` : ce script est
// aussi lance directement, par `install-device.ps1` ou a la main. Sans cette ligne, `version.json`
// manque dans la copie installee et le device ne sait pas dire ce qu'il fait tourner.
try {
	execFileSync(process.execPath, [join(ROOT, "scripts", "stamp-version.js")], { stdio: "inherit" });
} catch (error) {
	record(false, `version non gravee : ${error.message}`);
}

const targets = resolveTargets();

console.log("");
console.log(`Documents du compte : ${targets.documents}`);
if (targets.installs.length === 0) {
	record(false, "aucun Ableton Live trouve dans %ProgramData%\\Ableton : les emplacements sont devines.");
}
for (const install of targets.installs) {
	console.log(`     ${install.name} — Live ${install.version}, Max ${install.maxVersion || "inconnu"}`);
}
console.log("");

if (targets.maxPackages.length === 0) {
	record(false, "version de Max introuvable : impossible de savoir quelle bibliotheque Max servir.");
}

// Le `.amxd` n'est que le `.maxpat` dans un conteneur. Un patcher plus recent signale une retouche
// faite dans Max qui n'est pas encore dans le device : l'installer tel quel poserait l'ancienne
// version. Le conteneur est donc refait ici, a partir du patcher.
//
// C'est bien le patcher qui sert de source, et non `make-device.js` : ce dernier regenere le patcher
// depuis le code, donc il effacerait justement la retouche qu'on vient de detecter.
if (existsSync(MAXPAT) && (!existsSync(DEVICE) || statSync(MAXPAT).mtime > statSync(DEVICE).mtime)) {
	try {
		const size = buildTestDevice(MAXPAT, DEVICE);
		record(true, `device refait depuis le patcher retouche (${size} octets)`);
	} catch (error) {
		record(false, `device non refait : ${error.message}`);
	}
}

if (!existsSync(DEVICE)) {
	record(false, "Device introuvable : lancer d'abord npm.cmd run device:build.");
} else if (ensureDependencies()) {
	copyInto(DEVICE, targets.liveDevices, DEVICE_NAME);

	// Chaque version de Max utilisee par un Ableton installe recoit sa copie : Max 9 ne lit pas la
	// bibliotheque de Max 8, et l'inverse non plus.
	for (const paquet of targets.maxPackages) {
		const target = join(paquet.folder, "node");
		try {
			// Le dossier est vide avant la copie : une copie par-dessus laisserait vivre un fichier
			// supprime du projet, et Max le trouverait toujours par son nom.
			rmSync(target, { recursive: true, force: true });
			// `node_modules` part avec le reste : le script Node a besoin de `ws` pour joindre le relais.
			cpSync(NODE_SOURCE, target, { recursive: true });
			record(true, `node/ copie dans ${target}`);
		} catch (error) {
			record(false, `node/ non copie : ${error.message}. Fermer Ableton Live et Max puis relancer.`);
		}

		if (!existsSync(EXTERNAL)) {
			record(false, "External introuvable : lancer d'abord npm.cmd run build:external.");
			continue;
		}

		// Max verrouille l'external tant qu'il est charge. Le recopier echouerait alors qu'il est deja
		// a jour : la version installee est comparee d'abord, et seule une version differente bloque.
		const externals = join(paquet.folder, "externals");
		const installed = join(externals, EXTERNAL_NAME);
		if (
			existsSync(installed) &&
			statSync(installed).size === statSync(EXTERNAL).size &&
			statSync(installed).mtime >= statSync(EXTERNAL).mtime
		) {
			record(true, `${EXTERNAL_NAME} deja installe dans ${externals}`);
		} else {
			copyInto(EXTERNAL, externals, EXTERNAL_NAME);
		}
	}
}

// Les depots laisses par une version precedente de l'installateur sont effaces. Ils sont pires
// qu'inutiles : ils donnent a croire que l'installation a reussi alors que rien ne les lit, et une
// correction apportee au projet ne les atteint pas.
for (const folder of targets.stale) {
	try {
		rmSync(folder, { recursive: true, force: true });
		record(true, `depot perime efface : ${folder}`);
	} catch (error) {
		record(false, `depot perime non efface : ${folder} — ${error.message}`);
	}
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
