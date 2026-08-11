"use strict";

const os = require("os");
const Max = require("max-api");
const { FrameBridge } = require("./frame-bridge.js");
const { Publisher } = require("./publisher.js");
const { ConfigEditor } = require("./config-editor.js");
const { checkRelay } = require("./relay-health.js");
const { Journal, reveal } = require("./journal.js");
const protocol = require("./publisher-protocol.js");

// Cette fonction rend la version gravee par `scripts/stamp-version.js` a l'installation.
//
// Elle repond a une seule question, posee devant un device qui ne semble pas avoir change : ce qui
// tourne dans Ableton est-il bien ce qui vient d'etre installe. Un fichier absent donne une version
// inconnue plutot qu'une erreur : le device doit demarrer meme lance depuis un dossier non installe.
function readVersion() {
	try {
		const version = require("./version.json");
		// Le suffixe marque un dossier modifie depuis son dernier commit : le numero de build ne le
		// dirait pas, puisqu'il ne compte que les commits.
		const suffixe = version.etat === "propre" ? "" : "+";

		return `v${version.version} · build ${version.numero}${suffixe}`;
	} catch (error) {
		return "version inconnue";
	}
}

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

// --- Le journal ------------------------------------------------------------------------------
//
// Tout ce qui suit alimente l'onglet Journal du device. Le principe est celui du reste du projet :
// le texte est forme ici, pres des valeurs, et le patcher ne fait que l'afficher.
//
// Une regle tient tout le reste : **rien de ce qui arrive frame par frame n'ecrit dans le journal**.
// Une ligne par trame ferait cinquante lignes par seconde, effacerait le journal en huit secondes et
// chargerait Max pour rien. Ce qui se compte est donc lu par un battement de seconde, et resume.

// Nombre de lignes montrees par l'onglet Journal, et pas d'un coup de defilement.
const JOURNAL_ROWS = 5;

// Largeur d'une ligne affichee, en caracteres.
//
// Un `live.comment` ne coupe pas une ligne trop longue : il la replie sur une seconde ligne, qu'il
// dessine par-dessus le libelle du dessous. Deux lignes du journal sont alors illisibles a la fois.
// Cette largeur garde chaque ligne sur une seule ligne de libelle.
//
// Cinquante-huit est un plafond prudent pour 304 pixels en 9 points : la place tient une soixantaine
// de caracteres, et couper un peu tot vaut mieux que laisser une ligne se replier. La coupe ne
// concerne que l'affichage — le texte copie et le fichier exporte gardent la ligne entiere.
const JOURNAL_WIDTH = 58;
// Delai de regroupement des envois vers Max. Plusieurs lignes ecrites dans la meme milliseconde ne
// provoquent qu'un seul rafraichissement.
const JOURNAL_REFRESH_MS = 200;
// Battement du suivi de direct. Une seconde est assez fin pour dater une rafale d'abandons, et assez
// large pour ne rien couter.
const WATCH_TICK_MS = 1000;
// Periode du bilan de sante pendant un direct.
const WATCH_REPORT_MS = 10000;
// Delai minimal entre deux lignes d'abandon : une rafale devient une ligne, pas cinquante.
const WATCH_DROP_MS = 2000;
// Ecart de debit a partir duquel un changement merite une ligne. Le regulateur avance par pas
// minuscules ; seuls les paliers de huit kilobits racontent quelque chose.
const BITRATE_LOG_STEP = 8000;

const journal = new Journal({
	// Ces lignes coiffent le fichier exporte. Elles repondent aux trois questions posees devant un
	// journal recu par message : quelle version, quelle machine, et vers quel relais.
	context: () => [readVersion(), `${process.platform}, node ${process.version}`, editor.deviceStatus().text],
	onChange: () => scheduleJournalRefresh()
});

let journalTimer = null;

