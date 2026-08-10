// Ce script ecrit l'URL du relais et le token de publication dans la configuration du device.
// Le fichier vit hors du projet : il ne peut donc pas etre commite par accident.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeConfig, updateConfig, configPath, describeConfig } = require("../device/node/publisher-config.js");

// Cette fonction lit les options `--nom valeur` de la ligne de commande.
function readOptions(argv) {
	const options = {};

	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (typeof name === "string" && name.startsWith("--")) {
			options[name.slice(2)] = argv[index + 1] ?? "";
			index += 1;
		}
	}

	return options;
}

// Cette fonction affiche l'aide et les regles de securite du token.
function printUsage() {
	console.log("Usage :");
	console.log("  node scripts/set-publisher-config.js --url wss://relai.exemple/publisher [--token JETON]");
	console.log("");
	console.log("Sans --token, le script lit la variable d'environnement VASSI_PUBLISHER_TOKEN.");
	console.log("Cette seconde forme est preferable : le token n'apparait pas dans l'historique du terminal.");
	console.log("");
	console.log("Sans token d'aucune des deux sources, celui deja enregistre est conserve : corriger");
	console.log("l'adresse du relais n'oblige pas a recoller le token, et ne le change pas par surprise.");
	console.log("");
	console.log(`Fichier ecrit : ${configPath()}`);
}

const options = readOptions(process.argv.slice(2));

if (options.help !== undefined || options.url === undefined) {
	printUsage();
	process.exit(options.url === undefined ? 1 : 0);
}

const token = options.token ?? process.env.VASSI_PUBLISHER_TOKEN ?? "";

try {
	// Sans token fourni, celui deja enregistre est conserve. Le regenerer serait pire qu'inutile :
	// le relais n'accepte que le token qu'il connait, donc changer celui du device par surprise
	// couperait la diffusion, et le nouveau devrait etre repose sur le relais pour rien.
	const file = token === "" ? updateConfig({ relayUrl: options.url }) : writeConfig({ relayUrl: options.url, publisherToken: token });
	const description = describeConfig();
	// Le token n'est jamais reaffiche : seule sa presence est confirmee.
	console.log(`OK   configuration ecrite dans ${file}`);
	console.log(`OK   relais : ${description.relayUrl}`);
	console.log(token === "" ? "OK   token deja enregistre conserve" : "OK   token enregistre");
} catch (error) {
	console.error(`STOP ${error.message}`);
	printUsage();
	process.exit(1);
}
