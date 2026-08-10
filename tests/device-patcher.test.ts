import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PALETTE } from "../scripts/device-patcher/parts.js";

// Ce nombre est le code ASCII « audi » : il dit a Live que le device est un effet audio.
// Un autre code ferait apparaitre le device dans la mauvaise categorie du navigateur d'Ableton.
const AMXD_AUDIO_EFFECT = 1633771873;

// Ce fichier verifie le device Max for Live sans ouvrir Max.
//
// Un patcher est un objet JSON : ses objets, ses cables et ses positions se lisent et se
// verifient comme n'importe quelle donnee. Ce qui suit couvre exactement ce qu'un oeil ne voit
// pas a l'ouverture : un cable qui pointe vers une sortie inexistante, un message que le script
// Node ne comprend pas, une couleur figee qui ne viendrait pas de la palette unique du device, ou
// un token qui partirait dans le fichier de morceau.
//
// Ces tests portent sur le fichier reellement livre. Ils restent donc valables apres une retouche
// faite dans Max, ce qui est le moment ou ils servent le plus.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PATCHER = JSON.parse(readFileSync(`${ROOT}patchers/vassi-stream.maxpat`, "utf8")).patcher;
// Ce nom est celui que le patcher demande a Max, et celui du fichier qui vit dans le depot : les
// deux doivent rester le meme mot, sans quoi le device demarre un script qui n'existe pas.
const NODE_ENTRY = "vassi-stream-device.js";
const NODE_SOURCE = readFileSync(`${ROOT}device/node/${NODE_ENTRY}`, "utf8");

// La hauteur d'un device Live ne se choisit pas : elle vaut 169 pixels pour tous les devices.
const DEVICE_HEIGHT = 169;

type Box = {
  id: string;
  maxclass: string;
  varname?: string;
  text?: string;
  numinlets: number;
  numoutlets: number;
  presentation?: number;
  presentation_rect?: number[];
  fontsize?: number;
  parameter_enable?: number;
  saved_attribute_attributes?: { valueof: Record<string, unknown> };
};

const boxes: Box[] = PATCHER.boxes.map((entry: { box: Box }) => entry.box);
const lines: { source: [string, number]; destination: [string, number] }[] = PATCHER.lines.map(
  (entry: { patchline: { source: [string, number]; destination: [string, number] } }) => entry.patchline,
);
const byId = new Map(boxes.map((box) => [box.id, box]));

// Cette fonction rend le texte d'un objet, vide pour les objets d'interface.
function textOf(box: Box): string {
  return typeof box.text === "string" ? box.text : "";
}

// Cette fonction rend la position d'un objet dans le device : gauche, haut, largeur, hauteur.
function rectOf(box: Box): [number, number, number, number] {
  return box.presentation_rect as [number, number, number, number];
}

// Cette fonction rend les reglages Live d'un objet : positions nommees, visibilite, valeur de
// depart. Elle rend un objet vide pour ce qui n'est pas un parametre.
function parameterOf(box: Box): Record<string, unknown> {
  return (box.saved_attribute_attributes?.valueof as Record<string, unknown>) ?? {};
}

// Cette fonction suit les cables depuis une sortie et rend les identifiants de tout ce qu'elle
// atteint, de proche en proche. Elle sert a verifier qu'un signal arrive bien la ou il faut sans
// dependre du chemin exact : ajouter un objet intermediaire ne casse pas le test.
//
// Un message `set ...` arrete la marche. C'est toute la raison d'etre de ce mot dans Max : il pose
// une valeur sur une commande sans la lui faire renvoyer. Une marche qui le traverserait ferait
// croire qu'un bouton repose par le device previent le script Node, c'est-a-dire l'inverse de ce
// que le device fait.
function reachedFrom(id: string, outlet: number): string[] {
  const seen: string[] = [];
  const queue = lines.filter((line) => line.source[0] === id && line.source[1] === outlet);

  while (queue.length > 0) {
    const line = queue.shift()!;
    const source = byId.get(line.source[0]);
    const target = byId.get(line.destination[0]);
    if (target === undefined || seen.includes(target.id)) {
      continue;
    }

    seen.push(target.id);
    if (source !== undefined && /^set(\s|$)/.test(textOf(source))) {
      continue;
    }

    queue.push(...lines.filter((next) => next.source[0] === target.id));
  }

  return seen;
}

