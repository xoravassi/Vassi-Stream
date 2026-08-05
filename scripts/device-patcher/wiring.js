// Ce module contient tout ce qui ne se voit pas : le chemin audio, le script Node et les cables.
//
// Deux regles gouvernent ce cablage.
//
// Le son passe de `plugin~` a `plugout~` sans rien traverser. `vassi.encoder~` et les deux
// vumetres sont branches en parallele et n'ont aucune sortie audio : allumer ou eteindre le
// direct ne peut pas modifier le master d'Ableton.
//
// Le texte affiche arrive tout fait depuis Node. Le patcher ne fabrique aucune phrase : il route
// des messages vers des libelles. C'est ce qui garde ce fichier court.
import { connect, message, object } from "./parts.js";

// Le script Node est designe par son seul nom de fichier, sans dossier.
//
// C'est la seule forme que Max sait resoudre ici. Un `.amxd` pose dans la bibliotheque d'Ableton ne
// donne aucun point de depart a `node.script` : la base de recherche de Max n'indexe pas un seul
// fichier sous `Documents\Ableton\User Library`. Un chemin relatif comme `node/index.js` n'y menait
// donc nulle part, et le script ne demarrait jamais — sans erreur visible ailleurs que dans la
// fenetre Max. Un chemin absolu, lui, ne survivrait pas a un changement de machine.
//
// Le script est donc installe dans la bibliotheque de Max, `Documents\Max 8\Library\Vassi Stream\`,
// a cote de l'external : c'est un dossier que Max indexe, et c'est deja par la que `vassi.encoder~`
// est trouve. Le nom du fichier est unique dans cette base — un `index.js` y designerait un exemple
// livre avec Node for Max.
const NODE_SCRIPT = "node.script vassi-stream-device.js @autostart 1";

// Ces mots sont ceux que le script Node place devant ses messages, dans cet ordre.
const NODE_MESSAGES = ["port", "publisher", "encoder", "config", "saved", "relay", "status", "urlfield"];

// Ces cinq etats viennent de `publisher.js`. Chacun recoit un mot francais affichable.
const STATES = [
	["STOPPED", "Arrêté"],
	["CONNECTING", "Connexion"],
	["LIVE", "Live"],
	["RECONNECTING", "Reconnexion"],
	["ERROR", "Erreur"]
];

// Node for Max met environ une seconde a demarrer. Le device attend avant de lui parler, sinon
// ses premieres questions partiraient dans le vide et l'affichage resterait vide sans raison.
const NODE_STARTUP_MS = 1500;

