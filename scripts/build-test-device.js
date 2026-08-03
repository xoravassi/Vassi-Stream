// Ce module transforme un patcher Max en device Max for Live non gele.
// Un fichier .amxd est un conteneur simple : trois blocs de tete suivis du patcher en JSON.
import { readFileSync, writeFileSync } from "node:fs";

// Ce nombre est le code ASCII "audi" : il indique a Live que le device est un effet audio.
const AMXD_TYPE_AUDIO_EFFECT = 1633771873;

// Cette valeur est celle que Max ecrit dans le bloc meta des devices de cette version.
const META_VALUE = 7;

// Cette fonction ecrit un bloc du conteneur : quatre lettres, une taille, puis les donnees.
function writeChunk(name, data) {
	const header = Buffer.alloc(8);
	header.write(name, 0, 4, "ascii");
	header.writeUInt32LE(data.length, 4);
	return Buffer.concat([header, data]);
}

// Cette fonction ajoute au patcher les cles que Live attend dans un device.
// Le fichier .maxpat reste un patcher ordinaire : ces cles n'existent que dans le .amxd.
function addDeviceKeys(patcher) {
	return {
		...patcher,
		dependency_cache: [],
		latency: 0,
		is_mpe: 0,
		minimum_live_version: "",
		minimum_max_version: "",
		platform_compatibility: 0,
		project: {
			version: 1,
			creationdate: 0,
			modificationdate: 0,
			viewrect: [0.0, 0.0, 300.0, 500.0],
			autoorganize: 1,
			hideprojectwindow: 1,
			showdependencies: 1,
			autolocalize: 0,
			contents: { patchers: {}, externals: {} },
			layout: {},
			searchpath: {},
			detailsvisible: 0,
			amxdtype: AMXD_TYPE_AUDIO_EFFECT,
			readonly: 0,
			devpathtype: 0,
			devpath: ".",
			sortmode: 0,
			viewmode: 0,
			includepackages: 0
		},
		autosave: 0
	};
}

// Cette fonction lit un .maxpat et ecrit le .amxd correspondant.
export function buildTestDevice(maxpatPath, amxdPath) {
	const source = JSON.parse(readFileSync(maxpatPath, "utf8"));
	const document = { patcher: addDeviceKeys(source.patcher) };
	const json = Buffer.from(JSON.stringify(document, null, "\t"), "utf8");

	const meta = Buffer.alloc(4);
	meta.writeUInt32LE(META_VALUE, 0);

	const container = Buffer.concat([
		writeChunk("ampf", Buffer.from("aaaa", "ascii")),
		writeChunk("meta", meta),
		writeChunk("ptch", json)
	]);

	writeFileSync(amxdPath, container);
	return container.length;
}