// Ce test verifie que chaque cable relie deux objets qui existent, sur des prises qui existent.
// Max supprime silencieusement un cable impossible : le device s'ouvrirait sans erreur et sans
// fonctionner.
test("chaque cable relie des prises reelles", () => {
  for (const line of lines) {
    const source = byId.get(line.source[0]);
    const destination = byId.get(line.destination[0]);

    assert.ok(source, `objet source inconnu : ${line.source[0]}`);
    assert.ok(destination, `objet destination inconnu : ${line.destination[0]}`);
    assert.ok(
      line.source[1] < source.numoutlets,
      `${line.source[0]} n'a pas de sortie ${line.source[1]}`,
    );
    assert.ok(
      line.destination[1] < destination.numinlets,
      `${line.destination[0]} n'a pas d'entree ${line.destination[1]}`,
    );
  }
});

// Ce test verifie l'unicite des identifiants et des noms. Un doublon de nom rendrait la bascule
// entre les deux pages imprevisible : `script show` designe un objet par son nom.
test("les identifiants et les noms sont uniques", () => {
  const ids = boxes.map((box) => box.id);
  const names = boxes.map((box) => box.varname).filter((name): name is string => name !== undefined);

  assert.equal(new Set(ids).size, ids.length, "deux objets portent le meme identifiant");
  assert.equal(new Set(names).size, names.length, "deux objets portent le meme nom");
});

// Ce test verifie que toute couleur figee dans le device vient de `PALETTE`.
//
// Le device ne suit plus le theme d'Ableton pour ses couleurs : Vassi a choisi un fond presque
// noir, fixe, proche de celui de Wavetable (voir `docs/device-max.md`). La regle n'est donc plus
// « aucune couleur », mais « une seule palette, documentee, jamais une valeur recopiee a la main ».
const PALETTE_VALUES = new Set(Object.values(PALETTE).map((rgba) => JSON.stringify(rgba)));

test("toute couleur figee dans le device vient de la palette", () => {
  const foreign: string[] = [];

  for (const box of boxes) {
    for (const [key, value] of Object.entries(box)) {
      if (key.toLowerCase().includes("color") && !PALETTE_VALUES.has(JSON.stringify(value))) {
        foreign.push(`${box.id}.${key}`);
      }
    }
  }

  assert.deepEqual(foreign, [], "une couleur hors palette echapperait a la seule source de verite");
  assert.deepEqual(PATCHER.bgcolor, PALETTE.bg, "le fond du device doit venir de PALETTE.bg");
});

// Ce test verifie que les onglets, les menus et les boutons sont en mode LCD.
//
// Sans lui, `live.tab` et `live.menu` dessinent chaque position comme un bouton separe, ce qui
// donnait au device un air de « deux boutons » plutot que d'onglets (voir `docs/device-max.md`).
test("les onglets, les menus et les boutons sont en mode LCD", () => {
  const withAppearance = (maxclass: string) => boxes.filter((box) => box.maxclass === maxclass);

  for (const box of [...withAppearance("live.tab"), ...withAppearance("live.menu")]) {
    assert.equal((box as unknown as Record<string, unknown>).appearance, 1, `${box.varname} n'est pas en mode LCD`);
  }

  for (const box of withAppearance("live.text")) {
    assert.equal((box as unknown as Record<string, unknown>).appearance, 2, `${box.varname} n'est pas en mode LCD`);
  }
});

// Ces trois classes sont les commandes du device : ce qui repond a un clic. Les autres objets
// `live.*` ne font qu'afficher — un libelle, un trait, un vumetre — et ne sont pas des parametres.
const COMMANDS = ["live.tab", "live.menu", "live.text"];

