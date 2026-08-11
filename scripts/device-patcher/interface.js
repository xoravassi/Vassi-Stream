// Ce module decrit ce que Vassi voit dans Ableton.
//
// Le device tient dans une bande de 320 pixels de large. La hauteur, elle, ne se choisit pas :
// Live donne 169 pixels a tous les devices. Toutes les positions sont des nombres entiers, comme
// le demandent les recommandations d'Ableton : une demi-position rend les bords flous.
//
// Les tailles des objets ne sont pas choisies non plus. Ce sont celles des prototypes livres avec
// Max, dans `resources/object-prototypes/m4l` : un `live.menu` fait 15 pixels de haut, un
// `live.tab` en fait 17, un bouton en fait 17. Reprendre ces tailles est la moitie du travail pour
// qu'un device se fonde dans Live ; un bouton de 20 pixels se voit tout de suite a cote d'un
// bouton d'Ableton.
//
// Toutes les couleurs viennent de `PALETTE`, dans `parts.js` : c'est la palette fixe, presque
// noire, que Vassi a choisie pour se rapprocher du rendu de Wavetable plutot que de suivre le
// theme de Live. Le detail de cette decision et la source de chaque couleur sont dans
// `docs/device-max.md` et dans le commentaire au-dessus de `PALETTE`.
//
// L'apparence par defaut de `live.tab` et `live.menu` dessine chaque position comme un bouton
// separe : c'est ce qui donnait au device un air de « deux boutons » plutot que d'onglets. Le mode
// LCD (`appearance: 1` pour `live.tab`/`live.menu`, `appearance: 2` pour `live.text`) est celui
// que le patch d'aide officiel de Max nomme lui-meme « LCD mode » : une barre plate, l'item actif
// en surbrillance. C'est ce mode qui est utilise partout dans ce fichier.
import { control, enumParameter, HIDDEN, PALETTE, STORED_ONLY } from "./parts.js";

export const DEVICE_WIDTH = 320;
// Live n'accorde pas un pixel de plus, quel que soit le device.
export const DEVICE_HEIGHT = 169;

// Les marges sont egales a gauche et a droite, comme le demandent les recommandations d'Ableton.
const MARGIN = 8;
const CONTENT_WIDTH = DEVICE_WIDTH - MARGIN * 2;

// Les tailles de texte du device.
//
// Dix pixels est la taille de Live : sur les 78 devices Max for Live livres avec Live 11, les
// libelles sont en 10 dans 453 cas contre 122 en 9, et toutes les commandes sans exception. La
// valeur qu'on lit d'abord — ici l'etat du direct — est la seule a monter plus haut.
const LABEL_SIZE = 10;
// Largeur reservee a la version, a droite de la ligne d'etat de l'encodeur. Elle tient la forme la
// plus longue que `stamp-version.js` produit — `v0.1.0 · build 9999+` — et laisse a la ligne d'etat
// les deux tiers de la largeur, dont elle a besoin : ses phrases sont plus longues.
const VERSION_WIDTH = 100;
const STATE_SIZE = 16;

// Un libelle occupe sa police plus huit pixels. Cette regle se lit dans les memes 78 devices, sans
// une exception : 10 points dans 18 pixels (449 fois), 9 dans 17 (122), 8 dans 15, 11 dans 19, 12
// dans 20, 16 dans 24. Une boite plus courte rogne le texte, et c'est invisible tant qu'on relit
// des coordonnees au lieu de regarder le device.
function textBox(fontsize) {
	return fontsize + 8;
}

