// Ce module fabrique les boites et les liaisons d'un patcher Max.
//
// Un fichier `.maxpat` est un objet JSON : une liste de boites et une liste de cables. Chaque
// boite porte sa classe, sa position et le nombre d'entrees et de sorties que Max doit dessiner.
// Ces fonctions evitent de repeter ces champs a chaque objet.
//
// Les nombres d'entrees et de sorties sont ceux que Max ecrit lui-meme dans ses patchs d'aide :
// une valeur inventee ferait disparaitre des cables a l'ouverture du device.

// Cette fonction cree un objet ordinaire, celui qu'on tape dans une boite vide.
// `inlets` et `outlets` decrivent l'objet reel ; `outletTypes` sert seulement a l'affichage.
export function object(id, text, options = {}) {
	return {
		box: {
			id,
			maxclass: "newobj",
			text,
			numinlets: options.inlets ?? 1,
			numoutlets: options.outlets ?? 1,
			outlettype: options.outletTypes ?? [""],
			patching_rect: options.at ?? [0, 0, 120, 22],
			...(options.varname === undefined ? {} : { varname: options.varname })
		}
	};
}

// Cette fonction cree une boite message. Une virgule dans le texte separe deux messages successifs.
export function message(id, text, options = {}) {
	return {
		box: {
			id,
			maxclass: "message",
			text,
			numinlets: 2,
			numoutlets: 1,
			outlettype: [""],
			patching_rect: options.at ?? [0, 0, 120, 22]
		}
	};
}

// La palette fixe du device.
//
// Vassi a demande un rendu proche de Wavetable : fond presque noir, quel que soit le theme choisi
// dans les preferences de Live. Wavetable n'est pas un device Max for Live — c'est un device natif
// d'Ableton, ecrit dans son propre moteur graphique, qui reste sombre en permanence. Un device Max
// for Live ne peut suivre qu'un theme a la fois : soit celui de Live, soit un theme qui lui est
// propre. Vassi a choisi le second, en connaissance des deux options.
//
// Ces six couleurs ne sont pas choisies a l'oeil : ce sont celles qu'Ableton applique lui-meme
// dans son theme Sombre, relevees dans le fichier reel de l'application —
// `C:\ProgramData\Ableton\Live 11 Suite\Resources\Themes\03Dark.ask`. `RetroDisplayBackground` est
// la cle qu'Ableton utilise pour ses propres ecrans a l'ancienne (LCD, VU) ; c'est la valeur la
// plus proche, sourcee, du presque-noir de l'ecran de Wavetable.
//
// | Cle Ableton (03Dark.ask)        | Role dans le device                    | Valeur    |
// |----------------------------------|-----------------------------------------|-----------|
// | RetroDisplayBackground           | fond du device                          | #050505   |
// | RetroDisplayBackgroundLine       | traits de separation                    | #424242   |
// | SurfaceAreaForeground             | texte principal                         | #a0a0a0   |
// | RetroDisplayForegroundDisabled   | texte secondaire / inactif              | #808080   |
// | RetroDisplayForeground           | accent (onglet actif, LCD allume)       | #f39420   |
// | ControlOnForeground               | texte pose sur un fond accent           | #000000   |
// | ChosenRecord                     | le mot « Live » pendant un direct       | #ff4032   |
//
// `ChosenRecord` est la couleur du bouton d'enregistrement d'Ableton, celle qui dit « ca part
// vraiment » partout ailleurs dans Live. Elle est reprise ici pour la meme chose : rien d'autre
// dans le device n'est rouge, donc ce rouge ne veut dire qu'une chose.
//
// C'est la seule source de couleurs en dur du device : toute couleur ecrite ailleurs dans le code
// doit venir d'ici, jamais d'une valeur recopiee a la main.
export const PALETTE = {
	bg: [0.019608, 0.019608, 0.019608, 1],
	divider: [0.258824, 0.258824, 0.258824, 1],
	text: [0.627451, 0.627451, 0.627451, 1],
	textDim: [0.501961, 0.501961, 0.501961, 1],
	accent: [0.952941, 0.580392, 0.12549, 1],
	onAccent: [0, 0, 0, 1],
	record: [1, 0.25098, 0.196078, 1]
};

// Cette fonction ecrit une couleur de la palette dans un message Max.
//
// Une boite message ne porte que du texte : une couleur y entre sous la forme `textcolor r v b a`,
// avec quatre nombres separes par des espaces. Passer par cette fonction evite de recopier a la
// main les decimales d'une couleur, ce qui est la seule facon de faire diverger deux teintes qui
// devraient etre la meme.
export function colorMessage(attribute, color) {
	return `${attribute} ${color.join(" ")}`;
}

// Cette fonction cree un objet d'interface visible dans le device.
export function control(id, maxclass, options = {}) {
	const box = {
		id,
		maxclass,
		varname: options.varname ?? id,
		numinlets: options.inlets ?? 1,
		numoutlets: options.outlets ?? 0,
		patching_rect: options.at ?? [0, 0, 100, 20],
		presentation: 1,
		presentation_rect: options.shows,
		...(options.outletTypes === undefined ? {} : { outlettype: options.outletTypes }),
		...(options.attributes ?? {})
	};

	return { box };
}

// Ces trois valeurs sont celles du menu « Parameter Visibility » de l'inspecteur de Max.
export const STORED_AND_AUTOMATED = 0;
export const STORED_ONLY = 1;
export const HIDDEN = 2;

// Cette fonction decrit un parametre a positions nommees, tel que Live le stocke.
//
// Le nom court est celui qui s'affiche sous le bouton ; le nom long identifie le parametre dans
// le fichier de morceau. Changer un nom long apres coup ferait perdre la valeur enregistree dans
// les projets existants : ces deux noms sont donc figes.
//
// `visibility` dit ce que Live fait du parametre. « Enregistre seulement » garde la valeur avec le
// morceau sans l'exposer a l'automation ; « cache » sert aux commandes qui ne concernent que
// l'affichage, comme le choix de la page, qu'aucun morceau n'a de raison de retenir.
//
// `initial` est la position posee a l'instanciation du device. Elle compte surtout pour les
// commandes cachees : c'est elle qui garantit qu'un device rouvert repart d'un etat connu.
export function enumParameter({ shortName, longName, values, initial, visibility = STORED_ONLY }) {
	return {
		parameter_enable: 1,
		saved_attribute_attributes: {
			valueof: {
				parameter_enum: values,
				parameter_type: 2,
				parameter_unitstyle: 10,
				parameter_mmin: 0.0,
				parameter_mmax: values.length - 1,
				parameter_initial: [initial],
				parameter_initial_enable: 1,
				parameter_shortname: shortName,
				parameter_longname: longName,
				parameter_invisible: visibility,
				parameter_modmode: 0,
				parameter_modmin: 0.0,
				parameter_modmax: 127.0,
				parameter_linknames: 0,
				parameter_order: 0,
				parameter_speedlim: 0,
				parameter_steps: 0,
				parameter_exponent: 1.0,
				parameter_annotation_name: "",
				parameter_info: "",
				parameter_units: ""
			}
		}
	};
}

// Cette fonction relie une sortie a une entree. Les index commencent a zero.
export function connect(fromId, fromOutlet, toId, toInlet = 0) {
	return { patchline: { source: [fromId, fromOutlet], destination: [toId, toInlet] } };
}
