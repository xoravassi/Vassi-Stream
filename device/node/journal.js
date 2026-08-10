"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { configPath } = require("./publisher-config.js");

// Ce module tient le journal du device : les quelques centaines de dernieres lignes de ce qui s'est
// passe, gardees en memoire, montrees dans l'onglet Journal et exportables d'un clic.
//
// Il existe parce qu'un direct rate ne se rejoue pas. Quand le son s'est coupe dix secondes chez les
// auditeurs, la seule question qui compte est : est-ce que le lien montant a retreci, est-ce que le
// relais a coupe, ou est-ce que l'encodeur s'est arrete ? La fenetre Max repond a cela, mais elle
// n'est pas ouverte pendant un direct, elle ne survit pas a la fermeture de Live, et elle demande de
// savoir qu'elle existe. Un onglet dans le device, lui, est la ou Vassi regarde deja.
//
// Trois regles gouvernent ce fichier.
//
// **Aucun secret n'entre ici.** Le token de publication ne traverse jamais ce module : les appelants
// n'envoient que ce que le device affiche deja — l'adresse du relais, l'indice de quatre caracteres
// du token, des compteurs. C'est la meme regle que partout ailleurs dans le projet, et c'est celle
// qui rend un journal collable dans un message sans y penser.
//
// **Tout est ramene a l'ASCII.** Une ligne de journal traverse trois passages qui n'aiment pas les
// accents : un symbole Max, le presse-papiers de Windows (`clip` lit l'entree standard dans la page
// de codes de la console, pas en UTF-8), et un fichier ouvert dans le Bloc-notes. Les messages du
// code interne sont deja sans accents — « arrete », « connexion au relais » — et `plain` garantit le
// reste.
//
// **Rien ne s'ecrit tout seul sur le disque.** Le journal vit en memoire. Un fichier n'apparait que
// si Vassi clique sur Exporter : un device qui ecrirait en continu laisserait grossir un dossier que
// personne ne surveille, pour des lignes qu'on ne lit qu'apres un incident.

// Nombre de lignes gardees. Au-dela, les plus vieilles partent.
//
// Quatre cents lignes couvrent largement un direct : en marche normale le journal ecrit une ligne de
// sante toutes les dix secondes, soit une heure et dix minutes de direct sain, et les incidents,
// eux, sont rares et courts. C'est aussi assez petit pour tenir dans un message colle.
const CAPACITY = 400;

// Longueur maximale d'une ligne, sans l'heure ni la categorie.
//
// Le libelle du device n'en montre qu'une soixantaine de caracteres ; ce plafond-la est bien plus
// haut parce qu'il sert au fichier exporte, ou une adresse de relais complete doit tenir. Il n'est
// la que pour qu'un message venu du reseau ne puisse pas remplir le journal a lui seul.
const MAX_MESSAGE = 160;

// Largeur de la colonne de categorie. Les categories tiennent toutes dedans : `demarrage` est la
// plus longue. Les aligner rend le fichier exporte lisible en colonnes.
const CATEGORY_WIDTH = 9;

// Cette classe garde les lignes et sait les rendre, les ecrire et les copier.
//
// Elle ne connait ni Max, ni le publisher : elle recoit des couples categorie/message deja formes.
// C'est ce qui la rend verifiable sous Node, sans Ableton.
class Journal {
	constructor(options = {}) {
		this.capacity = options.capacity ?? CAPACITY;
		// Ces trois fonctions sont remplacables par les tests : une horloge figee rend les lignes
		// comparables, et un dossier temporaire evite d'ecrire dans celui de la machine.
		this.now = options.now ?? (() => new Date());
		this.folder = options.folder ?? defaultFolder;
		this.copyText = options.copyText ?? copyToClipboard;
		// Ces lignes coiffent le fichier exporte : version du device, systeme, adresse du relais.
		// Elles sont demandees au moment de l'export, jamais gardees : la version ne change pas, mais
		// la configuration, elle, peut avoir ete corrigee entre-temps.
		this.context = options.context ?? (() => []);
		this.onChange = options.onChange ?? (() => {});
		this.entries = [];
	}

	// Cette methode ajoute une ligne.
	//
	// Une ligne identique a la precedente n'en cree pas une nouvelle : elle incremente un compteur de
	// repetitions. C'est ce qui empeche un evenement qui boucle — une reconnexion qui echoue toujours
	// pour la meme raison — de chasser du journal tout ce qui l'a precede, c'est-a-dire exactement ce
	// qu'on cherchait a lire.
	record(category, message) {
		const entry = {
			time: this.now(),
			category: plain(category).slice(0, CATEGORY_WIDTH),
			message: plain(message).slice(0, MAX_MESSAGE),
			repeats: 1
		};