// Ces valeurs sont les positions des deux menus, dans l'ordre attendu par le script Node : c'est
// le numero de la position qui part, jamais son texte.
export const QUALITY_VALUES = ["Stable 128", "Haute 192", "Studio 256"];
// L'ordre de ces positions est fige. Live enregistre avec le morceau le numero de la position
// choisie, pas son texte : une valeur glissee entre deux autres decalerait toutes les suivantes et
// changerait le reglage des projets deja enregistres. Une position nouvelle se pose donc a la fin.
export const LATENCY_VALUES = ["Faible 200 ms", "Équilibrée 400 ms", "Stable 800 ms", "Longue 1500 ms"];
// Studio et Equilibree sont les valeurs par defaut fixees par la roadmap.
const QUALITY_INITIAL = 2;
const LATENCY_INITIAL = 1;

// Les trois pages du device, dans l'ordre ou elles s'affichent dans les onglets.
export const PAGE_VALUES = ["Direct", "Réglages", "Journal"];

// Le journal montre ses cinq dernieres lignes, la plus recente en haut.
//
// Cinq est ce que la page peut afficher entre le trait du haut et la rangee de boutons, sans serrer
// les lignes au point de les rendre illisibles. C'est peu, et c'est assume : la page repond a « que
// vient-il de se passer », pas a « qu'est-il arrive pendant les deux heures du direct ». Cette
// seconde question se lit dans le journal copie ou exporte, qui garde quatre cents lignes.
const JOURNAL_ROWS = 5;
// Les lignes du journal sont en 9 points, la seule taille du device a ne pas etre en 10.
//
// C'est la seconde taille de Live — 122 des libelles des devices livres avec Live 11 l'emploient — et
// c'est ici la taille qui fait tenir la page. Cinq lignes en 10 points demanderaient 90 pixels de
// haut, et il n'en reste que 85 entre le trait du haut et la rangee de boutons. Elle gagne au
// passage une dizaine de caracteres par ligne, ce dont un journal a plus besoin que d'un point de
// police : une ligne de sante complete tient alors sans etre coupee.
const JOURNAL_SIZE = 9;
// Pas vertical d'une ligne. C'est la hauteur exacte d'une boite de 9 points, donc des lignes qui se
// suivent sans se chevaucher ni laisser de blanc.
const JOURNAL_PITCH = textBox(JOURNAL_SIZE);
// Les lignes commencent contre le trait du bandeau du haut : la page n'a pas de place a perdre.
const JOURNAL_TOP = 34;

