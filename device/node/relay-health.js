"use strict";

const http = require("http");
const https = require("https");

// Ce module repond a une seule question, posee par le device : « le relais repond-il ? »
//
// Il interroge la route publique `/health`, jamais le chemin publisher. Aucun token n'entre donc
// dans cette verification : une erreur de collage se voit sans qu'un secret circule.
//
// Node for Max fournit Node 16, ou `fetch` n'existe pas encore : la requete passe par les modules
// `http` et `https` integres, disponibles dans toutes les versions.

// Au-dela de ce delai, un relais qui ne repond pas est declare injoignable. Cinq secondes suffisent
// a une reponse venue de l'autre bout du monde, et laissent l'affichage du device reactif.
const CHECK_TIMEOUT_MS = 5000;
// La route de sante rend un petit objet JSON. Une reponse plus grande vient d'autre chose : d'un
// portail Wi-Fi, d'une page d'erreur de l'hebergeur, ou d'une adresse qui n'est pas le relais.
const MAX_BODY_BYTES = 4096;

// Cette fonction transforme l'adresse WebSocket du publisher en adresse de la route de sante.
// `wss://` devient `https://`, `ws://` devient `http://`, et le chemin est remplace par `/health`.
function healthUrlFrom(relayUrl) {
	const parsed = new URL(relayUrl);
	const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
	return `${secure ? "https" : "http"}://${parsed.host}/health`;
}

// Cette fonction interroge le relais et decrit le resultat en une phrase courte.
// Elle ne rejette jamais : le device affiche toujours quelque chose de lisible.
function checkRelay(relayUrl, options = {}) {
	const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;

	let target = "";
	try {
		target = healthUrlFrom(relayUrl);
	} catch (error) {
		return Promise.resolve({ ok: false, detail: "adresse du relais illisible" });
	}

	return new Promise((resolve) => {
		// Chaque chemin de sortie passe par cette fonction : le premier resultat gagne, et les
		// evenements qui arrivent ensuite ne peuvent plus rien changer. Une requete HTTP peut
		// signaler une erreur apres avoir deja rendu une reponse.
		let settled = false;
		const finish = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
		};

		const client = target.startsWith("https://") ? https : http;
		let request = null;

		try {
			request = client.get(target, { timeout: timeoutMs }, (response) => {
				readAnswer(response, finish);
			});
		} catch (error) {
			finish({ ok: false, detail: "requete impossible" });
			return;
		}

		request.on("timeout", () => {
			request.destroy();
			finish({ ok: false, detail: "aucune reponse en cinq secondes" });
		});

		request.on("error", (error) => {
			finish({ ok: false, detail: networkReason(error) });
		});
	});
}

// Cette fonction lit la reponse et juge si elle vient bien du relais.
// Le corps est borne : une adresse qui rend une grande page n'est pas le relais, et le device ne
// doit pas garder cette page en memoire pour s'en apercevoir.
function readAnswer(response, finish) {
	if (response.statusCode !== 200) {
		response.resume();
		finish({ ok: false, detail: `le serveur repond ${response.statusCode}` });
		return;
	}

	let body = "";
	let tooLarge = false;

	response.setEncoding("utf8");
	response.on("data", (chunk) => {
		if (body.length + chunk.length > MAX_BODY_BYTES) {
			tooLarge = true;
			response.destroy();
			return;
		}
		body += chunk;
	});

	response.on("end", () => {
		finish(describeHealth(body));
	});

	// Ces deux evenements couvrent une reponse qui s'arrete avant sa fin, dont celle que la limite
	// de taille coupe elle-meme. `close` arrive toujours, y compris apres `end` : le premier
	// resultat gagne, donc une reponse complete garde le sien. `aborted` est deprecie dans Node et
	// destine a disparaitre ; sans `close` a cote, sa disparition laisserait la promesse sans
	// reponse et le device afficherait « verification en cours » pour toujours.
	const interrupted = () => {
		finish({ ok: false, detail: tooLarge ? "cette adresse n'est pas le relais" : "reponse interrompue" });
	};

	response.on("aborted", interrupted);
	response.on("close", interrupted);
}

// Cette fonction lit le corps de la route de sante et le resume pour l'affichage du device.
function describeHealth(body) {
	let values = null;

	try {
		values = JSON.parse(body);
	} catch (error) {
		return { ok: false, detail: "cette adresse n'est pas le relais" };
	}

	if (values === null || typeof values !== "object" || values.status !== "ok") {
		return { ok: false, detail: "cette adresse n'est pas le relais" };
	}

	const listeners = typeof values.listeners === "number" ? values.listeners : 0;
	const busy = values.live === true ? ", deja en direct" : "";
	return { ok: true, detail: `relais joignable, ${listeners} auditeur(s)${busy}` };
}

// Cette fonction traduit une panne reseau en phrase comprehensible sans jargon systeme.
function networkReason(error) {
	const code = typeof error?.code === "string" ? error.code : "";

	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return "adresse introuvable";
	}

	if (code === "ECONNREFUSED") {
		return "connexion refusee";
	}

	if (code.startsWith("CERT_") || code.startsWith("ERR_TLS") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
		return "certificat refuse";
	}

	return "relais injoignable";
}

module.exports = { checkRelay, healthUrlFrom, CHECK_TIMEOUT_MS };
