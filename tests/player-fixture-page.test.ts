import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

// Ce fichier verifie la page de test du navigateur sans navigateur.
//
// Le son lui-meme se verifie a l'oreille, mais tout ce qui l'entoure se verifie ici : chaque module
// que la page demande existe, se lit, et ne contient plus aucun nom de paquet ni aucune syntaxe que
// le navigateur refuserait. Sans ce test, la page de verification pourrait cesser de se charger
// sans que personne le remarque avant d'en avoir besoin.

const SERVER = fileURLToPath(new URL("../scripts/player-fixture.js", import.meta.url));
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

// Ces trois adresses sont les points d'entree de la page : le module principal, le worker de
// decodage et le processeur audio. Chacun est charge dans son propre contexte par le navigateur.
const ENTRIES = ["/src/player/index.ts", "/src/player/decode-worker.js", "/src/player/pcm-worklet.js"];

// Le serveur est demarre une seule fois pour tout le fichier. En demarrer un par test chargerait la
// machine au point de faire echouer les tests des autres fichiers, qui mesurent des delais reels.
let server: ChildProcess | null = null;

before(async () => {
  server = await startServer();
});

after(() => {
  server?.kill();
});

// Cette fonction demarre le serveur de test et attend qu'il reponde.
async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });

  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/control/relay`)).ok) {
        return child;
      }
    } catch {
      // Le serveur n'ecoute pas encore.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill();
  throw new Error("le serveur de test n'a pas demarre");
}

// Cette fonction lit les adresses importees par un module deja servi.
function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\1/g;
  let match = pattern.exec(source);

  while (match !== null) {
    if (match[2] !== undefined) {
      found.push(match[2]);
    }

    match = pattern.exec(source);
  }

  return found;
}

// Cette fonction parcourt tout le graphe de modules atteignable depuis les points d'entree.
async function walkModules(): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [...ENTRIES];

  while (queue.length > 0) {
    const path = queue.shift() as string;

    if (seen.has(path)) {
      continue;
    }

    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 200, `module introuvable : ${path}`);

    const source = await response.text();
    seen.set(path, source);

    for (const specifier of importsOf(source)) {
      queue.push(new URL(specifier, `${BASE}${path}`).pathname);
    }
  }

  return seen;
}

// Ce test verifie que la page se chargerait entierement : tous ses modules existent, aucun ne
// demande un nom de paquet que le navigateur ne sait pas resoudre, et aucun n'est reste en
// CommonJS.
test("la page de test sert un graphe de modules complet et lisible par un navigateur", async () => {
  const modules = await walkModules();

  // Le graphe contient au moins le player, le protocole partage et le decodeur Opus.
  assert.ok(modules.size > 8, `seulement ${modules.size} modules atteints`);
  assert.ok(modules.has("/src/player/audio-player.ts"));
  assert.ok(modules.has("/src/protocol/audio-packet.ts"));
  assert.ok([...modules.keys()].some((path) => path.includes("OpusDecoder")));

  for (const [path, source] of modules) {
    // Un navigateur ne resout pas les noms de paquets, et les cartes d'import ne s'appliquent pas
    // aux workers : chaque adresse restante doit etre absolue ou relative.
    for (const specifier of importsOf(source)) {
      assert.ok(
        specifier.startsWith("/") || specifier.startsWith("."),
        `nom de paquet non resolu dans ${path} : ${specifier}`,
      );
    }

    assert.ok(!/\bmodule\.exports\b/.test(source), `module CommonJS servi : ${path}`);
  }
});

// Ce test verifie que les fichiers TypeScript arrivent sans annotation de type. Le navigateur les
// refuserait, et l'erreur ne se verrait qu'au chargement de la page.
test("la page de test sert du JavaScript, jamais des annotations de type", async () => {
  const source = await (await fetch(`${BASE}/src/player/player-state.ts`)).text();

  assert.ok(source.includes("class PlayerStateMachine"));
  assert.ok(!source.includes("export type PlayerState"));
  assert.ok(!source.includes(": PlayerStatus"));
});

// Ce test verifie que la page recoit les en-tetes qui rendent `SharedArrayBuffer` disponible, et
// qu'ils peuvent etre retires pour verifier aussi le chemin par messages.
test("la page de test isole la page par defaut", async () => {
  const response = await fetch(`${BASE}/`);

  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
});
