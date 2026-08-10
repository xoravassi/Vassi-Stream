// Ce script dessine le device dans une page web, sans ouvrir Ableton.
//
// Usage : npm.cmd run device:preview [chemin.html]
//
// Le device est fabrique par du code, et personne ne peut juger une interface en lisant des
// coordonnees. Cette page rend les deux pages du device a partir des couleurs reellement ecrites
// dans le `.maxpat` : elle montre les chevauchements, les textes trop longs, les alignements de
// travers et un mauvais contraste avant qu'il faille lancer Live pour s'en apercevoir.
//
// Le device impose son propre fond, fixe, plutot que de suivre le theme de Live (voir
// `docs/device-max.md`) : il n'y a donc plus qu'un seul rendu a verifier, pas un par theme.
//
// Ce n'est qu'une maquette. Max dessine les vrais objets, avec ses propres arrondis et ses
// degrades ; ce qu'on verifie ici, ce sont les positions, les tailles, le contraste et l'equilibre
// general.
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEVICE_HEIGHT, DEVICE_WIDTH } from "./device-patcher/interface.js";
import { PALETTE } from "./device-patcher/parts.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = process.argv[2] ?? `${ROOT}device-preview.html`;

const patcher = JSON.parse(readFileSync(`${ROOT}patchers/vassi-stream.maxpat`, "utf8")).patcher;
const boxes = patcher.boxes.map((entry) => entry.box);

