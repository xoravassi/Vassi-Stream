"use strict";

const Max = require("max-api");
const { FrameBridge } = require("./frame-bridge.js");
const { Publisher } = require("./publisher.js");
const { ConfigEditor } = require("./config-editor.js");
const { checkRelay } = require("./relay-health.js");
const protocol = require("./publisher-protocol.js");

// Ces tableaux traduisent les trois positions des dials du device en valeurs du protocole.
const QUALITY_BITRATES = protocol.ALLOWED_BITRATES;
const LATENCY_PROFILES = protocol.ALLOWED_LATENCY_PROFILES;

// Ce compteur sert uniquement au diagnostic demande par le patch.
const counters = {
	frames: 0,
	bytes: 0,
	discontinuities: 0,
	lastSequence: -1,
	gaps: 0
};

// Ces valeurs restent celles choisies par la roadmap tant que le device n'en envoie pas d'autres.
const selection = {
	bitrate: protocol.DEFAULT_BITRATE,
	latencyProfile: protocol.DEFAULT_LATENCY_PROFILE
};

// Cette fonction verifie la continuite des frames recues sans jamais afficher leur contenu.
function countFrame(frame) {
	counters.frames += 1;
	counters.bytes += frame.payload.length;
	if ((frame.flags & 1) !== 0) {
		counters.discontinuities += 1;
	}
	if (counters.lastSequence >= 0 && frame.sequence !== counters.lastSequence + 1) {
		counters.gaps += 1;
	}
	counters.lastSequence = frame.sequence;
}

// Cette fonction envoie un message a Max sans jamais rejeter.
// `Max.outlet` retourne une promesse qui echoue quand le canal se ferme pendant l'arret du script.
// Une promesse rejetee sans gestionnaire arrete le processus Node : le device perdrait son pont.
function send(...values) {
	Promise.resolve(Max.outlet(...values)).catch(() => {});
}

// Cette fonction publie l'etat du pont loopback, lu par le device depuis le bloc 5.
// Chaque changement d'etat ouvre ou ferme une connexion, et l'encodeur repart alors de la
// sequence zero : le suivi de continuite repart de zero lui aussi pour ne pas compter un faux trou.
function publishBridgeStatus(state, detail) {
	counters.lastSequence = -1;
	send("status", state, detail);
}

// Cet editeur tient les deux champs du panneau de reglages : adresse du relais et token.
const editor = new ConfigEditor();

// Cette fonction publie l'etat de la configuration vers le device.
// Une seule phrase part vers Max : le patcher n'a alors qu'a l'afficher, sans assembler de texte.
//
// L'adresse deja enregistree remplit aussi le champ du panneau de reglages, pour qu'une
// correction parte de ce qui est en place. Le token, lui, n'est jamais renvoye : le champ reste
// vide, et seuls ses quatre derniers caracteres apparaissent dans la phrase.
function publishConfig() {
	const status = editor.deviceStatus();
	send("config", status.text);

	if (status.relayUrl !== "") {
		send("urlfield", status.relayUrl);
	}
}

const publisher = new Publisher({
	// L'etat du relais sort sur un mot different de celui du pont : les deux restent lisibles
	// separement dans le device, et le patch du bloc 5 continue de fonctionner sans modification.
	onState: (state, detail) => send("publisher", state, detail),
	// L'encodeur ne tourne que pendant une session acceptee par le relais. Il recoit deux sortes
	// d'ordres : `start` et `stop`, sans valeur, et `bitrate` suivi du debit a appliquer, que le
	// regulateur revoit pendant tout le direct.
	onEncoder: (action, value) => (value === undefined ? send("encoder", action) : send("encoder", action, value))
});

const bridge = new FrameBridge({
	onFrame: (frame) => {
		countFrame(frame);
		publisher.sendFrame(frame);
	},
	onStatus: publishBridgeStatus
});

// Ce handler lance ou arrete le live. Une valeur nulle arrete, toute autre valeur lance.
Max.addHandler("live", (value) => {
	if (Number(value) === 0) {
		publisher.stop("user_stop");
		return;
	}

	publisher.start(selection);
});

// Ce handler choisit la qualite pour le prochain live : 0 Stable, 1 Haute, 2 Studio.
Max.addHandler("quality", (value) => {
	const bitrate = QUALITY_BITRATES[Number(value)];
	if (bitrate !== undefined) {
		selection.bitrate = bitrate;
	}
	send("selection", selection.bitrate, selection.latencyProfile);
});