// Ce test verifie que chaque commande du device est un parametre Live.
//
// C'est le defaut qui a laisse les deux boutons de la page de reglages sans effet a la premiere
// ouverture dans Ableton : ils etaient poses avec `parameter_enable` a 0. Le bang d'un `live.text`
// en mode bouton nait de la transition 0 -> 1 de son parametre — la page de reference de Max le dit
// a l'attribut `transition` — donc un bouton sans parametre ne sort rien du tout. Rien ne le
// signale : ni erreur, ni cable manquant, ni objet mal place, et les tests de cablage passaient.
//
// Le releve des devices livres avec Live dit la meme chose autrement : sur leurs 411 objets
// `live.*`, aucun n'a `parameter_enable` a 0.
//
// Le nom long identifie le parametre dans le fichier de morceau ; deux commandes qui le partagent
// deviennent une seule aux yeux de Live.
test("chaque commande du device est un parametre Live", () => {
  const commands = boxes.filter((box) => COMMANDS.includes(box.maxclass));

  assert.ok(commands.length >= 5, "le device doit porter des commandes");

  const longNames: string[] = [];
  for (const box of commands) {
    assert.equal(box.parameter_enable, 1, `${box.varname} ne sortirait rien au clic`);

    const longName = String(parameterOf(box).parameter_longname ?? "");
    assert.notEqual(longName, "", `${box.varname} n'a pas de nom long`);
    longNames.push(longName);
  }

  assert.equal(new Set(longNames).size, longNames.length, "deux commandes portent le meme nom long");
});

// Ce test verifie les deux boutons de la page de reglages.
//
// Un bouton n'a pas d'etat a retenir : son parametre est cache, comme le demandent les
// recommandations de production d'Ableton, pour qu'un clic n'entre pas dans l'historique
// d'annulation de Live et ne parte pas avec le morceau.
//
// `outputmode` ne doit pas etre pose : la page de reference le limite au mode interrupteur, et
// aucun des 138 boutons `live.text` livres avec Live ne le pose. `texton` reprend le libelle, sinon
// l'objet affiche le texte par defaut de Max le temps du clic.
test("les deux boutons de la page de reglages sont des boutons sans etat", () => {
  for (const id of ["save-button", "check-button"]) {
    const button = byId.get(id);

    assert.ok(button, `${id} manque`);
    assert.equal(button.maxclass, "live.text");

    const attributes = button as unknown as Record<string, unknown>;
    assert.equal(attributes.mode, 0, `${id} doit etre en mode bouton`);
    assert.equal(attributes.outputmode, undefined, `${id} ne doit pas poser outputmode`);
    assert.equal(attributes.texton, attributes.text, `${id} changerait de libelle pendant le clic`);

    const parameter = parameterOf(button);
    assert.equal(parameter.parameter_invisible, 2, `${id} doit rester cache de Live`);
    assert.deepEqual(parameter.parameter_initial, [0], `${id} doit demarrer au repos`);

    // Un clic doit atteindre le script Node, sans quoi le bouton ne fait rien de visible.
    assert.ok(reachedFrom(id, 0).includes("node"), `${id} n'atteint pas le script Node`);
  }
});

// Ce test verifie la forme du device : presentation a l'ouverture, largeur fixee, et objets
// entierement contenus dans la surface que Live accorde.
test("le device tient dans la surface accordee par Live", () => {
  assert.equal(PATCHER.openinpresentation, 1, "le device doit s'ouvrir sur sa presentation");
  assert.equal(PATCHER.devicewidth, 320);

  for (const box of boxes) {
    if (box.presentation !== 1) {
      continue;
    }

    const rect = box.presentation_rect;
    assert.ok(Array.isArray(rect) && rect.length === 4, `${box.id} est presente sans position`);

    const [left, top, width, height] = rect as [number, number, number, number];

    for (const value of rect) {
      assert.equal(Number.isInteger(value), true, `${box.id} a une position a virgule : ${value}`);
    }

    assert.ok(left >= 0 && top >= 0, `${box.id} sort par le haut ou par la gauche`);
    assert.ok(left + width <= PATCHER.devicewidth, `${box.id} depasse a droite`);
    assert.ok(top + height <= DEVICE_HEIGHT, `${box.id} depasse en bas`);
  }
});