		const last = this.entries[this.entries.length - 1];

		if (last !== undefined && last.category === entry.category && last.message === entry.message) {
			last.repeats += 1;
			last.time = entry.time;
		} else {
			this.entries.push(entry);

			while (this.entries.length > this.capacity) {
				this.entries.shift();
			}
		}

		this.onChange();
	}

	// Cette methode rend toutes les lignes, la plus ancienne en premier : c'est l'ordre d'un fichier
	// de journal, celui dans lequel on relit une suite d'evenements.
	lines() {
		return this.entries.map((entry) => format(entry));
	}

	// Cette methode rend le nombre de lignes gardees. Le device s'en sert pour savoir jusqu'ou il peut
	// faire remonter sa fenetre, et pour afficher la position atteinte.
	get count() {
		return this.entries.length;
	}

	// Cette methode rend une fenetre de lignes, **la plus recente en premier**.
	//
	// L'ordre est inverse de celui du fichier, et c'est voulu : ce qui vient de se passer doit etre
	// sur la premiere ligne, sinon il faudrait compter les lignes vides pour savoir ou regarder.
	//
	// `offset` fait glisser la fenetre vers le passe : zero montre les dernieres lignes, cinq montre
	// les cinq d'avant. C'est ce que font les deux boutons de defilement du device.
	//
	// `width` coupe ce qui depasse de la largeur d'un libelle. Sans cette coupe, `live.comment` replie
	// une ligne trop longue sur une seconde ligne, qu'il dessine par-dessus le libelle du dessous :
	// deux lignes du journal deviennent illisibles a la fois. La coupe ne touche que l'affichage — le
	// texte copie et le fichier exporte gardent la ligne entiere, et c'est la qu'on va la relire.
	//
	// Le tableau rendu fait toujours `count` cases : les places sans ligne recoivent un espace, que
	// le device pose tel quel dans son libelle. Un symbole vide serait plus juste, mais un symbole
	// d'un espace traverse Max sans qu'on ait a se demander comment il est cite.
	recent(count, offset = 0, width = 0) {
		const rows = [];

		for (let index = 0; index < count; index += 1) {
			const entry = this.entries[this.entries.length - 1 - offset - index];
			rows.push(entry === undefined ? " " : fit(format(entry), width));
		}

		return rows;
	}

	// Cette methode rend le journal complet, tel qu'il part dans le presse-papiers ou dans un fichier.
	text() {
		const head = [`Vassi Stream - journal du device`, `exporte le ${fullStamp(this.now())}`]
			.concat(this.context().map((line) => plain(line)))
			.concat([`${this.entries.length} ligne(s)`, ""]);

		return head.concat(this.lines()).join(os.EOL) + os.EOL;
	}

	// Cette methode vide le journal. Elle sert avant une mesure : repartir d'un journal vide vaut
	// mieux que chercher ou commence l'essai en cours.
	clear() {
		this.entries = [];
		this.onChange();
	}

	// Cette methode ecrit le journal dans un fichier et rend son chemin.
	//
	// Le fichier va a cote de la configuration du publisher, dans un sous-dossier : c'est un
	// emplacement qui existe deja sur la machine, qui survit a une reinstallation du device, et qui
	// ne peut pas etre commite par accident. Le nom porte la date et l'heure, donc deux exports ne
	// s'ecrasent jamais — un incident se compare a celui d'avant.
	save() {
		const folder = this.folder();
		fs.mkdirSync(folder, { recursive: true });
		const file = path.join(folder, `journal-${fileStamp(this.now())}.log`);
		fs.writeFileSync(file, this.text(), "utf8");
		return file;
	}

	// Cette methode met le journal dans le presse-papiers. Elle ne rejette jamais sans raison
	// lisible : le device affiche ce qu'elle rend, et « copie impossible » suffit a savoir qu'il faut
	// passer par le fichier.
	copy() {
		return this.copyText(this.text());
	}
}

// Cette fonction met une ligne en forme : heure, categorie alignee, message.
//
// L'heure est locale et sans date : le journal se lit pendant ou juste apres un direct, et la date
// complete est deja en tete du fichier exporte.
function format(entry) {
	const repeat = entry.repeats > 1 ? ` (x${entry.repeats})` : "";
	return `${clock(entry.time)} ${entry.category.padEnd(CATEGORY_WIDTH)} ${entry.message}${repeat}`;
}