// Cette fonction cree les objets caches et les cables du device.
export function buildWiring(pages) {
	const boxes = [
		// --- Commandes envoyees a Node -------------------------------------------------------
		object("live-prepend", "prepend live", { at: [40, 260, 90, 22], inlets: 2 }),
		message("lock", "0", { at: [150, 260, 32, 22] }),
		message("unlock", "1", { at: [190, 260, 32, 22] }),
		message("toggle-reset", "set 0", { at: [240, 260, 50, 22] }),
		message("page-reset", "set 0", { at: [300, 260, 50, 22] }),
		object("active-prepend", "prepend active", { at: [150, 300, 100, 22], inlets: 2 }),
		object("quality-fan", "t i i", { at: [40, 340, 60, 22], outlets: 2, outletTypes: ["int", "int"] }),
		object("quality-node", "prepend quality", { at: [40, 380, 110, 22], inlets: 2 }),
		object("quality-encoder", "prepend quality", { at: [160, 380, 110, 22], inlets: 2 }),
		object("latency-int", "t i", { at: [290, 340, 50, 22], outletTypes: ["int"] }),
		object("latency-node", "prepend latency", { at: [290, 380, 110, 22], inlets: 2 }),
		object("url-prepend", "prepend relayurl", { at: [250, 430, 120, 22], inlets: 2 }),
		object("token-prepend", "prepend relaytoken", { at: [390, 430, 130, 22], inlets: 2 }),
		object("save-fan", "t b b b", { at: [560, 380, 70, 22], outlets: 3, outletTypes: ["bang", "bang", "bang"] }),
		message("save-message", "saveconfig", { at: [560, 420, 80, 22] }),
		object("check-fan", "t b", { at: [700, 380, 40, 22], outletTypes: ["bang"] }),
		message("check-message", "checkrelay", { at: [700, 420, 80, 22] }),

		// --- Script Node ------------------------------------------------------------------
		object("node", NODE_SCRIPT, { at: [420, 300, 300, 22], outlets: 2, outletTypes: ["", ""] }),
		// `route` n'a qu'une entree : ses arguments ne se changent pas depuis un cable.
		object("node-route", `route ${NODE_MESSAGES.join(" ")}`, {
			at: [420, 340, 420, 22],
			outlets: NODE_MESSAGES.length + 1,
			outletTypes: NODE_MESSAGES.map(() => "")
		}),

		// --- Chemin audio -----------------------------------------------------------------
		object("audio-in", "plugin~", { at: [40, 500, 60, 22], inlets: 2, outlets: 2, outletTypes: ["signal", "signal"] }),
		object("audio-out", "plugout~", { at: [40, 620, 65, 22], inlets: 2, outlets: 2, outletTypes: ["signal", "signal"] }),
		object("port-prepend", "prepend port", { at: [200, 520, 90, 22], inlets: 2 }),
		object("encoder", "vassi.encoder~", { at: [200, 560, 110, 22], inlets: 2, outlets: 1, outletTypes: [""] }),
		// Les vumetres s'eteignent avec le device. C'est la recommandation d'Ableton : un objet de
		// mesure garde sinon ses couleurs vives dans un device desactive, et ment sur ce qu'il
		// mesure encore.
		object("meter-active", "prepend active", { at: [340, 500, 100, 22], inlets: 2 }),

		// --- Etat affiche ------------------------------------------------------------------
		object("state-split", "zl slice 1", { at: [460, 480, 80, 22], inlets: 2, outlets: 2, outletTypes: ["", ""] }),
		// `sel` a plus d'un argument : il n'a donc qu'une entree.
		object("state-select", `sel ${STATES.map(([code]) => code).join(" ")}`, {
			at: [460, 520, 300, 22],
			outlets: STATES.length + 1,
			outletTypes: STATES.map(() => "bang").concat([""])
		}),
		...STATES.map(([, word], index) =>
			message(`state-word-${index}`, word, { at: [460 + index * 70, 560, 64, 22] })
		),
		object("state-set", "prepend set", { at: [460, 600, 80, 22], inlets: 2 }),
		object("detail-set", "prepend set", { at: [560, 600, 80, 22], inlets: 2 }),

		// --- Reglages affiches --------------------------------------------------------------
		object("config-set", "prepend set", { at: [880, 480, 80, 22], inlets: 2 }),
		object("relay-set", "prepend set", { at: [980, 480, 80, 22], inlets: 2 }),
		object("bridge-name", "prepend Encodeur", { at: [1080, 480, 120, 22], inlets: 2 }),
		object("bridge-set", "prepend set", { at: [1080, 520, 80, 22], inlets: 2 }),
		object("url-set", "prepend set", { at: [1220, 480, 80, 22], inlets: 2 }),
		object("saved-split", "zl slice 1", { at: [880, 540, 80, 22], inlets: 2, outlets: 2, outletTypes: ["", ""] }),
		object("saved-ok", "sel 1", { at: [880, 580, 60, 22], inlets: 2, outlets: 2, outletTypes: ["bang", ""] }),
		message("token-clear", "clear", { at: [880, 620, 50, 22] }),

		// --- Bascule entre les deux pages ----------------------------------------------------
		object("page-select", "sel 0 1", { at: [880, 260, 70, 22], outlets: 3, outletTypes: ["bang", "bang", ""] }),
		message("show-live", pageScript(pages.settingsPage, pages.livePage), { at: [880, 300, 300, 22] }),
		message("show-settings", pageScript(pages.livePage, pages.settingsPage), { at: [880, 340, 300, 22] }),
		object("pages", "thispatcher", { at: [880, 380, 90, 22], outlets: 2, outletTypes: ["", ""] }),

		// --- Ouverture du device --------------------------------------------------------------
		object("device-ready", "live.thisdevice", {
			at: [1180, 260, 110, 22],
			outlets: 3,
			outletTypes: ["bang", "int", "int"]
		}),
		object("ready-delay", `delay ${NODE_STARTUP_MS}`, { at: [1180, 300, 90, 22], inlets: 2, outletTypes: ["bang"] }),
		object("ready-fan", "t b b b b", { at: [1180, 340, 90, 22], outlets: 4, outletTypes: ["bang", "bang", "bang", "bang"] }),
		message("ask-port", "getport", { at: [1180, 400, 60, 22] }),
		message("ask-config", "config", { at: [1260, 400, 60, 22] })
	];

	return { boxes, lines: buildLines() };
}