// Ce test verifie les deux reglages enregistres avec le morceau : Studio et Equilibree par defaut,
// et des noms longs figes.
//
// Le nom long identifie le parametre dans le fichier `.als`. Le changer ferait perdre le reglage
// de tous les projets deja enregistres.
//
// Les deux menus n'ont pas le meme nombre de positions : la qualite en compte trois, la latence
// quatre. La borne haute du parametre suit ce nombre, et c'est elle qui est verifiee — un menu dont
// le `parameter_mmax` ne suit pas rend sa derniere position inatteignable depuis Live.
test("les deux reglages ont les bons defauts et les bonnes bornes", () => {
  const quality = byId.get("quality-menu");
  const latency = byId.get("latency-menu");

  for (const menu of [quality, latency]) {
    assert.ok(menu, "un reglage manque");
    assert.equal(menu.maxclass, "live.menu");
    assert.equal(menu.parameter_enable, 1, `${menu.id} doit etre un parametre enregistre`);

    const values = parameterOf(menu);
    const choices = values.parameter_enum as string[];
    assert.ok(choices.length >= 3, `${menu.id} doit garder au moins ses trois positions`);
    assert.equal(values.parameter_mmax, choices.length - 1, `${menu.id} : la borne haute suit les positions`);
    assert.equal(values.parameter_type, 2, "un choix nomme est un parametre de type Enum");
    assert.equal(values.parameter_initial_enable, 1);
    assert.equal(values.parameter_invisible, 1, "les deux reglages se gardent avec le morceau");
  }

  const qualityValues = parameterOf(quality!);
  const latencyValues = parameterOf(latency!);

  const qualityChoices = qualityValues.parameter_enum as string[];
  const latencyChoices = latencyValues.parameter_enum as string[];
  const qualityStart = (qualityValues.parameter_initial as number[])[0] ?? -1;
  const latencyStart = (latencyValues.parameter_initial as number[])[0] ?? -1;

  assert.equal(qualityChoices.length, 3);
  assert.equal(latencyChoices.length, 4);
  assert.equal(qualityChoices[qualityStart], "Studio 256");
  assert.match(String(latencyChoices[latencyStart]), /quilibr/);
  assert.equal(qualityValues.parameter_longname, "Qualite");
  assert.equal(latencyValues.parameter_longname, "Latence");

  // Les trois premieres positions occupent des places fixes. Live enregistre un numero de position :
  // une valeur glissee avant les autres changerait le reglage des projets deja enregistres.
  assert.deepEqual(latencyChoices.slice(0, 3), ["Faible 200 ms", "Équilibrée 400 ms", "Stable 800 ms"]);
});

// Ce test verifie qu'un projet rouvert ne relance jamais un direct tout seul.
//
// Le bouton retient sa position, sinon il ne pourrait pas s'allumer. Trois choses l'empechent de
// la rapporter d'un projet a l'autre : le parametre est cache, donc Live ne le range pas dans le
// morceau ; sa valeur de depart est posee a zero ; et l'ouverture du device lui renvoie `set 0`,
// qui repose le bouton sans rien emettre. La derniere suffirait, les deux autres evitent que le
// bouton s'affiche allume le temps du chargement.
test("le bouton Lancer ne peut pas se rallumer a l'ouverture d'un projet", () => {
  const button = byId.get("start-toggle");

  assert.ok(button);
  assert.equal(button.maxclass, "live.text");

  const parameter = parameterOf(button);
  assert.equal(parameter.parameter_invisible, 2, "le bouton doit rester cache de Live");
  assert.equal(parameter.parameter_initial_enable, 1);
  assert.deepEqual(parameter.parameter_initial, [0], "le bouton doit demarrer arrete");

  // `live.thisdevice` annonce le chargement. Le chemin qui part de la doit reposer le bouton.
  const atLoad = reachedFrom("device-ready", 0);
  const reset = atLoad.find((id) => textOf(byId.get(id)!) === "set 0" && reachedFrom(id, 0).includes("start-toggle"));
  assert.ok(reset, "le chargement du device doit reposer le bouton Lancer");

  // Et rien de ce que le chargement declenche ne doit parler du direct au script Node.
  const told = atLoad.filter((id) => textOf(byId.get(id)!).startsWith("prepend live"));
  assert.deepEqual(told, [], "le chargement du device ne doit annoncer aucun direct");
});

