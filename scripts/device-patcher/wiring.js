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
import { colorMessage, connect, message, object, PALETTE } from "./parts.js";

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
const NODE_MESSAGES = [
	"port",
	"publisher",
	"encoder",
	"config",
	"saved",
	"relay",
	"status",
	"urlfield",
	"version",
	"journal",
	"journalpos"
];

// Nombre de lignes affichees par l'onglet Journal. C'est la meme valeur que dans `interface.js`, et
// c'est aussi celle qu'attend le script Node : il envoie `journal <ligne> <texte>` pour chacune.
const JOURNAL_ROWS = 5;

// Le seul etat pendant lequel du son part vraiment vers le relais. C'est celui que le device
// signale en rouge.
const LIVE_STATE = "LIVE";

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
	// Les pages, dans l'ordre des onglets. Cet ordre est le seul endroit ou il est ecrit : les
	// messages de bascule, les cables et le numero sorti par l'onglet en decoulent tous.
	const pageList = [pages.livePage, pages.settingsPage, pages.journalPage];

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

		// Les trois boutons du journal. Chacun suit le chemin de « Tester le relais » : un `t b` qui
		// ramene le clic a un bang, puis un message que Node reconnait.
		object("journal-copy-fan", "t b", { at: [820, 660, 40, 22], outletTypes: ["bang"] }),
		message("journal-copy-message", "journalcopy", { at: [820, 700, 90, 22] }),
		object("journal-export-fan", "t b", { at: [940, 660, 40, 22], outletTypes: ["bang"] }),
		message("journal-export-message", "journalsave", { at: [940, 700, 90, 22] }),
		object("journal-clear-fan", "t b", { at: [1060, 660, 40, 22], outletTypes: ["bang"] }),
		message("journal-clear-message", "journalclear", { at: [1060, 700, 90, 22] }),

		// Les deux boutons de defilement suivent le meme chemin. C'est Node qui tient la position :
		// le patcher ne compte rien, il transmet une pression et affiche ce qu'on lui renvoie.
		object("journal-up-fan", "t b", { at: [1180, 660, 40, 22], outletTypes: ["bang"] }),
		message("journal-up-message", "journalup", { at: [1180, 700, 80, 22] }),
		object("journal-down-fan", "t b", { at: [1290, 660, 40, 22], outletTypes: ["bang"] }),
		message("journal-down-message", "journaldown", { at: [1290, 700, 90, 22] }),

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

		// Le mot d'etat passe au rouge d'enregistrement d'Ableton pendant un direct, et revient a la
		// couleur de texte ordinaire dans les quatre autres etats.
		//
		// La couleur suit l'etat annonce par le publisher, jamais le bouton : c'est la meme regle que
		// pour le verrou des deux reglages. Un bouton enfonce dit ce que Vassi a demande ; seul l'etat
		// dit ce qui part reellement vers le relais, et c'est cela que le rouge doit promettre.
		message("state-color-live", colorMessage("textcolor", PALETTE.record), { at: [660, 560, 180, 22] }),
		message("state-color-idle", colorMessage("textcolor", PALETTE.text), { at: [660, 600, 180, 22] }),

		// --- Reglages affiches --------------------------------------------------------------
		object("config-set", "prepend set", { at: [880, 480, 80, 22], inlets: 2 }),
		object("relay-set", "prepend set", { at: [980, 480, 80, 22], inlets: 2 }),
		object("bridge-name", "prepend Encodeur", { at: [1080, 480, 120, 22], inlets: 2 }),
		object("bridge-set", "prepend set", { at: [1080, 520, 80, 22], inlets: 2 }),
		object("url-set", "prepend set", { at: [1220, 480, 80, 22], inlets: 2 }),
		// La version arrive de Node sous forme de texte et va telle quelle dans son libelle :
		// `prepend set` est ce qu'attend un `live.comment` pour changer ce qu'il affiche.
		object("version-set", "prepend set", { at: [1320, 480, 80, 22], inlets: 2 }),
		// --- Les lignes du journal -------------------------------------------------------------
		//
		// Node envoie `journal <ligne> <texte>`. Le numero de ligne est retire par ce second
		// aiguillage, et le texte va au libelle correspondant. Compter les lignes du cote de Node
		// evite au patcher de tenir un etat : il n'a jamais a savoir laquelle est la plus recente ni
		// a faire glisser les autres.
		object("journal-route", `route ${rowNumbers().join(" ")}`, {
			at: [1420, 480, 200, 22],
			outlets: JOURNAL_ROWS + 1,
			outletTypes: rowNumbers().map(() => "")
		}),
		...rowNumbers().map((row) =>
			object(`journal-set-${row}`, "prepend set", { at: [1420 + row * 90, 520, 80, 22], inlets: 2 })
		),
		object("journal-position-set", "prepend set", { at: [1420, 560, 80, 22], inlets: 2 }),

		object("saved-split", "zl slice 1", { at: [880, 540, 80, 22], inlets: 2, outlets: 2, outletTypes: ["", ""] }),
		object("saved-ok", "sel 1", { at: [880, 580, 60, 22], inlets: 2, outlets: 2, outletTypes: ["bang", ""] }),
		message("token-clear", "clear", { at: [880, 620, 50, 22] }),

		// --- Bascule entre les pages -----------------------------------------------------------
		object("page-select", `sel ${pageList.map((_, index) => index).join(" ")}`, {
			at: [880, 260, 90, 22],
			outlets: pageList.length + 1,
			outletTypes: pageList.map(() => "bang").concat([""])
		}),
		...pageList.map((page, index) =>
			message(`show-page-${index}`, pageScript(pageList, index), { at: [880, 300 + index * 40, 400, 22] })
		),
		object("pages", "thispatcher", { at: [880, 420, 90, 22], outlets: 2, outletTypes: ["", ""] }),

		// --- Ouverture du device --------------------------------------------------------------
		object("device-ready", "live.thisdevice", {
			at: [1180, 260, 110, 22],
			outlets: 3,
			outletTypes: ["bang", "int", "int"]
		}),
		object("ready-delay", `delay ${NODE_STARTUP_MS}`, { at: [1180, 300, 90, 22], inlets: 2, outletTypes: ["bang"] }),
		object("ready-fan", "t b b b b b", {
			at: [1180, 340, 100, 22],
			outlets: 5,
			outletTypes: ["bang", "bang", "bang", "bang", "bang"]
		}),
		message("ask-port", "getport", { at: [1180, 400, 60, 22] }),
		message("ask-config", "config", { at: [1260, 400, 60, 22] }),
		message("ask-journal", "journal", { at: [1340, 400, 70, 22] })
	];

	return { boxes, lines: buildLines(pageList) };
}