// Cette fonction cree tous les objets visibles du device.
// Elle rend aussi la liste des noms de chaque page : la bascule s'en sert pour cacher et montrer.
export function buildInterface() {
	const boxes = [
		// --- Bandeau du haut, visible sur les trois pages -----------------------------------
		//
		// La bascule entre pages est un jeu d'onglets, pas un bouton qui change de texte : un
		// bouton demande de deviner ou il mene, alors que les onglets montrent toutes les pages
		// et celle qui est ouverte. C'est aussi la facon dont Live presente ses propres sections.
		//
		// La barre fait 180 pixels pour trois onglets : `live.tab` partage sa largeur a parts
		// egales, et soixante pixels par onglet tiennent « Réglages », le libelle le plus long,
		// avec la meme marge que les deux autres.
		//
		// `livemode` cale les marges internes sur celles de Live : sans lui, les onglets sont
		// legerement plus larges que ceux des devices d'Ableton poses juste a cote.
		control("page-tabs", "live.tab", {
			at: [40, 20, 180, 17],
			shows: [MARGIN, 4, 180, 17],
			outlets: 3,
			outletTypes: ["", "", "float"],
			attributes: {
				livemode: 1,
				appearance: 1,
				lcdbgcolor: PALETTE.bg,
				lcdcolor: PALETTE.accent,
				textcolor: PALETTE.textDim,
				textoncolor: PALETTE.onAccent,
				bordercolor: PALETTE.divider,
				...enumParameter({
					shortName: "Page",
					longName: "Page",
					values: PAGE_VALUES,
					initial: 0,
					// La page ouverte ne regarde pas le morceau : elle ne s'enregistre pas et
					// n'apparait pas dans la liste des parametres automatisables.
					visibility: HIDDEN
				})
			}
		}),
		rule("head-rule", [40, 50, 160, 8], [MARGIN, 26, CONTENT_WIDTH, 8]),

		// --- Defilement du journal, dans la place libre a droite des onglets --------------------
		//
		// Ces trois objets appartiennent a la page du journal et n'apparaissent qu'avec elle. Ils
		// sont poses dans le bandeau du haut parce que c'est le seul endroit ou il reste de la
		// place : la page elle-meme est pleine, du trait du haut jusqu'a sa rangee de boutons.
		//
		// Le journal ne defile pas au sens d'une barre de defilement : Max n'a pas d'objet de texte
		// defilant qui suive le theme de Live, et en fabriquer un demanderait de faire passer des
		// retours a la ligne dans un symbole Max. Deux boutons qui font glisser la fenetre de cinq
		// lignes donnent la meme chose — atteindre n'importe laquelle des quatre cents lignes
		// gardees — sans rien inventer, et la position affichee dit toujours ou l'on se trouve.
		button("journal-up", "Haut", [940, 220, 60, 15], [190, 5, 30, 15], "JournalHaut"),
		button("journal-down", "Bas", [1010, 220, 60, 15], [222, 5, 30, 15], "JournalBas"),
		// Ce compteur est aligne a droite : il change de largeur a chaque pression, et un texte
		// cale a gauche danserait sous le curseur.
		rightLabel("journal-position", "", [1080, 220, 90, 18], [254, 5, 58, textBox(LABEL_SIZE)]),

		// --- Page du direct : la bande d'affichage --------------------------------------------
		//
		// Wavetable et EQ Eight sont batis pareil : un ecran occupe le haut du device, une bande
		// de commandes serrees tient le bas. L'ecran porte ce qu'on regarde, la bande porte ce
		// qu'on touche. Melanger les deux dans des colonnes de meme poids ne laisserait rien
		// attirer l'oeil en premier.
		//
		// Le device n'emploie aucun objet d'ecran de Max : la bande est delimitee par deux traits
		// et contient ce qu'un direct donne a lire — l'etat en gros, son detail, et le niveau qui
		// part vraiment.
		label("state-label", "Arrêté", [340, 20, 200, 24], [MARGIN, 44, 200, textBox(STATE_SIZE)], STATE_SIZE, false),
		label("state-detail", "device prêt", [340, 50, 250, 18], [MARGIN, 72, 250, textBox(LABEL_SIZE)], LABEL_SIZE),
		// Les deux vumetres ne servent aucun reglage : ils repondent a la seule question qu'on se
		// pose devant un device de diffusion muet — est-ce que du son arrive jusqu'ici. Ils sont
		// branches sur l'entree, avant l'encodeur, et ne modifient rien.
		// Cinquante-quatre pixels est la hauteur d'un vumetre dans Live : 62 des 68 vumetres des
		// devices livres avec Live 11 la reprennent telle quelle.
		meter("meter-left", [560, 20, 14, 60], [288, 40, 10, 54]),
		meter("meter-right", [580, 20, 14, 60], [302, 40, 10, 54]),
		rule("band-rule", [340, 80, 160, 8], [MARGIN, 96, CONTENT_WIDTH, 8]),

		// --- Page du direct : la bande de commandes -------------------------------------------
		//
		// Les trois commandes tiennent sur une ligne, a la meme hauteur, chacune sous son libelle.
		// C'est la disposition de la bande basse d'EQ Eight, et elle vaut mieux qu'un gros bouton
		// isole : les trois choses qu'on regle sont les trois choses qu'on voit.
		title("live-title", "Diffusion", [340, 110, 84, 18], [MARGIN, 104, 84, textBox(LABEL_SIZE)]),
		title("quality-label", "Qualité", [440, 110, 88, 18], [100, 104, 88, textBox(LABEL_SIZE)]),
		title("latency-label", "Latence", [540, 110, 116, 18], [196, 104, 116, textBox(LABEL_SIZE)]),

		// Le bouton du direct est un `live.text` en mode interrupteur, dessine en style LCD.
		// Il garde la hauteur des autres commandes : dans Live, un interrupteur ne depasse pas
		// d'une bande, c'est son fond sombre qui le distingue.
		//
		// `outputmode 1` fait sortir la valeur au relachement du bouton, comme les commandes de
		// Live : un clic parti par erreur peut encore etre annule en glissant hors du bouton.
		control("start-toggle", "live.text", {
			at: [340, 132, 84, 15],
			shows: [MARGIN, 124, 84, 15],
			outlets: 2,
			outletTypes: ["", ""],
			attributes: {
				mode: 1,
				outputmode: 1,
				appearance: 2,
				lcdbgcolor: PALETTE.bg,
				lcdcolor: PALETTE.accent,
				textcolor: PALETTE.textDim,
				textoncolor: PALETTE.onAccent,
				fontsize: LABEL_SIZE,
				text: "LANCER",
				texton: "ARRÊTER",
				automation: "Arrete",
				automationon: "Direct",
				...enumParameter({
					shortName: "Direct",
					longName: "Direct",
					values: ["Arrete", "Direct"],
					initial: 0,
					// Rouvrir un projet ne doit jamais relancer un direct tout seul. Trois choses
					// l'empechent : le parametre est cache donc Live ne le garde pas, sa position
					// de depart est « arrete », et l'ouverture du device lui renvoie `set 0`, qui
					// repose le bouton sans rien emettre. Voir `wiring.js`.
					visibility: HIDDEN
				})
			}
		}),

		// Les deux reglages sont des menus, pas des boutons rotatifs.
		//
		// C'est ce que Live pose devant un choix nomme : un bouton rotatif sert a parcourir une
		// plage, pas a designer une position parmi trois ou quatre. « Équilibrée 400 ms » ne
		// tiendrait d'ailleurs pas dans les 44 pixels d'un dial d'Ableton.
		choice("quality-menu", [440, 132, 88, 15], [100, 124, 88, 15], {
			shortName: "Qualite",
			longName: "Qualite",
			values: QUALITY_VALUES,
			initial: QUALITY_INITIAL
		}),
		choice("latency-menu", [540, 132, 116, 15], [196, 124, 116, 15], {
			shortName: "Latence",
			longName: "Latence",
			values: LATENCY_VALUES,
			initial: LATENCY_INITIAL
		}),

		// --- Page des reglages ----------------------------------------------------------------
		//
		// Les deux champs occupent la place de la bande d'affichage, les deux boutons celle de la
		// bande de commandes : les deux pages posent leurs reperes aux memes hauteurs.
		label("url-label", "Relais", [620, 40, 52, 18], [MARGIN, 40, 52, textBox(LABEL_SIZE)], LABEL_SIZE),
		field("url-field", [620, 60, 248, 18], [64, 40, 248, 18]),
		label("token-label", "Token", [620, 85, 52, 18], [MARGIN, 62, 52, textBox(LABEL_SIZE)], LABEL_SIZE),
		field("token-field", [620, 105, 248, 18], [64, 62, 248, 18]),
		button("save-button", "Enregistrer", [620, 130, 120, 15], [64, 86, 120, 15], "Enregistrer"),
		button("check-button", "Tester le relais", [750, 130, 120, 15], [192, 86, 120, 15], "Tester"),
		label("relay-line", "relais non testé", [620, 155, 250, 18], [MARGIN, 103, CONTENT_WIDTH, textBox(LABEL_SIZE)], LABEL_SIZE),
		// Cette ligne partage sa hauteur avec la version : l'etat de l'encodeur tient a gauche, la
		// version se range a droite. La page des reglages n'a plus de ligne libre sous celle-ci, et
		// une version merite moins de place qu'un etat.
		label("bridge-line", "encodeur en attente", [620, 175, 250, 18], [MARGIN, 121, CONTENT_WIDTH - VERSION_WIDTH, textBox(LABEL_SIZE)], LABEL_SIZE),
		// La version repond a la question qu'on se pose devant un device qui semble ne pas avoir
		// change : est-ce bien la derniere installation qui tourne. Alignee a droite, elle se lit
		// apres les deux lignes d'etat qui la precedent — c'est une reference qu'on va chercher, pas
		// une information qu'on suit.
		rightLabel("version-line", "version inconnue", [620, 195, 250, 18], [
			MARGIN + CONTENT_WIDTH - VERSION_WIDTH,
			121,
			VERSION_WIDTH,
			textBox(LABEL_SIZE)
		]),

		// --- Page du journal --------------------------------------------------------------------
		//
		// Cette page repond a la question qu'on se pose quand le direct s'est mal passe : qu'est-ce
		// qui a lache, et a quelle heure. Elle existe parce que la fenetre Max ne repond pas a
		// cette question : elle n'est pas ouverte pendant un direct et ne survit pas a la
		// fermeture de Live.
		//
		// Les lignes sont des libelles ordinaires, un par ligne, et non un champ de texte a plusieurs
		// lignes : Max n'a pas d'objet de texte defilant qui suive le theme de Live, et un `textedit`
		// demanderait de faire passer des retours a la ligne dans un symbole Max. Cinq libelles poses
		// les uns sous les autres ne peuvent pas se tromper, et le journal complet — quatre cents
		// lignes — part de toute facon par les boutons du bas.
		...journalRows(),

		// Les trois boutons sont a la place des commandes des deux autres pages, a la meme hauteur :
		// les trois pages posent leurs reperes aux memes endroits.
		//
		// Copier est le premier parce que c'est le geste attendu : le journal part dans un message.
		// Exporter est la pour ce que le presse-papiers ne sait pas faire — garder une trace, et
		// comparer un incident a celui d'avant. Vider sert avant un essai.
		button("journal-copy", "Copier", [940, 180, 120, 15], [MARGIN, 122, 98, 15], "Copier"),
		button("journal-export", "Exporter", [1080, 180, 120, 15], [111, 122, 98, 15], "Exporter"),
		button("journal-clear", "Vider", [1220, 180, 120, 15], [214, 122, 98, 15], "Vider"),

		// --- Bandeau du bas, visible sur les trois pages ------------------------------------
		//
		// L'adresse du relais reste sous les yeux pendant un direct : c'est la seule ligne qui
		// dit vers ou part le son, et elle repond sans changer de page.
		rule("foot-rule", [40, 100, 160, 8], [MARGIN, 139, CONTENT_WIDTH, 8]),
		label("config-line", "configuration inconnue", [40, 120, 250, 18], [MARGIN, 147, CONTENT_WIDTH, textBox(LABEL_SIZE)], LABEL_SIZE)
	];

	return {
		boxes,
		// Ces listes ne contiennent ni les onglets, ni les deux bandeaux : ils appartiennent aux
		// trois pages.
		livePage: [
			"state-label",
			"state-detail",
			"meter-left",
			"meter-right",
			"band-rule",
			"live-title",
			"start-toggle",
			"quality-label",
			"quality-menu",
			"latency-label",
			"latency-menu"
		],
		settingsPage: [
			"url-label",
			"url-field",
			"token-label",
			"token-field",
			"save-button",
			"check-button",
			"relay-line",
			"bridge-line",
			"version-line"
		],
		journalPage: journalRowNames().concat([
			"journal-copy",
			"journal-export",
			"journal-clear",
			"journal-up",
			"journal-down",
			"journal-position"
		])
	};
}