// Position de la fenetre affichee dans le journal, en nombre de lignes depuis la plus recente.
//
// Zero est le present : l'onglet montre ce qui vient d'arriver, et il y revient tout seul des qu'une
// nouvelle ligne le pousse hors de la fenetre. Une valeur non nulle est un choix de Vassi, qui a
// remonte le journal, et rien ne la ramene a zero sans un clic : une ligne de sante ecrite pendant
// la lecture ne doit pas faire sauter la page sous les yeux.
let journalOffset = 0;

// Cette fonction programme un rafraichissement de l'onglet Journal, une fois pour toutes les lignes
// ecrites dans le meme instant.
function scheduleJournalRefresh() {
	if (journalTimer !== null) {
		return;
	}

	journalTimer = setTimeout(() => {
		journalTimer = null;
		sendJournal();
	}, JOURNAL_REFRESH_MS);

	// Ce minuteur ne doit jamais retenir le processus a l'arret du device.
	if (typeof journalTimer.unref === "function") {
		journalTimer.unref();
	}
}

// Cette fonction envoie la fenetre courante vers les cinq libelles de l'onglet, la plus recente en
// premier. Le numero de ligne part avec le texte : le patcher n'a qu'a l'aiguiller.
//
// La position part avec les lignes, et elle est calculee ici comme tout le reste : le patcher ne
// compte rien, il affiche une phrase deja formee.
function sendJournal() {
	journalOffset = boundedOffset(journalOffset);
	const rows = journal.recent(JOURNAL_ROWS, journalOffset, JOURNAL_WIDTH);

	for (let index = 0; index < JOURNAL_ROWS; index += 1) {
		send("journal", index, rows[index]);
	}

	send("journalpos", journalPosition());
}

// Cette fonction ramene une position dans les bornes du journal.
//
// La fenetre ne peut pas remonter au-dela de la plus vieille ligne gardee. Sans cette borne, les
// lignes chassees par la capacite laisseraient l'onglet sur cinq espaces, sans rien pour comprendre
// pourquoi.
function boundedOffset(offset) {
	return Math.max(0, Math.min(offset, journal.count - JOURNAL_ROWS));
}

// Cette fonction ecrit la position atteinte dans le journal.
//
// Les numeros comptent a partir de la ligne la plus recente, comme l'affichage : la ligne 1 est
// celle du haut. C'est le seul comptage qui se verifie a l'oeil sans reflechir.
function journalPosition() {
	if (journal.count === 0) {
		return "vide";
	}

	const first = journalOffset + 1;
	const last = Math.min(journalOffset + JOURNAL_ROWS, journal.count);

	return `${first}-${last} / ${journal.count}`;
}

// Cette fonction publie l'etat du pont loopback, que le device affiche.
// Chaque changement d'etat ouvre ou ferme une connexion, et l'encodeur repart alors de la
// sequence zero : le suivi de continuite repart de zero lui aussi pour ne pas compter un faux trou.
function publishBridgeStatus(state, detail) {
	counters.lastSequence = -1;
	send("status", state, detail);
	journal.record("encodeur", `${state} : ${detail}`);
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
	// La phrase publiee ne contient jamais le token, seulement ses quatre derniers caracteres : elle
	// peut donc entrer telle quelle dans un journal destine a etre colle ailleurs.
	journal.record("config", status.text);

	if (status.relayUrl !== "") {
		send("urlfield", status.relayUrl);
	}
}

const publisher = new Publisher({
	// L'etat du relais sort sur un mot different de celui du pont : les deux restent lisibles
	// separement dans le device, et le patch du bloc 5 continue de fonctionner sans modification.
	onState: (state, detail) => {
		send("publisher", state, detail);
		// Ces cinq etats sont le squelette du journal : c'est cette suite qui distingue un relais
		// injoignable d'un token refuse, et une coupure unique d'une reconnexion qui boucle. Le
		// detail porte la raison de la coupure et le delai avant la tentative suivante.
		journal.record("direct", `${state} : ${detail}`);
	},
	// L'encodeur ne tourne que pendant une session acceptee par le relais. Il recoit deux sortes
	// d'ordres : `start` et `stop`, sans valeur, et `bitrate` suivi du debit a appliquer, que le
	// regulateur revoit pendant tout le direct.
	onEncoder: (action, value) => {
		if (value === undefined) {
			send("encoder", action);
			journal.record("encodeur", `ordre ${action}`);
			return;
		}

		send("encoder", action, value);
		logBitrate(action, value);
	}
});