// Cette fonction ecrit le message qui cache une page et montre l'autre.
// Une virgule separe deux messages : `thispatcher` les execute l'un apres l'autre.
function pageScript(hidden, shown) {
	const orders = hidden.map((name) => `script hide ${name}`).concat(shown.map((name) => `script show ${name}`));
	return orders.join(", ");
}

// Cette fonction cree tous les cables du device.
function buildLines() {
	return [
		// Le son traverse sans detour ; l'encodeur et les vumetres ne font qu'ecouter.
		connect("audio-in", 0, "audio-out", 0),
		connect("audio-in", 1, "audio-out", 1),
		connect("audio-in", 0, "encoder", 0),
		connect("audio-in", 1, "encoder", 1),
		connect("audio-in", 0, "meter-left", 0),
		connect("audio-in", 1, "meter-right", 0),

		// Tout ce que Node dit passe par un seul aiguillage.
		connect("node", 0, "node-route", 0),
		connect("node-route", 0, "port-prepend", 0),
		connect("node-route", 1, "state-split", 0),
		connect("node-route", 2, "encoder", 0),
		connect("node-route", 3, "config-set", 0),
		connect("node-route", 4, "saved-split", 0),
		connect("node-route", 5, "relay-set", 0),
		connect("node-route", 6, "bridge-name", 0),
		connect("node-route", 7, "url-set", 0),

		// L'etat se separe en un mot et un detail : le mot est traduit, le detail est affiche tel quel.
		connect("state-split", 0, "state-select", 0),
		connect("state-split", 1, "detail-set", 0),
		connect("detail-set", 0, "state-detail", 0),
		...STATES.map((_, index) => connect("state-select", index, `state-word-${index}`, 0)),
		...STATES.map((_, index) => connect(`state-word-${index}`, 0, "state-set", 0)),
		connect("state-set", 0, "state-label", 0),

		// Les trois lignes de la page de reglages.
		connect("config-set", 0, "config-line", 0),
		connect("relay-set", 0, "relay-line", 0),
		connect("bridge-name", 0, "bridge-set", 0),
		connect("bridge-set", 0, "bridge-line", 0),
		connect("url-set", 0, "url-field", 0),

		// Un enregistrement reussi efface le champ du token et affiche son resultat.
		connect("saved-split", 0, "saved-ok", 0),
		connect("saved-split", 1, "config-set", 0),
		connect("saved-ok", 0, "token-clear", 0),
		connect("token-clear", 0, "token-field", 0),

		// Le port annonce par Node va directement a l'objet natif.
		connect("port-prepend", 0, "encoder", 0),

		// Lancer et arreter le direct.
		connect("start-toggle", 0, "live-prepend", 0),
		connect("live-prepend", 0, "node", 0),

		// Les deux reglages se verrouillent tant qu'un direct est en cours, et le bouton retombe
		// des que le direct s'arrete. Le verrou suit l'etat annonce par le publisher, jamais le
		// bouton : apres une erreur, le publisher s'arrete seul, et un bouton reste allume ferait
		// croire a un direct qui n'existe plus.
		connect("state-select", 0, "unlock", 0),
		connect("state-select", 1, "lock", 0),
		connect("state-select", 2, "lock", 0),
		connect("state-select", 3, "lock", 0),
		connect("state-select", 4, "unlock", 0),
		connect("lock", 0, "active-prepend", 0),
		connect("unlock", 0, "active-prepend", 0),
		connect("active-prepend", 0, "quality-menu", 0),
		connect("active-prepend", 0, "latency-menu", 0),

		// `set` change la position du bouton sans la renvoyer : sans cela, l'arret annonce par le
		// publisher relancerait un arret, qui relancerait l'annonce, sans fin.
		connect("state-select", 0, "toggle-reset", 0),
		connect("state-select", 4, "toggle-reset", 0),
		connect("toggle-reset", 0, "start-toggle", 0),

		// La qualite part vers Node et vers l'encodeur ; la latence ne concerne que Node.
		connect("quality-menu", 0, "quality-fan", 0),
		connect("quality-fan", 1, "quality-encoder", 0),
		connect("quality-fan", 0, "quality-node", 0),
		connect("quality-encoder", 0, "encoder", 0),
		connect("quality-node", 0, "node", 0),
		connect("latency-menu", 0, "latency-int", 0),
		connect("latency-int", 0, "latency-node", 0),
		connect("latency-node", 0, "node", 0),

		// Enregistrer : l'adresse, puis le token, puis l'ordre d'ecriture.
		// `trigger` sort de droite a gauche : les deux champs partent avant l'ordre.
		connect("save-button", 0, "save-fan", 0),
		connect("save-fan", 2, "url-field", 0),
		connect("save-fan", 1, "token-field", 0),
		connect("save-fan", 0, "save-message", 0),
		connect("save-message", 0, "node", 0),
		connect("url-field", 0, "url-prepend", 0),
		connect("token-field", 0, "token-prepend", 0),
		connect("url-prepend", 0, "node", 0),
		connect("token-prepend", 0, "node", 0),

		// Tester le relais.
		connect("check-button", 0, "check-fan", 0),
		connect("check-fan", 0, "check-message", 0),
		connect("check-message", 0, "node", 0),

		// Bascule entre la page du direct et la page des reglages.
		//
		// L'onglet sort le numero de la page choisie : il n'y a pas d'etat a deviner ni de sens de
		// lecture a retenir, et les deux directions passent par le meme cable. La premiere version
		// posait ici un `live.text` en interrupteur sans parametre attache, donc sans valeur ou
		// retenir sa position : le meme 1 repartait a chaque clic et la page des reglages ne se
		// refermait jamais.
		connect("page-tabs", 0, "page-select", 0),
		connect("page-select", 0, "show-live", 0),
		connect("page-select", 1, "show-settings", 0),
		connect("show-live", 0, "pages", 0),
		connect("show-settings", 0, "pages", 0),

		// La page du direct s'affiche des le chargement, sans attendre Node : les deux pages sont
		// dessinees au meme endroit, et celle des reglages resterait sinon visible par-dessus
		// pendant toute l'attente.
		connect("device-ready", 0, "show-live", 0),

		// Un device rouvert repart arrete, sur la page du direct. Les deux `set` reposent les
		// commandes sans rien emettre : aucun direct ne peut donc se lancer a l'ouverture d'un
		// projet, quoi que Live ait retenu.
		connect("device-ready", 0, "toggle-reset", 0),
		connect("device-ready", 0, "page-reset", 0),
		connect("page-reset", 0, "page-tabs", 0),

		// Les vumetres suivent l'etat du device.
		connect("device-ready", 1, "meter-active", 0),
		connect("meter-active", 0, "meter-left", 0),
		connect("meter-active", 0, "meter-right", 0),

		// Le reste attend que le script Node reponde : le port, les deux reglages, la configuration.
		connect("device-ready", 0, "ready-delay", 0),
		connect("ready-delay", 0, "ready-fan", 0),
		connect("ready-fan", 3, "ask-port", 0),
		connect("ready-fan", 2, "quality-menu", 0),
		connect("ready-fan", 1, "latency-menu", 0),
		connect("ready-fan", 0, "ask-config", 0),
		connect("ask-port", 0, "node", 0),
		connect("ask-config", 0, "node", 0)
	];
}