// Cette fonction cree les cinq libelles du journal, du plus recent au plus ancien.
//
// La premiere ligne est en couleur de texte principale, les suivantes en couleur secondaire. C'est
// la meme hierarchie que sur la page du direct : ce qu'on lit d'abord se distingue de son contexte,
// et ici la ligne du haut est toujours ce qui vient d'arriver.
function journalRows() {
	return journalRowNames().map((name, index) =>
		label(
			name,
			index === 0 ? "journal vide" : " ",
			[940, 20 + index * 30, 250, 18],
			[MARGIN, JOURNAL_TOP + index * JOURNAL_PITCH, CONTENT_WIDTH, JOURNAL_PITCH],
			JOURNAL_SIZE,
			index > 0
		)
	);
}

function journalRowNames() {
	return Array.from({ length: JOURNAL_ROWS }, (_, index) => `journal-line-${index}`);
}

// Cette fonction cree un libelle aligne a droite.
//
// `justification: 2` range le texte contre le bord droit de sa boite. Sans lui, un texte plus court
// que sa boite flotterait au milieu et paraitrait mal pose a cote de ce qui le precede. Deux
// libelles s'en servent : la version, qui se lit apres les deux lignes d'etat de la page de
// reglages, et la position dans le journal, dont la largeur change a chaque pression.
function rightLabel(id, text, at, shows) {
  return control(id, "live.comment", {
    at,
    shows,
    outlets: 0,
    attributes: {
      text,
      fontsize: LABEL_SIZE,
      textcolor: PALETTE.textDim,
      justification: 2
    }
  });
}