// Cette fonction ramene une ligne a la largeur d'un libelle du device.
//
// Les trois points finaux ne sont pas une decoration : ils disent que la ligne continue ailleurs,
// donc qu'il faut passer par Copier ou Exporter pour la lire en entier. Une ligne coupee net
// laisserait croire qu'elle finit la.
//
// Une largeur nulle ne coupe rien : c'est ce que demandent le fichier exporte et les tests, qui
// veulent la ligne telle qu'elle a ete ecrite.
function fit(line, width) {
	if (width <= 0 || line.length <= width) {
		return line;
	}

	return `${line.slice(0, width - 3)}...`;
}

function clock(date) {
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad2).join(":");
}

function fullStamp(date) {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock(date)}`;
}

// Cette fonction forme la partie datee du nom de fichier. Elle n'utilise ni deux-points ni espace :
// Windows refuse les premiers dans un nom de fichier, et les seconds compliquent un chemin colle.
function fileStamp(date) {
	return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${[
		date.getHours(),
		date.getMinutes(),
		date.getSeconds()
	]
		.map(pad2)
		.join("")}`;
}

function pad2(value) {
	return String(value).padStart(2, "0");
}

// Cette fonction ramene un texte a une seule ligne d'ASCII imprimable.
//
// La decomposition Unicode separe une lettre accentuee de son accent, que `\p{M}` — la classe des
// marques combinantes — efface ensuite : « Arrêté » devient « Arrete » plutot que « Arr?t? ». Ce qui
// reste hors de l'ASCII devient un point d'interrogation. Les passages a la ligne et les tabulations deviennent des espaces : une
// ligne de journal est une ligne, sans quoi le decompte de lignes du fichier mentirait et un libelle
// du device afficherait un retour a la ligne au milieu de sa phrase.
function plain(value) {
	return String(value)
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/\s+/g, " ")
		.replace(/[^\x20-\x7e]/g, "?")
		.trim();
}

// Cette fonction donne le dossier des journaux exportes, a cote du fichier de configuration.
function defaultFolder() {
	return path.join(path.dirname(configPath()), "journaux");
}

// Cette fonction donne la commande qui remplit le presse-papiers du systeme.
//
// Node n'a pas de presse-papiers, et Max n'expose pas le sien a un script : les trois systemes ont
// chacun un petit programme fait pour cela, qui lit son entree standard. `clip` lit dans la page de
// codes de la console, ce qui exclurait les accents — d'ou l'ASCII garanti par `plain`.
function clipboardCommand() {
	if (process.platform === "win32") {
		return { command: process.env.COMSPEC || "cmd.exe", args: ["/d", "/c", "clip"] };
	}

	if (process.platform === "darwin") {
		return { command: "pbcopy", args: [] };
	}

	return { command: "xclip", args: ["-selection", "clipboard"] };
}

// Cette fonction ecrit un texte dans le presse-papiers.
//
// Elle ne laisse aucune erreur devenir une exception non capturee : un `spawn` qui echoue, une
// entree standard fermee trop tot, un programme absent — tout ressort en promesse rejetee, que
// l'appelant transforme en ligne de journal. Le processus Node du device ne doit jamais s'arreter
// sur un clic.
function copyToClipboard(text) {
	return new Promise((resolve, reject) => {
		const { command, args } = clipboardCommand();
		let child = null;

		try {
			child = spawn(command, args, { windowsHide: true });
		} catch (error) {
			reject(error);
			return;
		}

		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`code ${code}`))));
		// Un programme de presse-papiers qui ferme son entree avant la fin du texte declencherait
		// sinon une erreur `EPIPE` sans gestionnaire, donc l'arret du processus.
		child.stdin.on("error", () => {});
		child.stdin.end(text, "utf8");
	});
}

// Cette fonction ouvre le dossier du fichier exporte dans l'explorateur du systeme, le fichier
// selectionne quand le systeme sait le faire.
//
// Elle repond a la moitie du probleme : un fichier ecrit dans `%APPDATA%` est introuvable pour qui
// ne connait pas ce dossier. Elle ne rend rien et n'echoue jamais visiblement — c'est un confort,
// pas l'export lui-meme, et le chemin reste affiche dans le journal si rien ne s'ouvre.
function reveal(file) {
	const choices = {
		win32: { command: "explorer.exe", args: [`/select,${file}`] },
		darwin: { command: "open", args: ["-R", file] }
	};
	const choice = choices[process.platform] ?? { command: "xdg-open", args: [path.dirname(file)] };

	try {
		const child = spawn(choice.command, choice.args, { windowsHide: true, detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch (error) {
		// Une machine sans explorateur de fichiers ne doit pas transformer un export reussi en echec.
	}
}

module.exports = { Journal, plain, reveal, CAPACITY };
