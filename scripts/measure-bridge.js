// Ce script mesure la stabilite du pont loopback sans Max ni Ableton.
// Usage : node scripts/measure-bridge.js [nombre_de_frames] [intervalle_ms]
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { FrameBridge } = require("../device/node/frame-bridge.js");

const NATIVE_EXE = join(
	process.cwd(),
	".local",
	"build",
	"vassi.encoder",
	"Release",
	"vassi_frame_sender_test.exe"
);

const frameCount = Number(process.argv[2] ?? 15000);
const intervalMs = Number(process.argv[3] ?? 20);

const stats = { frames: 0, bytes: 0, gaps: 0, discontinuities: 0, lastSequence: -1 };

// Cette fonction accumule les mesures sans conserver l'audio recu.
function countFrame(frame) {
	stats.frames += 1;
	stats.bytes += frame.payload.length;
	if ((frame.flags & 1) !== 0) stats.discontinuities += 1;
	if (stats.lastSequence >= 0 && frame.sequence !== stats.lastSequence + 1) stats.gaps += 1;
	stats.lastSequence = frame.sequence;
}

const bridge = new FrameBridge({
	onFrame: countFrame,
	onStatus: (state, detail) => console.log(`etat ${state} : ${detail}`)
});

const port = await bridge.listen();
const startedAt = Date.now();
const startMemory = process.memoryUsage();
console.log(`port ${port}, ${frameCount} frames toutes les ${intervalMs} ms`);

await new Promise((resolve, reject) => {
	execFile(
		NATIVE_EXE,
		["--stream", String(port), String(frameCount), String(intervalMs)],
		(error) => (error ? reject(error) : resolve())
	);
});

// Le dernier morceau TCP peut arriver juste apres la fin du producteur.
await new Promise((resolve) => setTimeout(resolve, 200));
await bridge.close();

const seconds = (Date.now() - startedAt) / 1000;

// Un ramasse-miettes force separe une vraie fuite d'une simple retention de pages par V8.
if (typeof global.gc === "function") global.gc();
const endMemory = process.memoryUsage();
const megabytes = (bytes) => (bytes / 1048576).toFixed(1);

console.log(`frames ${stats.frames} / ${frameCount}`);
console.log(`octets ${stats.bytes}`);
console.log(`trous de sequence ${stats.gaps}`);
console.log(`frames marquees discontinues ${stats.discontinuities}`);
console.log(`duree ${seconds.toFixed(1)} s, debit ${(stats.frames / seconds).toFixed(1)} frames/s`);
console.log(`rss ${megabytes(startMemory.rss)} Mo puis ${megabytes(endMemory.rss)} Mo`);
console.log(`tas utilise ${megabytes(startMemory.heapUsed)} Mo puis ${megabytes(endMemory.heapUsed)} Mo`);
console.log(`buffers ${megabytes(startMemory.arrayBuffers)} Mo puis ${megabytes(endMemory.arrayBuffers)} Mo`);
console.log(stats.frames === frameCount && stats.gaps === 0 ? "RESULTAT: stable" : "RESULTAT: instable");