// Cette fonction cree un libelle.
//
// `dim` distingue la seule lecture principale de l'ecran (l'etat du direct) de tout le reste :
// c'est la hierarchie qu'un ecran de device Ableton pose d'habitude entre une grande valeur et ses
// legendes. `dim` vaut vrai par defaut ; seul l'etat du direct le met a faux.
function label(id, text, at, shows, fontsize, dim = true) {
	return control(id, "live.comment", {
		at,
		shows,
		outlets: 0,
		attributes: { text, fontsize, textcolor: dim ? PALETTE.textDim : PALETTE.text }
	});
}

// Cette fonction cree le libelle pose au-dessus d'une commande, comme Live en pose un au-dessus
// de chaque reglage. C'est un libelle comme un autre ; sa place au-dessus fait tout le travail.
function title(id, text, at, shows) {
	return label(id, text, at, shows, LABEL_SIZE);
}

// Cette fonction cree un menu deroulant a positions nommees, enregistre avec le morceau.
//
// Le nom long identifie le reglage dans le fichier `.als` : le changer ferait perdre sa valeur a
// tout projet deja enregistre, donc il est fixe une fois pour toutes. Le mode LCD (`appearance: 1`) est
// celui du patch d'aide officiel de Max ; sans lui, le menu se dessine dans son style par defaut,
// qui detonne a cote du reste de l'ecran.
function choice(id, at, shows, parameter) {
	return control(id, "live.menu", {
		at,
		shows,
		outlets: 3,
		outletTypes: ["", "", "float"],
		attributes: {
			fontsize: LABEL_SIZE,
			appearance: 1,
			lcdbgcolor: PALETTE.bg,
			textcolor: PALETTE.text,
			bordercolor: PALETTE.divider,
			...enumParameter({ ...parameter, visibility: STORED_ONLY })
		}
	});
}