// Ce test verifie que le choix de la page tient dans un parametre.
//
// C'est le defaut de la premiere version : la bascule etait un `live.text` en interrupteur sans
// parametre attache, donc sans valeur ou retenir sa position. Le meme 1 repartait a chaque clic,
// et la page des reglages ne se refermait plus jamais. Un `live.tab` sort le numero de l'onglet
// choisi, ce qui ne peut pas se bloquer.
test("les pages se choisissent par un onglet qui retient sa position", () => {
  const tabs = byId.get("page-tabs");

  assert.ok(tabs, "le device doit porter des onglets");
  assert.equal(tabs.maxclass, "live.tab");
  assert.equal(tabs.parameter_enable, 1, "sans parametre, l'onglet ne retient pas sa position");

  const parameter = parameterOf(tabs);
  assert.equal(parameter.parameter_invisible, 2, "la page ouverte ne regarde pas le morceau");

  // Le numero de l'onglet doit atteindre chaque page : la bascule marche dans tous les sens.
  //
  // Le nombre de pages n'est pas ecrit ici. C'est l'onglet qui le dit, et le patcher doit porter
  // exactement autant de messages de bascule qu'il annonce de positions : un onglet de plus sans son
  // message ouvrirait une page vide, et un message sans onglet serait du code mort.
  const reached = reachedFrom("page-tabs", 0);
  const scripts = boxes.filter((box) => box.maxclass === "message" && textOf(box).includes("script "));

  assert.equal(scripts.length, (parameter.parameter_enum as string[]).length, "il faut un message par page");
  for (const script of scripts) {
    assert.ok(reached.includes(script.id), `l'onglet n'atteint pas ${script.id}`);
  }
});

// Ce test verifie que le champ du token ne garde aucun contenu dans le fichier livre.
// Le token vit dans un fichier propre a la machine ; il ne doit pas pouvoir partir avec un projet.
test("le champ du token ne contient rien", () => {
  const field = byId.get("token-field");

  assert.ok(field);
  assert.equal(field.maxclass, "textedit");
  assert.equal(field.text, undefined);
  assert.equal(field.parameter_enable, undefined, "un champ texte n'est pas un parametre Live");
});

// Ce test verifie comment le device nomme son script Node.
//
// C'est le defaut qui a laisse tout le device muet a la premiere ouverture dans Ableton : le
// patcher demandait `node/index.js`, et Max n'a jamais trouve ce fichier. Sa base de recherche
// n'indexe pas un seul fichier de `Documents\Ableton\User Library` — le dossier `node/` pose a cote
// du `.amxd` y etait invisible. Aucun processus Node ne demarrait, et aucun bouton ne faisait rien.
//
// Max ne sait retrouver ici qu'un nom de fichier seul, cherche dans sa propre bibliotheque. Trois
// choses doivent donc tenir ensemble : pas de chemin absolu, qui ne survivrait pas a un changement
// de machine ; pas de dossier dans le nom, que Max ne resout pas ; et le meme nom que le fichier du
// depot, que `device:install` copie dans la bibliotheque de Max.
test("le device demande son script Node par un nom de fichier seul", () => {
  const node = boxes.find((box) => textOf(box).startsWith("node.script"));

  assert.ok(node, "le device doit contenir un objet node.script");

  const asked = String(textOf(node).split(/\s+/)[1]);

  assert.doesNotMatch(asked, /[A-Za-z]:[\\/]/, "chemin absolu dans le device");
  assert.doesNotMatch(asked, /[\\/]/, "Max ne resout pas un dossier dans le nom du script");
  assert.equal(asked, NODE_ENTRY, "le nom demande n'est pas celui du fichier du depot");
  assert.match(textOf(node), /@autostart 1/, "le script demarre a l'ouverture du device");
});