// Dernier debit ecrit dans le journal. Le regulateur en annonce plusieurs par seconde pendant une
// rampe ; seuls les paliers assez ecartes racontent quelque chose de lisible.
let loggedBitrate = 0;

// Cette fonction note un changement de debit quand il vaut la peine d'etre note.
function logBitrate(action, value) {
	if (action !== "bitrate") {
		return;
	}

	if (Math.abs(value - loggedBitrate) < BITRATE_LOG_STEP) {
		return;
	}

	loggedBitrate = value;
	const ceiling = publisher.bitrateController === null ? publisher.bitrate : publisher.bitrateController.report().ceiling;
	journal.record("debit", `${kbits(value)} sur ${kbits(ceiling)} de plafond`);
}

// Cette fonction ecrit un debit en kilobits par seconde, l'unite dans laquelle il se lit.
function kbits(value) {
	return `${Math.round(value / 1000)} kbit/s`;
}

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
		journal.record("bouton", "arret demande");
		publisher.stop("user_stop");
		return;
	}

	// Le reglage choisi est note avec la demande : c'est le seul endroit ou l'on peut relire, apres
	// coup, sous quelle qualite un direct a ete lance.
	journal.record("bouton", `direct demande a ${kbits(selection.bitrate)}, latence ${selection.latencyProfile}`);
	publisher.start(selection);
});

// Ce handler choisit la qualite pour le prochain live : 0 Stable, 1 Haute, 2 Studio.
Max.addHandler("quality", (value) => {
	const bitrate = QUALITY_BITRATES[Number(value)];
	if (bitrate !== undefined) {
		selection.bitrate = bitrate;
	}
	journal.record("reglage", `qualite ${kbits(selection.bitrate)}`);
	send("selection", selection.bitrate, selection.latencyProfile);
});