// Cette fonction cree un trait de separation.
//
// `live.line` dessine sa barre dans le sens de sa plus grande dimension et la centre quand
// `justification` vaut 1 : un rectangle de 8 pixels de haut pose son trait 4 pixels plus bas.
function rule(id, at, shows) {
	return control(id, "live.line", {
		at,
		shows,
		inlets: 1,
		outlets: 0,
		attributes: { justification: 1, linecolor: PALETTE.divider }
	});
}

// Cette fonction cree un bouton qui envoie un bang au clic, sans etat a retenir.
//
// **Un bouton `live.text` doit etre un parametre Live, sinon il ne sort rien.** C'est le defaut qui
// laissait les deux boutons de la page de reglages sans effet dans Ableton. La page de reference de
// `live.text` le dit a l'attribut `transition` : « The parameter automation of live.text stores 0
// and 1 values. The transition attribute specifies when a bang will be sent to the outlet. » Le
// bang d'un clic nait donc de la transition 0 -> 1 du parametre ; sans parametre, il n'y a pas de
// transition, donc pas de bang. Le releve le confirme : sur les 411 objets `live.*` des devices
// livres avec Live, aucun n'a `parameter_enable` a 0.
//
// La visibilite est « cache » : les recommandations de production d'Ableton la demandent
// explicitement pour un `live.text` en mode bouton, pour qu'un clic n'entre pas dans l'historique
// d'annulation de Live. Rien n'est donc enregistre avec le morceau, ce qui etait deja l'intention.
//
// `outputmode` n'est pas pose. La page de reference le limite au mode interrupteur — « Sets the
// output mode for the live.text object when it's mode attribute is set to 1 (toggle) » — et aucun
// des 138 boutons `live.text` livres avec Live ne le pose. Le bouton du direct, lui, est un
// interrupteur : il garde `outputmode 1`, la ou l'attribut agit vraiment.
//
// `texton` reprend le meme texte que `text` : en mode bouton, l'objet passe par l'etat « allume »
// le temps du clic, et il y afficherait sinon le libelle par defaut de Max.
//
// `lcdcolor` donne au libelle sa couleur en mode LCD — c'est `lcdcolor` qui peint le texte a
// l'arret, et le fond pendant le clic. Sans lui, les deux boutons prenaient l'orange par defaut de
// Max au milieu d'un device gris.
function button(id, text, at, shows, name) {
	return control(id, "live.text", {
		at,
		shows,
		outlets: 2,
		outletTypes: ["", ""],
		attributes: {
			mode: 0,
			appearance: 2,
			lcdbgcolor: PALETTE.bg,
			lcdcolor: PALETTE.text,
			textcolor: PALETTE.text,
			fontsize: LABEL_SIZE,
			text,
			texton: text,
			...enumParameter({
				shortName: name,
				longName: name,
				values: ["Repos", "Clic"],
				initial: 0,
				visibility: HIDDEN
			})
		}
	});
}

