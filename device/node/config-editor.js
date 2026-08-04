"use strict";

const { updateConfig, describeConfig, configPath } = require("./publisher-config.js");

// Ce module tient les deux champs de reglage du device : l'adresse du relais et le token.
//
// Il existe pour une raison precise, ecrite dans la roadmap : installer le systeme sur un nouvel
// ordinateur ne doit pas demander d'ouvrir un terminal. Vassi pose le device, colle deux valeurs,
// clique sur Enregistrer.
//
// Le token ne repart jamais vers Max. Il entre par `setToken`, il est transmis a `updateConfig`
// qui l'ecrit sur la machine, puis il est efface du brouillon. Ce que le device affiche n'est
// jamais que ses quatre derniers caracteres, rendus par `describeConfig`.
//
// Ce module ne lit jamais le token deja enregistre et ne connait pas la forme du fichier de
// configuration : tout ce qui touche a la valeur du token reste dans `publisher-config.js`.

// Ces phrases traduisent les codes courts de `publisher-config.js` en une ligne affichable dans
// le device. Le code reste la valeur de reference pour les tests et les journaux ; la phrase ne
// sert qu'a l'affichage, et elle dit quoi faire plutot que ce qui a echoue.
const REASONS = {
	config_absente: "aucune configuration : collez l'adresse et le token",
	config_illisible: "fichier de configuration illisible",
	config_json_invalide: "fichier de configuration abime : reenregistrez",
	config_url_absente: "adresse du relais manquante",
	config_url_invalide: "adresse du relais illisible",
	config_url_non_chiffree: "adresse refusee : wss:// est obligatoire hors de la machine",
	config_token_absent: "token manquant"
};

// Cette fonction rend la phrase correspondant a un code, ou une phrase par defaut.
function reasonInFrench(code) {
	return REASONS[code] ?? "configuration inutilisable";
}

// Cette classe accumule ce qui est tape dans le device, puis l'enregistre sur demande.
class ConfigEditor {
	constructor(handlers = {}) {
		// Ces deux fonctions sont remplacables par les tests, qui ne veulent pas ecrire dans
		// le dossier de configuration reel de la machine.
		this.save = handlers.save ?? updateConfig;
		this.describe = handlers.describe ?? describeConfig;
		this.draft = { relayUrl: "", token: "" };
	}

	// Cette methode retient l'adresse tapee. Max coupe un symbole sur ses espaces : les morceaux
	// sont recolles avant tout examen, sinon une adresse collee avec un espace parasite arriverait
	// tronquee et l'erreur affichee ne correspondrait pas a ce qui est visible a l'ecran.
	setRelayUrl(...parts) {
		this.draft.relayUrl = joinParts(parts);
	}

	// Cette methode retient le token tape. Il reste dans le brouillon jusqu'a l'enregistrement.
	setToken(...parts) {
		this.draft.token = joinParts(parts);
	}

	// Cette methode decrit ce que le device doit afficher : configuration lue ou non, adresse
	// enregistree, indice du token, et raison courte en cas de probleme.
	status() {
		return this.describe();
	}

	// Cette methode rend la ligne unique affichee par le device. La phrase est construite ici,
	// pres des valeurs, plutot que dans le patcher Max : assembler du texte avec des objets Max
	// demande une dizaine de boites pour un resultat moins lisible et plus fragile.
	deviceStatus() {
		const description = this.describe();

		if (!description.ready) {
			return { ready: false, relayUrl: "", text: reasonInFrench(description.detail) };
		}

		const hint = description.tokenHint === "" ? "token trop court" : `token ...${description.tokenHint}`;
		return { ready: true, relayUrl: description.relayUrl, text: `${description.relayUrl} - ${hint}` };
	}

	// Cette methode enregistre le brouillon. Un champ laisse vide garde la valeur deja
	// enregistree : corriger l'adresse ne doit pas obliger a recoller le token, et l'inverse.
	//
	// Elle ne rejette jamais et ne renvoie jamais le token : le device recoit un etat et une
	// raison courte, comme partout ailleurs dans le projet.
	apply() {
		let file = "";
		try {
			file = this.save({ ...this.draft });
		} catch (error) {
			return { ok: false, code: error.message, text: reasonInFrench(error.message), file: "" };
		}

		// Le brouillon est efface des qu'il est enregistre : le token n'a plus aucune raison de
		// rester en memoire, et le champ du device est vide au meme moment.
		this.draft.token = "";
		this.draft.relayUrl = "";

		return { ok: true, code: "", text: "configuration enregistree", file };
	}
}

// Cette fonction recolle les morceaux d'un symbole et enleve les espaces de bordure.
// Un token colle depuis un gestionnaire de mots de passe en emporte souvent.
function joinParts(parts) {
	return parts
		.map((part) => String(part))
		.join(" ")
		.trim();
}

module.exports = { ConfigEditor, reasonInFrench, configPath };