// Ce handler choisit la latence pour le prochain live : 0 Faible, 1 Equilibree, 2 Stable.
Max.addHandler("latency", (value) => {
	const profile = LATENCY_PROFILES[Number(value)];
	if (profile !== undefined) {
		selection.latencyProfile = profile;
	}
	journal.record("reglage", `latence ${selection.latencyProfile}`);
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

// Ce handler note ce qui vient d'etre tape dans les deux champs, au moment de l'enregistrement.
//
// L'adresse est notee en entier — c'est elle qu'on relit pour trouver une faute de frappe. Le token
// n'est jamais note, pas meme partiellement : seule sa longueur l'est, et c'est deja la reponse a la
// question qui se pose vraiment devant un token refuse, « est-ce que le collage a fonctionne ».
function logDraft() {
	const draft = editor.draft;
	journal.record("saisie", `adresse "${draft.relayUrl}", token de ${draft.token.length} caracteres`);
}

// Ce handler enregistre les champs tapes puis reannonce l'etat de la configuration.
// Un champ laisse vide garde sa valeur precedente : corriger l'adresse ne demande pas le token.
//
// L'etat part avant le resultat : le device affiche les deux au meme endroit, et c'est le
// resultat de l'enregistrement qui doit rester visible.
Max.addHandler("saveconfig", () => {
	logDraft();
	const result = editor.apply();
	publishConfig();
	journal.record("config", result.ok ? result.text : `echec : ${result.text}`);
	send("saved", result.ok ? 1 : 0, result.text);
});

// Ce handler demande au relais s'il repond, par sa route publique de sante.
// La verification n'utilise aucun token : une erreur de collage d'adresse se voit tout de suite,
// sans qu'un secret circule sur le reseau pour la trouver.
Max.addHandler("checkrelay", () => {
	const status = editor.deviceStatus();

	if (!status.ready) {
		send("relay", status.text);
		journal.record("relais", status.text);
		return;
	}

	send("relay", "verification en cours");
	checkRelay(status.relayUrl).then(
		(result) => {
			send("relay", result.detail);
			journal.record("relais", result.detail);
		},
		() => {
			send("relay", "verification impossible");
			journal.record("relais", "verification impossible");
		}
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

// --- Les quatre ordres de l'onglet Journal -----------------------------------------------------

// Ce handler renvoie les lignes affichees. Il sert a l'ouverture du device, et rattrape le cas ou
// l'onglet est ouvert alors que rien n'a bouge depuis longtemps.
Max.addHandler("journal", () => {
	sendJournal();
});

// Ce handler met le journal dans le presse-papiers.
//
// Le resultat devient lui-meme une ligne de journal, donc la premiere ligne affichee : c'est la
// reponse au clic, au meme endroit que le reste, sans un libelle de plus sur la page. Le journal
// copie est celui d'avant le clic — la ligne du succes n'y est pas, et c'est sans importance.
Max.addHandler("journalcopy", () => {
	const count = journal.lines().length;

	journal.copy().then(
		() => journal.record("journal", `${count} lignes copiees dans le presse-papiers`),
		(error) => journal.record("journal", `copie impossible (${error.message}), passez par Exporter`)
	);
});

// Ce handler ecrit le journal dans un fichier et ouvre son dossier.
Max.addHandler("journalsave", () => {
	let file = "";

	try {
		file = journal.save();
	} catch (error) {
		journal.record("journal", `ecriture impossible : ${error.message}`);
		return;
	}

	journal.record("journal", `ecrit dans ${file}`);
	reveal(file);
});

// Ce handler vide le journal. Il sert avant un essai : repartir d'une page blanche vaut mieux que
// chercher ou commence la mesure en cours.
Max.addHandler("journalclear", () => {
	journalOffset = 0;
	journal.clear();
	journal.record("journal", "journal vide");
});

// Ces deux handlers font glisser la fenetre affichee, d'une page de cinq lignes a chaque pression.
//
// « Bas » descend dans le journal, donc vers les lignes plus anciennes : c'est le sens d'une barre
// de defilement posee sur le fichier, ou les plus recentes sont en haut. « Haut » remonte vers le
// present, et s'arrete a zero.
//
// Le defilement ne passe pas par le minuteur de regroupement : une pression doit repondre tout de
// suite, alors qu'une ligne ecrite peut attendre deux dixiemes de seconde.
Max.addHandler("journaldown", () => {
	journalOffset = boundedOffset(journalOffset + JOURNAL_ROWS);
	sendJournal();
});

Max.addHandler("journalup", () => {
	journalOffset = boundedOffset(journalOffset - JOURNAL_ROWS);
	sendJournal();
});

// --- Le suivi du direct -------------------------------------------------------------------------
//
// Ce battement est la seule source des lignes qui comptent des trames. Il lit des compteurs deja
// tenus ailleurs et n'ajoute rien au chemin de l'audio : une trame qui part ne traverse pas une
// ligne de ce bloc.

// Ces valeurs sont celles relevees au debut du direct en cours : tous les chiffres du journal sont
// des ecarts a ce point de depart. Les compteurs du publisher, eux, ne repartent jamais de zero, et
// un total cumule sur toute une session Ableton ne dirait pas ce qui s'est passe ce soir.
const watch = {
	since: 0,
	frames: 0,
	dropped: 0,
	gaps: 0,
	reconnects: 0,
	reported: 0,
	seenDrops: 0,
	lastDrop: 0,
	// Ces trois valeurs suivent l'horloge de source. Le taux est rendu sur l'intervalle et non depuis
	// le debut : un decrochage de trois minutes disparaitrait dans une moyenne de quarante.
	sourceAudio: 0n,
	sourceElapsed: 0n,
	sourceDeclared: 0,
	// Ces deux-la separent une source qui ralentit d'une source qui s'arrete net. Voir `stallLine`.
	sourceStalls: 0,
	sourceResyncs: 0
};

// Cette fonction releve le point de depart au debut de chaque direct.
function startWatch(at) {
	watch.since = at;
	watch.frames = publisher.stats.framesSent;
	watch.dropped = publisher.stats.framesDropped;
	watch.gaps = counters.gaps;
	watch.reconnects = publisher.stats.reconnects;
	watch.reported = at;
	watch.seenDrops = publisher.stats.framesDropped;
	watch.lastDrop = 0;

	const source = publisher.sourceClock.report();
	watch.sourceAudio = source.audioMicros;
	watch.sourceElapsed = source.elapsedMicros;
	watch.sourceDeclared = source.declaredMs;
	watch.sourceStalls = source.stalls;
	watch.sourceResyncs = source.resyncs;
}

// Cette fonction ecrit le bilan de fin de direct : ce qu'on relit en premier apres coup.
//
// Le bilan tient en deux lignes. Les chiffres reunis en une seule depasseraient les cinquante-huit
// caracteres d'une ligne du device, et la coupe tomberait au milieu de ce qu'on vient lire.
function endWatch(at) {
	const seconds = Math.round((at - watch.since) / 1000);

	watch.since = 0;
	journal.record("bilan", `${duration(seconds)} de direct, ${publisher.stats.framesSent - watch.frames} trames`);
	journal.record(
		"bilan",
		`${publisher.stats.framesDropped - watch.dropped} jetees, ` +
			`${publisher.stats.reconnects - watch.reconnects} reconnexion(s), ` +
			`${counters.gaps - watch.gaps} trou(s)`
	);
}

// Cette fonction ecrit le bilan periodique d'un direct en cours.
//
// Ces chiffres ensemble suffisent a nommer un probleme sans rien ouvrir d'autre. Un debit colle au
// plafond avec un retard nul est un lien sain. Un debit qui descend seul est un lien qui retrecit,
// et le regulateur fait son travail. Un retard qui monte pendant que des trames sont jetees est un
// lien depasse. Des trous cote encodeur sans rien de tout cela designent la machine, pas le reseau.
//
// La ligne `source` est la derniere arrivee et elle repond a un cas que toutes les autres declaraient
// sain : la machine qui ne calcule plus assez de son. Voir `sourceLine`.
function reportWatch(at) {
	const controller = publisher.bitrateController;
	const applied = controller === null ? 0 : controller.report().applied;
	const ceiling = controller === null ? publisher.bitrate : controller.report().ceiling;

	journal.record(
		"sante",
		`${publisher.stats.framesSent - watch.frames} trames, ` +
			`${publisher.stats.framesDropped - watch.dropped} jetees, ` +
			`${counters.gaps - watch.gaps} trou(s)`
	);
	journal.record(
		"lien",
		`${Math.round(applied / 1000)} sur ${kbits(ceiling)}, retard ${Math.round(publisher.oldestPendingMs())} ms`
	);
	journal.record("source", sourceLine());

	const stalls = stallLine();
	if (stalls !== null) {
		journal.record("arrets", stalls);
	}

	journal.record("systeme", machineLine(at));
}

// Cette fonction dit si l'external a produit autant de son que le temps qui a passe.
//
// C'est la mesure qui manquait le 11 aout 2026. Ce soir-la, tous les compteurs affichaient zero
// probleme — zero trou, zero jetee, retard nul, debit colle au plafond — pendant que l'external
// rendait 24,08 trames par seconde au lieu de 25. Les 91 s d'audio jamais calculees par Ableton ne
// laissaient aucune trace ici, et ressortaient chez l'auditeur en coupures de deux secondes.
//
// Le rapport est rendu sur l'intervalle, comme les autres lignes, et le seuil est bas a dessein :
// un pour cent de deficit vaut deja 36 ms de tampon perdues par seconde chez l'auditeur.
//
// La deuxieme ligne — `arrets` — separe deux choses que ce taux confond, et cette confusion a une
// consequence directe sur l'auditeur. Une source qui **ralentit** ne fait declarer que des pas d'une
// trame, que le player comble sans jamais interrompre la lecture. Une source qui **s'arrete net**
// fait declarer un pas de la taille de l'arret, et au-dela d'une demi-seconde le player vide sa file
// et rebufferise. Au banc de rejeu, le meme deficit de 3,7 % vaut zero coupure dans le premier cas et
// quatre-vingt-neuf vidages dans le second.
//
// Le journal du 11 aout 2026 ne permettait pas de trancher : ses lignes etaient espacees de dix
// secondes, et son pire intervalle — 3440 ms manquants a 10:22:15 — peut etre l'un ou l'autre. Cette
// ligne-ci est ce qui rendra la question decidable au prochain essai.
function sourceLine() {
	const source = publisher.sourceClock.report();
	const audio = Number(source.audioMicros - watch.sourceAudio);
	const elapsed = Number(source.elapsedMicros - watch.sourceElapsed);
	const declared = source.declaredMs - watch.sourceDeclared;

	watch.sourceAudio = source.audioMicros;
	watch.sourceElapsed = source.elapsedMicros;
	watch.sourceDeclared = source.declaredMs;

	if (elapsed <= 0) {
		return "en attente de trames";
	}

	const ratio = audio / elapsed;
	const rate = (ratio * 25).toFixed(1);

	if (ratio >= 0.99) {
		return `${rate} trames/s, le moteur audio suit`;
	}

	return (
		`${rate} trames/s au lieu de 25 : le moteur audio ne fournit que ${Math.round(ratio * 100)} % ` +
		`du temps reel, ${(declared / 1000).toFixed(1)} s annoncees comme trou`
	);
}

// Cette fonction rend la ligne des arrets francs, ou `null` quand il n'y en a pas eu.
//
// Elle se tait dans le cas ordinaire, et c'est voulu : une ligne ecrite a chaque battement pour dire
// « rien » noierait celle qui compte. Elle parle exactement quand la source a cesse de produire au
// lieu de ralentir, ce qui est la seule forme de deficit qui coupe encore le son.
function stallLine() {
	const source = publisher.sourceClock.report();
	const stalls = source.stalls - watch.sourceStalls;
	const resyncs = source.resyncs - watch.sourceResyncs;

	watch.sourceStalls = source.stalls;
	watch.sourceResyncs = source.resyncs;

	if (stalls === 0 && resyncs === 0) {
		return null;
	}

	if (resyncs > 0) {
		return `${resyncs} resynchronisation(s) : la source a repris apres un arret long`;
	}

	return `${stalls} arret(s) franc(s) du moteur audio, le pire de ${source.largestStallMs} ms`;
}

// --- La charge de la machine ---------------------------------------------------------------------
//
// Ces mesures repondent a la question que les compteurs de trames ne savent pas trancher : quand le
// son se degrade, est-ce le lien qui retrecit ou la machine qui n'arrive plus a suivre. Un debit qui
// tient pendant que des trous apparaissent cote encodeur designe la machine, et c'est la qu'on veut
// un chiffre plutot qu'une impression.
//
// Deux parts sont mesurees, et elles ne disent pas la meme chose. Celle du processus Node est la part
// prise par le device lui-meme ; elle doit rester basse, puisqu'il ne fait que pousser des paquets
// deja encodes. Celle de la machine entiere porte Ableton, l'encodeur et tout le reste : c'est elle
// qui monte quand un projet devient trop lourd, et c'est elle qui explique un trou.
//
// Aucune de ces mesures n'est celle d'Ableton seul. Max n'expose pas la charge de son hote a un
// script, et l'inventer serait pire que de ne rien dire.

// Ce repere garde le point de la mesure precedente : une charge est un ecart entre deux releves, pas
// une valeur qui se lit. Il part du demarrage du device, donc le premier releve couvre l'attente.
let cpuMark = { at: Date.now(), process: process.cpuUsage(), system: systemCpu() };

// Cette fonction additionne les temps de tous les coeurs depuis le demarrage du systeme.
function systemCpu() {
	return os.cpus().reduce(
		(total, cpu) => {
			const busy = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
			return { busy: total.busy + busy, total: total.total + busy + cpu.times.idle };
		},
		{ busy: 0, total: 0 }
	);
}

// Cette fonction ecrit la charge depuis le releve precedent, et repose le repere.
//
// La part du processus est rapportee a un seul coeur : c'est la convention de tous les moniteurs
// systeme, et elle laisse voir un device qui saturerait son propre fil d'execution. La part de la
// machine, elle, est rapportee a tous les coeurs — c'est le chiffre que montre le gestionnaire des
// taches, donc celui qu'on peut comparer a ce qu'on a sous les yeux.
function machineLine(at) {
	const spent = process.cpuUsage(cpuMark.process);
	const system = systemCpu();
	const elapsedUs = (at - cpuMark.at) * 1000;
	const busy = system.busy - cpuMark.system.busy;
	const ticks = system.total - cpuMark.system.total;

	cpuMark = { at, process: process.cpuUsage(), system };

	const own = elapsedUs > 0 ? ((spent.user + spent.system) / elapsedUs) * 100 : 0;
	const whole = ticks > 0 ? (busy / ticks) * 100 : 0;
	const memory = Math.round(process.memoryUsage().rss / (1024 * 1024));

	return `cpu ${Math.round(own)}% device, ${Math.round(whole)}% machine, ${memory} Mo`;
}

// Cette fonction ecrit une duree en minutes et secondes plutot qu'en secondes seules : « 4 min 12 s »
// se lit, « 252 s » se calcule.
function duration(seconds) {
	if (seconds < 60) {
		return `${seconds} s`;
	}

	return `${Math.floor(seconds / 60)} min ${pad(seconds % 60)} s`;
}

function pad(value) {
	return String(value).padStart(2, "0");
}

// Ce battement suit un direct sans jamais toucher au chemin de l'audio.
const watcher = setInterval(() => {
	const at = Date.now();
	const live = publisher.state === "LIVE";

	if (!live) {
		if (watch.since !== 0) {
			endWatch(at);
		}
		return;
	}

	if (watch.since === 0) {
		startWatch(at);
		return;
	}

	// Une rafale d'abandons est le signal le plus utile du journal : c'est le moment exact ou des
	// auditeurs ont entendu un trou. Elle est datee a la seconde, et regroupee pour ne pas noyer le
	// reste.
	const dropped = publisher.stats.framesDropped - watch.seenDrops;
	if (dropped > 0 && at - watch.lastDrop >= WATCH_DROP_MS) {
		watch.seenDrops = publisher.stats.framesDropped;
		watch.lastDrop = at;
		journal.record("perte", `${dropped} trames jetees, retard ${Math.round(publisher.oldestPendingMs())} ms`);
	}

	if (at - watch.reported >= WATCH_REPORT_MS) {
		watch.reported = at;
		reportWatch(at);
	}
}, WATCH_TICK_MS);

// Ce minuteur ne doit pas retenir le processus quand Max ferme le device.
if (typeof watcher.unref === "function") {
	watcher.unref();
}

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
		// La version part une seule fois, a l'ouverture du device : elle ne change pas tant que le
		// script tourne, et l'onglet Reglages la garde affichee.
		send("version", readVersion());
		// Cette premiere ligne date l'ouverture du device et nomme ce qui tourne : sans elle, un
		// journal colle ne dirait pas de quelle version ni de quel demarrage il parle.
		journal.record("demarrage", `${readVersion()}, pont sur le port ${port}`);
		publishBridgeStatus("stopped", "aucun encodeur connecte");
		// L'etat de la configuration part sans attendre de question : le device montre des
		// l'ouverture s'il manque une adresse ou un token, avant tout clic sur Lancer.
		publishConfig();
	})
	.catch((error) => {
		publishBridgeStatus("error", error.message);
		journal.record("erreur", `pont loopback impossible : ${error.message}`);
	});