// Cette fonction transforme une couleur RGBA Max (flottants 0-1) en couleur CSS.
function css(rgba) {
	const [r, g, b, a] = rgba;
	return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

// Cette fonction lit la couleur reellement ecrite sur la boite, et retombe sur la palette du
// device si l'attribut est absent : la maquette ne peut alors pas inventer une couleur qui ne
// serait pas dans le fichier livre.
function colorOf(box, key, fallback) {
	return css(box[key] ?? fallback);
}

const PANEL_BG = css(PALETTE.bg);

// Cette fonction lit les messages `script show` du patcher : ce sont eux qui disent quels objets
// composent chaque page. La maquette ne peut donc pas se desynchroniser du device.
function readPages() {
	const scripts = boxes
		.filter((box) => box.maxclass === "message" && String(box.text ?? "").includes("script "))
		.map((box) =>
			String(box.text)
				.split(",")
				.map((order) => order.trim().split(/\s+/))
				.filter((parts) => parts[1] === "show")
				.map((parts) => parts[2])
		);

	// Ce qu'aucune page ne montre est visible sur les deux : les onglets et les deux bandeaux.
	const named = new Set(scripts.flat());
	const always = boxes
		.filter((box) => box.presentation === 1 && box.varname !== undefined && !named.has(box.varname))
		.map((box) => box.varname);

	return scripts.map((page) => [...always, ...page]);
}

// Cette fonction rend un objet du device en HTML, avec les couleurs qu'il porte reellement.
function draw(box) {
	const [left, top, width, height] = box.presentation_rect;
	const place = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
	const size = box.fontsize ?? patcher.default_fontsize;
	const text = box.text ?? "";

	switch (box.maxclass) {
		case "live.comment":
			return `<div class="box comment" style="${place};font-size:${size}px;color:${colorOf(box, "textcolor", PALETTE.text)}">${escape(text)}</div>`;

		case "live.line": {
			// `live.line` dessine dans le sens de sa plus grande dimension, et centre son trait.
			const vertical = height > width;
			const bar = vertical
				? `left:${left + Math.floor(width / 2)}px;top:${top}px;width:1px;height:${height}px`
				: `left:${left}px;top:${top + Math.floor(height / 2)}px;width:${width}px;height:1px`;
			return `<div class="box" style="${bar};background:${colorOf(box, "linecolor", PALETTE.divider)}"></div>`;
		}

		case "live.tab": {
			// L'onglet ouvert au premier chargement est le premier de la liste (voir wiring.js).
			const labels = box.saved_attribute_attributes.valueof.parameter_enum;
			const each = Math.floor(width / labels.length);
			const bgOn = colorOf(box, "lcdcolor", PALETTE.accent);
			const bgOff = colorOf(box, "lcdbgcolor", PALETTE.bg);
			const textOn = colorOf(box, "textoncolor", PALETTE.onAccent);
			const textOff = colorOf(box, "textcolor", PALETTE.textDim);
			return labels
				.map((label, index) => {
					const on = index === 0;
					const rect = `left:${left + index * each}px;top:${top}px;width:${each}px;height:${height}px`;
					const skin = `background:${on ? bgOn : bgOff};color:${on ? textOn : textOff}`;
					return `<div class="box tab" style="${rect};${skin};font-size:${size}px">${escape(label)}</div>`;
				})
				.join("");
		}

		case "live.text": {
			// Les boutons sont dessines eteints : c'est l'etat dans lequel le device s'ouvre.
			//
			// En mode LCD, c'est `lcdcolor` qui peint le texte a l'arret, et `lcdbgcolor` le fond ;
			// les deux echangent leur role pendant le clic. `textcolor` ne sert qu'a un objet rendu
			// inactif : la maquette le dessinait a sa place, et montrait donc gris un libelle que
			// Max peint en orange.
			const lcd = box.appearance === 2;
			const skin = lcd
				? `background:${colorOf(box, "lcdbgcolor", PALETTE.bg)};color:${colorOf(box, "lcdcolor", PALETTE.accent)}`
				: `background:${PANEL_BG};color:${colorOf(box, "textcolor", PALETTE.text)};border:1px solid ${colorOf(box, "bordercolor", PALETTE.divider)}`;
			return `<div class="box button" style="${place};${skin};font-size:${size}px">${escape(text)}</div>`;
		}

		case "live.menu": {
			const chosen = box.saved_attribute_attributes.valueof;
			const value = chosen.parameter_enum[chosen.parameter_initial[0]];
			const bg = colorOf(box, "lcdbgcolor", PALETTE.bg);
			const fg = colorOf(box, "textcolor", PALETTE.text);
			const border = colorOf(box, "bordercolor", PALETTE.divider);
			return `<div class="box menu" style="${place};background:${bg};color:${fg};border:1px solid ${border};font-size:${size}px">
				<span>${escape(String(value))}</span><span class="arrow">▾</span>
			</div>`;
		}

		case "live.meter~":
			return `<div class="box" style="${place};background:${colorOf(box, "bgcolor", PALETTE.bg)}">
				<div style="position:absolute;left:2px;right:2px;bottom:2px;height:38%;background:linear-gradient(to top, #6fbf4a, #d8d84a)"></div>
			</div>`;

		case "textedit":
			return `<div class="box field" style="${place};background:${colorOf(box, "bgcolor", PALETTE.bg)};color:${colorOf(box, "textcolor", PALETTE.text)};border:1px solid ${colorOf(box, "bordercolor", PALETTE.divider)};font-size:${size}px">${escape(text)}</div>`;

		default:
			return `<div class="box" style="${place};outline:1px dashed red"></div>`;
	}
}

function escape(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const pages = readPages();
// Les noms des pages sont ceux des onglets, lus dans le patcher : une page ajoutee apparait donc
// dans la maquette sans qu'on ait a la nommer ici une seconde fois.
const names = boxes.find((box) => box.maxclass === "live.tab").saved_attribute_attributes.valueof.parameter_enum;

const panels = pages
	.map((page, index) => {
		const drawn = page
			.map((name) => boxes.find((box) => box.varname === name))
			.filter((box) => box !== undefined)
			.map((box) => draw(box))
			.join("\n");

		return `<figure>
	<figcaption>${names[index]}</figcaption>
	<div class="device" style="background:${PANEL_BG}">${drawn}</div>
</figure>`;
	})
	.join("\n");

const page = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Vassi Stream — maquette du device</title>
<style>
	body { margin: 24px; background: #202020; color: #bbb;
		font-family: "Segoe UI", system-ui, sans-serif; }
	h1 { font-size: 15px; font-weight: 600; color: #ddd; }
	p { font-size: 12px; max-width: 62ch; line-height: 1.5; }
	.pages { display: flex; flex-wrap: wrap; gap: 28px; margin-top: 24px; }
	figcaption { font-size: 11px; margin-bottom: 6px; letter-spacing: .04em; }
	.device { position: relative; width: ${DEVICE_WIDTH}px; height: ${DEVICE_HEIGHT}px;
		transform: scale(2); transform-origin: top left; overflow: hidden; }
	figure { margin: 0 0 ${DEVICE_HEIGHT + 20}px 0; width: ${DEVICE_WIDTH * 2}px; }
	.box { position: absolute; box-sizing: border-box; }
	.comment { display: flex; align-items: center; white-space: pre-wrap; line-height: 1.15; }
	.tab, .button { display: flex; align-items: center; justify-content: center; }
	.field { display: flex; align-items: center; padding: 0 3px; }
	.menu { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
	.arrow { font-size: 7px; opacity: .8; }
</style>
</head>
<body>
<h1>Vassi Stream — maquette du device Max for Live</h1>
<p>Les pages du device, à l'échelle 2, avec les couleurs réellement écrites dans
<code>patchers/vassi-stream.maxpat</code> : cette page ne peut pas mentir sur la mise en page ni
sur les couleurs. Max dessine les vrais objets ; ce qui se vérifie ici, ce sont les alignements,
les débordements de texte, le contraste et l'équilibre général.</p>
<div class="pages">
${panels}
</div>
</body>
</html>
`;

writeFileSync(OUTPUT, page, "utf8");
console.log(`Maquette ecrite : ${OUTPUT}`);