// Ce test verifie que chaque message envoye a Node est un message que Node comprend.
// Une faute de frappe ici ne produit aucune erreur visible : le bouton ne ferait simplement rien.
test("chaque message envoye a Node possede un handler", () => {
  const handlers = new Set(
    [...NODE_SOURCE.matchAll(/Max\.addHandler\("([^"]+)"/g)].map((match) => match[1]),
  );

  assert.ok(handlers.size > 0, "aucun handler trouve dans le script Node");

  const sent = new Set<string>();
  for (const line of lines) {
    if (line.destination[0] !== "node") {
      continue;
    }

    const source = byId.get(line.source[0]);
    assert.ok(source, `objet source inconnu : ${line.source[0]}`);

    const words = textOf(source).split(/\s+/);
    sent.add(String(textOf(source).startsWith("prepend ") ? words[1] : words[0]));
  }

  assert.ok(sent.size >= 6, `trop peu de messages relies au script Node : ${[...sent].join(", ")}`);

  for (const word of sent) {
    assert.ok(handlers.has(word), `le script Node n'a pas de handler pour « ${word} »`);
  }
});

// Ce test verifie l'inverse : chaque mot attendu par l'aiguillage du patcher est bien un mot que
// Node envoie. Un mot en trop laisserait un libelle vide sans que rien ne le signale.
test("chaque mot attendu par le patcher est envoye par Node", () => {
  const emitted = new Set([...NODE_SOURCE.matchAll(/send\(\s*"([^"]+)"/g)].map((match) => match[1]));
  const route = boxes.find((box) => textOf(box).startsWith("route "));

  assert.ok(route, "le patcher doit aiguiller les messages de Node");

  const selectors = textOf(route).split(/\s+/).slice(1);
  assert.equal(route.numoutlets, selectors.length + 1, "l'aiguillage doit avoir une sortie de reste");

  for (const selector of selectors) {
    assert.ok(emitted.has(selector), `Node n'envoie jamais « ${selector} »`);
  }
});

// Ces quatre objets ne changent pas avec la page : les onglets, l'adresse du relais en bas, et les
// deux traits qui les separent du reste. Tout le reste doit appartenir a une page et une seule.
const ALWAYS_SHOWN = ["page-tabs", "head-rule", "foot-rule", "config-line"];

// Ce test verifie la bascule entre les pages : chaque objet visible appartient a une page et une
// seule, sauf les objets des deux bandeaux qui restent toujours a l'ecran.
test("chaque objet visible appartient a une page", () => {
  const shown = boxes
    .filter((box) => box.presentation === 1)
    .map((box) => box.varname)
    .filter((name): name is string => name !== undefined);
  const scripts = boxes
    .filter((box) => box.maxclass === "message" && textOf(box).includes("script "))
    .map((box) => textOf(box));

  assert.ok(scripts.length >= 2, "le device doit avoir au moins deux pages");

  const named = new Set<string>();
  for (const script of scripts) {
    for (const order of script.split(",")) {
      const parts = order.trim().split(/\s+/);
      const action = String(parts[1]);
      const target = String(parts[2]);

      assert.match(action, /^(hide|show)$/, `ordre inattendu : ${order}`);
      assert.ok(byId.has(target) || shown.includes(target), `objet inconnu : ${target}`);
      named.add(target);
    }
  }

  const missing = shown.filter((name) => !ALWAYS_SHOWN.includes(name) && !named.has(name));
  assert.deepEqual(missing, [], "ces objets visibles ne sont sur aucune page");

  const hiddenTwice = ALWAYS_SHOWN.filter((name) => named.has(name));
  assert.deepEqual(hiddenTwice, [], "ces objets doivent rester visibles sur toutes les pages");

  // Chaque page montre ce qu'elle seule montre, et cache tout ce que les autres montrent.
  //
  // C'est la propriete qui compte vraiment : avec deux pages elle allait de soi, avec trois un objet
  // oublie dans un seul message resterait affiche par-dessus la page suivante, et la seule trace
  // serait un chevauchement a l'ecran d'Ableton.
  const displayed = scripts.map((script) => ordersOf(script, "show"));
  const concealed = scripts.map((script) => ordersOf(script, "hide"));

  for (const [index, page] of displayed.entries()) {
    assert.ok(page.length > 0, `la page ${index} ne montre rien`);

    const others = displayed.filter((_, other) => other !== index).flat();

    assert.deepEqual(
      page.filter((name) => others.includes(name)),
      [],
      `la page ${index} partage des objets avec une autre`,
    );
    assert.deepEqual(
      others.filter((name) => !concealed[index].includes(name)).sort(),
      [],
      `la page ${index} ne cache pas tout ce que les autres montrent`,
    );
  }
});

// Cette fonction rend les objets qu'un message de bascule montre, ou ceux qu'il cache.
function ordersOf(script: string, action: string): string[] {
  return script
    .split(",")
    .map((order) => order.trim().split(/\s+/))
    .filter((parts) => parts[1] === action)
    .map((parts) => String(parts[2]));
}

// Ce test verifie que rien ne se chevauche sur une meme page.
//
// C'est le defaut qui se voit le plus vite et que le code voit le moins : deux objets poses au
// meme endroit se recouvrent, et seul celui dessine en dernier reste lisible. Les deux pages
// occupent la meme surface, donc la comparaison se fait page par page, bandeaux compris.
test("aucun objet n'en recouvre un autre sur une meme page", () => {
  const scripts = boxes
    .filter((box) => box.maxclass === "message" && textOf(box).includes("script "))
    .map((box) =>
      textOf(box)
        .split(",")
        .map((order) => order.trim().split(/\s+/))
        .filter((parts) => parts[1] === "show")
        .map((parts) => String(parts[2])),
    );

  for (const page of scripts) {
    const together = [...ALWAYS_SHOWN, ...page]
      .map((name) => boxes.find((box) => box.varname === name))
      .filter((box): box is Box => box !== undefined);

    for (let first = 0; first < together.length; first += 1) {
      for (let second = first + 1; second < together.length; second += 1) {
        const one = together[first]!;
        const other = together[second]!;
        const [ax, ay, aw, ah] = rectOf(one);
        const [bx, by, bw, bh] = rectOf(other);
        const overlaps = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

        assert.equal(overlaps, false, `${one.varname} recouvre ${other.varname}`);
      }
    }
  }
});

// Ce test verifie les marges et les tailles reprises des devices d'Ableton.
//
// Ces nombres ne sont pas des choix de gout. Les marges egales a gauche et a droite sont une
// recommandation d'Ableton ; les hauteurs sont celles des prototypes d'objets livres avec Max, que
// les devices de Live utilisent tels quels. Un menu de 20 pixels au lieu de 15 se voit tout de
// suite a cote d'un menu d'Ableton, et c'est le genre d'ecart qu'une relecture ne rattrape pas.
test("le device reprend les marges et les tailles d'Ableton", () => {
  const MARGIN = 8;
  const shown = boxes.filter((box) => box.presentation === 1);
  const rects = shown.map((box) => rectOf(box));

  assert.equal(Math.min(...rects.map(([left]) => left)), MARGIN, "marge de gauche");
  assert.equal(
    PATCHER.devicewidth - Math.max(...rects.map(([left, , width]) => left + width)),
    MARGIN,
    "la marge de droite doit egaler celle de gauche",
  );

  // Les hauteurs natives, prises dans `object-prototypes/m4l` de Max. Le bouton du direct n'est
  // pas dans cette liste : il est plus haut expres, c'est la commande principale du device.
  const NATIVE = new Map([
    ["live.menu", 15],
    ["live.tab", 17],
  ]);

  for (const box of shown) {
    const height = NATIVE.get(box.maxclass);
    if (height !== undefined) {
      assert.equal(rectOf(box)[3], height, `${box.varname} n'a pas la hauteur d'un ${box.maxclass} de Live`);
    }
  }

  for (const box of shown.filter((entry) => entry.maxclass === "live.text")) {
    assert.equal(rectOf(box)[3], 15, `${box.varname} n'a pas la hauteur d'un bouton de Live`);
  }
});

// Ce test verifie que chaque libelle a la hauteur de boite que Live donne a sa police.
//
// La regle est relevee sur les 78 devices Max for Live livres avec Live 11, et elle n'y souffre
// aucune exception : un libelle occupe sa police plus huit pixels. 10 points dans 18 pixels (449
// fois), 9 dans 17 (122), 8 dans 15, 11 dans 19, 12 dans 20, 16 dans 24.
//
// Une boite plus courte rogne le texte. C'etait le defaut de la deuxieme version — des libelles de
// 9 points dans des boites de 12 pixels — et il ne se voyait ni dans le code, ni dans la maquette,
// seulement dans Live.
test("chaque libelle a la hauteur de boite de sa police", () => {
  const labels = boxes.filter((box) => box.presentation === 1 && box.maxclass === "live.comment");

  assert.ok(labels.length >= 6, "le device doit porter des libelles");

  for (const box of labels) {
    const size = box.fontsize ?? PATCHER.default_fontsize;
    assert.equal(
      rectOf(box)[3],
      size + 8,
      `${box.varname} est en ${size} points dans une boite de ${rectOf(box)[3]} pixels`,
    );
  }
});

// Ce test verifie le fichier que Vassi depose reellement sur la piste Master.
//
// Un `.amxd` est un conteneur simple : des blocs de quatre lettres suivis de leur taille, puis le
// patcher en JSON. Le test le relit octet par octet et compare son contenu au patcher livre : le
// device et le patcher ne peuvent donc pas diverger sans que cela se voie.
test("le fichier depose dans Ableton contient bien ce patcher", () => {
  const container = readFileSync(`${ROOT}device/Vassi Stream.amxd`);
  const chunks = new Map<string, Buffer>();

  let offset = 0;
  while (offset + 8 <= container.length) {
    const name = container.toString("ascii", offset, offset + 4);
    const size = container.readUInt32LE(offset + 4);
    chunks.set(name, container.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }

  assert.equal(offset, container.length, "le conteneur ne se termine pas sur un bloc complet");
  assert.deepEqual([...chunks.keys()], ["ampf", "meta", "ptch"]);

  const inside = JSON.parse(chunks.get("ptch")!.toString("utf8")).patcher;
  assert.equal(inside.project.amxdtype, AMXD_AUDIO_EFFECT);
  assert.equal(inside.boxes.length, PATCHER.boxes.length);
  assert.equal(inside.lines.length, PATCHER.lines.length);
  assert.equal(inside.devicewidth, PATCHER.devicewidth);
  assert.equal(inside.openinpresentation, 1);
});

// Ce test verifie qu'aucun token ne se cache dans le fichier livre. C'est la derniere barriere :
// le device part avec le projet, le token ne doit jamais y entrer.
test("le fichier depose ne contient aucun token", () => {
  const container = readFileSync(`${ROOT}device/Vassi Stream.amxd`, "latin1");

  assert.doesNotMatch(container, /publisherToken/);
  assert.doesNotMatch(container, /relaytoken [^"]/, "aucune valeur de token ne doit etre figee");
});

// Ce test verifie le verrouillage des deux reglages pendant un direct.
//
// Le verrou suit l'etat annonce par le publisher, jamais la position du bouton. Apres une erreur,
// le publisher s'arrete de lui-meme : un verrou pose par le bouton resterait ferme, et Vassi ne
// pourrait plus changer de qualite sans recliquer deux fois.
test("les reglages se verrouillent pendant un direct et se liberent apres", () => {
  const select = boxes.find((box) => textOf(box).startsWith("sel STOPPED"));
  assert.ok(select, "le patcher doit traduire les etats du publisher");

  // Les etats d'un direct en cours ferment les deux reglages.
  for (const outlet of [1, 2, 3]) {
    const reached = reachedFrom(select.id, outlet);
    assert.ok(reached.includes("lock"), `l'etat ${outlet} doit fermer les reglages`);
    assert.ok(reached.includes("active-prepend"), `l'etat ${outlet} n'atteint pas les reglages`);
    assert.ok(reached.includes("quality-menu"), `l'etat ${outlet} n'atteint pas la qualite`);
    assert.ok(reached.includes("latency-menu"), `l'etat ${outlet} n'atteint pas la latence`);
  }

  // Arret et erreur les rouvrent, et reposent le bouton sans le renvoyer.
  for (const outlet of [0, 4]) {
    const reached = reachedFrom(select.id, outlet);
    assert.ok(reached.includes("unlock"), `l'etat ${outlet} doit rouvrir les reglages`);
    assert.ok(reached.includes("toggle-reset"), `l'etat ${outlet} doit reposer le bouton`);
    assert.ok(reached.includes("start-toggle"), `l'etat ${outlet} n'atteint pas le bouton`);
    assert.equal(textOf(byId.get("toggle-reset")!), "set 0", "le bouton doit se reposer sans se renvoyer");
  }
});