// Ce handler choisit la latence pour le prochain live : 0 Faible, 1 Equilibree, 2 Stable.
Max.addHandler("latency", (value) => {
	const profile = LATENCY_PROFILES[Number(value)];
	if (profile !== undefined) {
		selection.latencyProfile = profile;
	}
	send("selection", selection.bitrate, selection.latencyProfile);
});

// Ce handler decrit la configuration du relais sans jamais sortir le token.
// L'indice remplace le token : quatre caracteres suffisent a reconnaitre un collage reussi.
Max.addHandler("config", () => {
	publishConfig();
});

// Ces deux handlers recoivent les champs du panneau de reglages. Rien n'est encore ecrit :
// le token reste dans le brouillon jusqu'au clic sur Enregistrer.
Max.addHandler("relayurl", (...parts) => {
	editor.setRelayUrl(...parts);
});

Max.addHandler("relaytoken", (...parts) => {
	editor.setToken(...parts);
});

// Ce handler enregistre les champs tapes puis reannonce l'etat de la configuration.
// Un champ laisse vide garde sa valeur precedente : corriger l'adresse ne demande pas le token.
//
// L'etat part avant le resultat : le device affiche les deux au meme endroit, et c'est le
// resultat de l'enregistrement qui doit rester visible.
Max.addHandler("saveconfig", () => {
	const result = editor.apply();
	publishConfig();
	send("saved", result.ok ? 1 : 0, result.text);
});

// Ce handler demande au relais s'il repond, par sa route publique de sante.
// La verification n'utilise aucun token : une erreur de collage d'adresse se voit tout de suite,
// sans qu'un secret circule sur le reseau pour la trouver.
Max.addHandler("checkrelay", () => {
	const status = editor.deviceStatus();

	if (!status.ready) {
		send("relay", status.text);
		return;
	}

	send("relay", "verification en cours");
	checkRelay(status.relayUrl).then(
		(result) => send("relay", result.detail),
		() => send("relay", "verification impossible")
	);
});

// Ce handler permet au patch de relire les compteurs a tout moment.
Max.addHandler("stats", () => {
	send("stats", counters.frames, counters.bytes, counters.discontinuities, counters.gaps, counters.lastSequence);
	send(
		"publisher-stats",
		publisher.stats.framesSent,
		publisher.stats.framesDropped,
		publisher.stats.sessions,
		publisher.stats.reconnects
	);
	// Le debit reellement produit, le plafond choisi, et le retard courant du lien montant. Ces trois
	// chiffres ensemble disent si le lien tient : un debit colle au plafond avec un retard nul est un
	// lien sain, un debit qui s'en ecarte est un lien qui retrecit.
	const bitrate = publisher.bitrateController;
	send(
		"bitrate-stats",
		bitrate === null ? 0 : bitrate.report().applied,
		bitrate === null ? 0 : bitrate.report().ceiling,
		Math.round(publisher.oldestPendingMs())
	);
});

// Ce handler remet les compteurs a zero avant une nouvelle mesure.
Max.addHandler("reset", () => {
	counters.frames = 0;
	counters.bytes = 0;
	counters.discontinuities = 0;
	counters.gaps = 0;
	counters.lastSequence = -1;
	publisher.stats.framesSent = 0;
	publisher.stats.framesDropped = 0;
	send("stats", 0, 0, 0, 0, -1);
});

// Ce handler reannonce le port : il rattrape le cas ou l'encodeur a manque la premiere annonce.
Max.addHandler("getport", () => {
	if (bridge.port !== 0) {
		send("port", bridge.port);
	}
});

// Ce delai laisse partir `stream_stop` et la trame de fermeture WebSocket avant de rendre la main.
const SHUTDOWN_FLUSH_MS = 250;
let shuttingDown = false;

// Cette fonction ferme la session en cours au lieu de la laisser expirer cote relais, puis termine
// le processus. Sans ce `process.exit`, l'ajout d'un gestionnaire de signal remplacerait l'arret par
// defaut de Node : le port loopback garderait la boucle d'evenements vivante et Max devrait tuer un
// script qui ne s'arrete plus.
function shutdown() {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	publisher.stop("user_stop");
	setTimeout(() => {
		bridge.close().then(
			() => process.exit(0),
			() => process.exit(0)
		);
	}, SHUTDOWN_FLUSH_MS);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Le port est annonce a Max : l'objet natif s'y connecte ensuite tout seul.
bridge
	.listen()
	.then((port) => {
		send("port", port);
		publishBridgeStatus("stopped", "aucun encodeur connecte");
		// L'etat de la configuration part sans attendre de question : le device montre des
		// l'ouverture s'il manque une adresse ou un token, avant tout clic sur Lancer.
		publishConfig();
	})
	.catch((error) => {
		publishBridgeStatus("error", error.message);
	});
