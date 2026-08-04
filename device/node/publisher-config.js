"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Ce nom de dossier est le meme sur les trois systemes : il reste lisible pour Vassi.
const CONFIG_DIRECTORY_NAME = "Vassi Stream";
const CONFIG_FILE_NAME = "publisher.json";

// Ces hotes acceptent une connexion en clair : le token ne quitte alors jamais la machine.
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

// Cette fonction donne le chemin du fichier de configuration du publisher.
// La variable d'environnement sert aux tests et a un emplacement choisi a la main.
// Le dossier par defaut vit hors du projet : il survit au gel du device et a un deplacement
// du dossier de travail, et il ne peut pas etre commite par accident.
function configPath() {
	if (typeof process.env.VASSI_PUBLISHER_CONFIG === "string" && process.env.VASSI_PUBLISHER_CONFIG !== "") {
		return process.env.VASSI_PUBLISHER_CONFIG;
	}

	if (process.platform === "win32" && typeof process.env.APPDATA === "string" && process.env.APPDATA !== "") {
		return path.join(process.env.APPDATA, CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
	}

	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
	}

	return path.join(os.homedir(), ".config", "vassi-stream", CONFIG_FILE_NAME);
}

// Cette fonction lit la configuration et refuse tout contenu inutilisable.
// Elle ne renvoie jamais le token dans un message d'erreur : les erreurs sont des codes courts.
function readConfig() {
	const file = configPath();
	let text = "";

	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") {
			throw new Error("config_absente");
		}
		throw new Error("config_illisible");
	}

	let values = null;
	try {
		values = JSON.parse(text);
	} catch (error) {
		throw new Error("config_json_invalide");
	}

	if (values === null || typeof values !== "object" || Array.isArray(values)) {
		throw new Error("config_json_invalide");
	}

	return {
		relayUrl: checkedRelayUrl(values.relayUrl),
		publisherToken: normalizeToken(checkedToken(values.publisherToken))
	};
}

// Cette fonction ecrit la configuration et cree le dossier si besoin.
// Elle est utilisee par le script de configuration et, au bloc 10, par le device lui-meme.
// Le fichier contient le token de publication : il est reserve au compte qui l'ecrit. Les droits
// sont poses apres l'ecriture, parce que le mode d'ouverture ne s'applique qu'a une creation et
// laisserait un fichier deja existant lisible par les autres comptes de la machine.
function writeConfig(values) {
	const file = configPath();
	const content = {
		relayUrl: checkedRelayUrl(values.relayUrl),
		publisherToken: normalizeToken(checkedToken(values.publisherToken))
	};

	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(content, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	restrictToOwner(file);
	return file;
}

// Cette fonction enregistre une correction venue du device : deux textes, dont l'un ou l'autre
// peut etre vide. Un champ vide garde la valeur deja enregistree, parce que corriger l'adresse ne
// doit pas obliger a recoller le token, et l'inverse.
//
// La fusion vit ici, avec le reste de ce qui touche au token. Le panneau de reglages ne connait
// ainsi ni le nom des champs du fichier, ni la valeur du token deja en place : il ne fait que
// transmettre ce qui vient d'etre tape.
function updateConfig({ relayUrl = "", token = "" }) {
	let current = { relayUrl: "", publisherToken: "" };

	try {
		current = readConfig();
	} catch (error) {
		// Le premier enregistrement n'a rien a completer : les deux champs doivent alors etre
		// remplis, et `writeConfig` dira lequel manque.
	}

	return writeConfig({
		relayUrl: relayUrl !== "" ? relayUrl : current.relayUrl,
		publisherToken: token !== "" ? token : current.publisherToken
	});
}

// Cette fonction reserve le fichier a son proprietaire. Windows ignore ces droits POSIX : la
// protection y vient deja de `%APPDATA%`, propre a chaque compte.
function restrictToOwner(file) {
	if (process.platform === "win32") {
		return;
	}

	try {
		fs.chmodSync(file, 0o600);
	} catch (error) {
		// Un systeme de fichiers sans droits POSIX ne doit pas empecher d'enregistrer la config.
	}
}

// Cette fonction decrit la configuration sans jamais exposer le token.
// Elle sert a l'affichage dans Max et aux messages de diagnostic.
function describeConfig() {
	try {
		const config = readConfig();
		return {
			ready: true,
			relayUrl: config.relayUrl,
			tokenHint: tokenHint(config.publisherToken),
			detail: "configuration lue"
		};
	} catch (error) {
		return { ready: false, relayUrl: "", tokenHint: "", detail: error.message };
	}
}

// Cette fonction reduit un token a ses quatre derniers caracteres.
// C'est assez pour reconnaitre le bon token apres un collage, et trop peu pour le reconstituer.
// Un token trop court pour cet indice n'en recoit aucun : il vaut mieux ne rien montrer que
// montrer presque tout.
function tokenHint(token) {
	if (typeof token !== "string" || token.length < 8) {
		return "";
	}

	return token.slice(-4);
}

// Cette fonction accepte une adresse chiffree partout, et une adresse en clair seulement en local.
// Un `ws://` distant transporterait le token de publication en clair sur le reseau.
function checkedRelayUrl(value) {
	if (typeof value !== "string" || value === "") {
		throw new Error("config_url_absente");
	}

	let parsed = null;
	try {
		parsed = new URL(value);
	} catch (error) {
		throw new Error("config_url_invalide");
	}

	if (parsed.protocol === "wss:") {
		return value;
	}

	if (parsed.protocol === "ws:" && LOCAL_HOSTS.includes(parsed.hostname)) {
		return value;
	}

	throw new Error("config_url_non_chiffree");
}

// Cette fonction verifie la presence d'un token utilisable sans en decrire le contenu.
function checkedToken(value) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error("config_token_absent");
	}

	return value;
}

function normalizeToken(value) {
	return value.trim();
}

module.exports = { configPath, readConfig, writeConfig, updateConfig, describeConfig };
