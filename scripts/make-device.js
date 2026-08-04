// Ce script ecrit le device Max for Live du bloc 10 : le patcher `.maxpat` et le `.amxd` que
// Vassi depose sur la piste Master.
//
// Usage : npm.cmd run device:build
//
// Le patcher est fabrique par du code plutot qu'ecrit a la main. Un device complet compte une
// soixantaine d'objets, soit plusieurs milliers de lignes de JSON : personne ne relit cela, et
// une position fausse ne se verrait qu'a l'ouverture. Le code, lui, se lit et se verifie.
//
// Une fois le device ouvert dans Max, c'est le fichier `.maxpat` qui fait foi : Vassi peut y
// deplacer les objets et l'enregistrer. Relancer ce script ecraserait ces retouches, donc il ne
// sert qu'a poser la premiere version ou a repartir de zero.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildTestDevice } from "./build-test-device.js";
import { buildInterface, DEVICE_WIDTH } from "./device-patcher/interface.js";
import { buildWiring } from "./device-patcher/wiring.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PATCHER_PATH = `${ROOT}patchers/vassi-stream.maxpat`;
const DEVICE_PATH = `${ROOT}device/Vassi Stream.amxd`;

// Cette fonction assemble le patcher complet.
//
// Aucune couleur de fond n'est posee : le device prend celle du theme de Live. Une couleur ecrite
// ici resterait claire dans un theme sombre, et le device se verrait au premier coup d'oeil.
export function buildDevicePatcher() {
	const pages = buildInterface();
	const wiring = buildWiring(pages);

	return {
		patcher: {
			fileversion: 1,
			appversion: { major: 8, minor: 5, revision: 8, architecture: "x64", modernui: 1 },
			classnamespace: "box",
			// Cette fenetre est celle de l'edition dans Max, pas celle du device dans Live.
			rect: [100, 100, 1400, 800],
			bglocked: 0,
			// Le device s'ouvre sur sa presentation, jamais sur le cablage.
			openinpresentation: 1,
			default_fontsize: 10,
			default_fontface: 0,
			// Ableton Sans est fournie avec Max : c'est la police de l'interface de Live.
			default_fontname: "Ableton Sans",
			gridonopen: 1,
			gridsize: [5.0, 5.0],
			gridsnaponopen: 1,
			objectsnaponopen: 1,
			statusbarvisible: 2,
			toolbarvisible: 1,
			lefttoolbarpinned: 0,
			toptoolbarpinned: 0,
			righttoolbarpinned: 0,
			bottomtoolbarpinned: 0,
			toolbars_unpinned_last_save: 0,
			tallnewobj: 0,
			boxanimatetime: 200,
			enablehscroll: 1,
			enablevscroll: 1,
			devicewidth: DEVICE_WIDTH,
			description: "Diffuse le master d'Ableton en direct sur vassi.click",
			digest: "",
			tags: "",
			style: "",
			subpatcher_template: "",
			boxes: [...pages.boxes, ...wiring.boxes],
			lines: wiring.lines
		}
	};
}

const patcher = buildDevicePatcher();
writeFileSync(PATCHER_PATH, `${JSON.stringify(patcher, null, "\t")}\n`, "utf8");
const size = buildTestDevice(PATCHER_PATH, DEVICE_PATH);

console.log(`Patcher ecrit  : ${PATCHER_PATH}`);
console.log(`Device ecrit   : ${DEVICE_PATH} (${size} octets)`);
console.log(`Objets         : ${patcher.patcher.boxes.length}, cables : ${patcher.patcher.lines.length}`);