// Cette fonction cree un vumetre. Il n'a pas de sortie utile ici : rien dans le device ne lit le
// niveau, il se contente de le montrer.
function meter(id, at, shows) {
	return control(id, "live.meter~", {
		at,
		shows,
		inlets: 1,
		outlets: 2,
		outletTypes: ["float", "int"],
		attributes: { bgcolor: PALETTE.bg }
	});
}

// Cette fonction cree un champ de saisie.
//
// C'est le seul objet du device qui ne soit pas un objet `live.*` : Max n'offre aucun champ de
// texte qui suive le theme de Live. Les deux champs vivent donc sur la page de reglages, ouverte
// le temps d'un collage, et jamais sur la bande visible pendant un direct.
//
// Le contenu tape n'est jamais enregistre : `textedit` n'a pas d'attribut sauvegarde, et il n'est
// pas un parametre Live. Le token ne peut donc pas partir dans le fichier `.als` du morceau.
//
// `textedit` n'est pas un objet `live.*` : ses couleurs viennent aussi de `PALETTE`, sinon le
// champ resterait blanc au milieu d'un device presque noir.
function field(id, at, shows) {
	return {
		box: {
			id,
			maxclass: "textedit",
			varname: id,
			numinlets: 1,
			numoutlets: 4,
			outlettype: ["", "int", "", ""],
			patching_rect: at,
			presentation: 1,
			presentation_rect: shows,
			fontsize: LABEL_SIZE,
			bgcolor: PALETTE.bg,
			textcolor: PALETTE.text,
			bordercolor: PALETTE.divider
		}
	};
}