// Cette fonction ecrit le message qui cache toutes les pages sauf une.
// Une virgule separe deux messages : `thispatcher` les execute l'un apres l'autre.
//
// Les ordres de masquage passent tous avant les ordres d'affichage. Avec deux pages l'ordre etait
// sans importance ; avec trois, un objet montre puis cache par la page suivante disparaitrait.
function pageScript(pages, shown) {
	const hidden = pages.filter((_, index) => index !== shown).flat();
	const orders = hidden
		.map((name) => `script hide ${name}`)
		.concat(pages[shown].map((name) => `script show ${name}`));

	return orders.join(", ");
}

// Cette fonction rend les numeros de ligne du journal, de la plus recente a la plus ancienne.
function rowNumbers() {
	return Array.from({ length: JOURNAL_ROWS }, (_, index) => index);
}

// Cette fonction cree tous les cables du device.
function buildLines(pageList) {
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
		connect("node-route", 8, "version-set", 0),
		connect("node-route", 9, "journal-route", 0),
		connect("node-route", 10, "journal-position-set", 0),
		connect("journal-position-set", 0, "journal-position", 0),

		// L'etat se separe en un mot et un detail : le mot est traduit, le detail est affiche tel quel.
		connect("state-split", 0, "state-select", 0),
		connect("state-split", 1, "detail-set", 0),
		connect("detail-set", 0, "state-detail", 0),
		...STATES.map((_, index) => connect("state-select", index, `state-word-${index}`, 0)),
		...STATES.map((_, index) => connect(`state-word-${index}`, 0, "state-set", 0)),
		connect("state-set", 0, "state-label", 0),

		// La couleur du mot d'etat. `LIVE` est le seul etat rouge ; les quatre autres reposent la
		// couleur ordinaire, y compris `ERROR` — un direct qui s'est arrete n'est plus un direct, et
		// c'est le detail affiche juste dessous qui dit pourquoi.
		...STATES.map(([code], index) =>
			connect("state-select", index, code === LIVE_STATE ? "state-color-live" : "state-color-idle", 0)
		),
		connect("state-color-live", 0, "state-label", 0),
		connect("state-color-idle", 0, "state-label", 0),

		// Les trois lignes de la page de reglages.
		connect("config-set", 0, "config-line", 0),
		connect("relay-set", 0, "relay-line", 0),
		connect("bridge-name", 0, "bridge-set", 0),
		connect("bridge-set", 0, "bridge-line", 0),
		connect("url-set", 0, "url-field", 0),
		connect("version-set", 0, "version-line", 0),

		// Chaque ligne du journal va a son libelle.
		...rowNumbers().map((row) => connect("journal-route", row, `journal-set-${row}`, 0)),
		...rowNumbers().map((row) => connect(`journal-set-${row}`, 0, `journal-line-${row}`, 0)),

		// Les trois boutons du journal.
		connect("journal-copy", 0, "journal-copy-fan", 0),
		connect("journal-copy-fan", 0, "journal-copy-message", 0),
		connect("journal-copy-message", 0, "node", 0),
		connect("journal-export", 0, "journal-export-fan", 0),
		connect("journal-export-fan", 0, "journal-export-message", 0),
		connect("journal-export-message", 0, "node", 0),
		connect("journal-clear", 0, "journal-clear-fan", 0),
		connect("journal-clear-fan", 0, "journal-clear-message", 0),
		connect("journal-clear-message", 0, "node", 0),

		// Les deux boutons de defilement.
		connect("journal-up", 0, "journal-up-fan", 0),
		connect("journal-up-fan", 0, "journal-up-message", 0),
		connect("journal-up-message", 0, "node", 0),
		connect("journal-down", 0, "journal-down-fan", 0),
		connect("journal-down-fan", 0, "journal-down-message", 0),
		connect("journal-down-message", 0, "node", 0),

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
		// lecture a retenir, et les deux directions passent par le meme cable. Un `live.text` en
		// interrupteur ne conviendrait pas ici : sans parametre attache, il n'a aucune valeur ou
		// retenir sa position, renvoie le meme 1 a chaque clic, et la page ouverte ne se refermerait
		// jamais.
		connect("page-tabs", 0, "page-select", 0),
		...pageList.map((_, index) => connect("page-select", index, `show-page-${index}`, 0)),
		...pageList.map((_, index) => connect(`show-page-${index}`, 0, "pages", 0)),

		// La page du direct s'affiche des le chargement, sans attendre Node : les deux pages sont
		// dessinees au meme endroit, et celle des reglages resterait sinon visible par-dessus
		// pendant toute l'attente.
		connect("device-ready", 0, "show-page-0", 0),

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

		// Le reste attend que le script Node reponde : le port, les deux reglages, la configuration,
		// et les lignes du journal deja ecrites pendant le demarrage.
		//
		// `trigger` sort de droite a gauche : le port part en premier, le journal en dernier, et il
		// contient donc deja les lignes que les questions precedentes ont fait ecrire.
		connect("device-ready", 0, "ready-delay", 0),
		connect("ready-delay", 0, "ready-fan", 0),
		connect("ready-fan", 4, "ask-port", 0),
		connect("ready-fan", 3, "quality-menu", 0),
		connect("ready-fan", 2, "latency-menu", 0),
		connect("ready-fan", 1, "ask-config", 0),
		connect("ready-fan", 0, "ask-journal", 0),
		connect("ask-port", 0, "node", 0),
		connect("ask-config", 0, "node", 0),
		connect("ask-journal", 0, "node", 0)
	];
}
