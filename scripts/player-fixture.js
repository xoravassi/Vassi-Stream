import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { RelayServer } from "../relay/server.ts";
import { startFixturePublisher } from "./fixture-publisher.js";

// Ce script sert la page de test du player et lui envoie un vrai direct.
//
// Il demarre le relais du bloc 7, y branche un publisher qui rejoue la fixture Opus en boucle, et
// sert les fichiers du projet au navigateur. Il existe pour la seule verification que Node ne peut
// pas faire : entendre le son.
//
// Ce serveur n'est pas le site. Il remplace le bundler que le bloc 9 apportera : il efface les
// annotations de type des fichiers `.ts` et remplace les noms de paquets par des chemins servis.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PAGE = join(ROOT, "tests", "browser", "player-fixture.html");
const FIXTURE = join(ROOT, "tests", "fixtures", "stereo-440-880-256k.vsa1");

// Ce token ne sert qu'a ce serveur local. Il n'ouvre rien d'autre que le relais lance ici meme.
const LOCAL_TOKEN = "fixture_locale_du_player_vassi_stream_0123456789";
const PORT = Number(process.env.PORT ?? 8123);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Ces paquets ne sont livres qu'en CommonJS, que le navigateur ne sait pas charger comme module.
// Un bundler en produirait l'equivalent en une ligne : ce serveur fait la meme chose. Le paquet
// concerne ne sert qu'a `OpusDecoderWebWorker`, que le player n'utilise pas ; le remplacement n'a
// donc aucun effet sur le decodage.
const SHIMS = {
  "@eshaz/web-worker": "export default self.Worker;\n",
};

// Cette fonction resout un nom de paquet vers le chemin servi sous `/vendor`. Elle lit le
// `package.json` du paquet et prefere l'entree navigateur, comme le ferait un bundler.
function resolvePackage(name) {
  if (SHIMS[name] !== undefined) {
    return `/shim/${name}.js`;
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8"));
  const entry =
    manifest.exports?.browser ?? manifest.exports?.default ?? manifest.browser ?? manifest.module ?? manifest.main ?? "index.js";

  return `/vendor/${name}/${entry.replace(/^\.\//, "")}`;
}

// Cette fonction remplace les noms de paquets par des chemins que le navigateur sait demander.
// Les navigateurs ne resolvent pas les noms de paquets, et les cartes d'import ne s'appliquent pas
// aux workers : la reecriture est faite ici, une seule fois, a la lecture du fichier.
function rewriteImports(source) {
  return source.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"'./][^"']*)\2/g, (match, keyword, quote, name) => {
    try {
      return `${keyword}${quote}${resolvePackage(name)}${quote}`;
    } catch {
      return match;
    }
  });
}

// Cette fonction lit un module du projet ou d'un paquet et le rend pret pour le navigateur.
function readModule(path) {
  const source = readFileSync(path, "utf8");

  // Node efface les annotations de type sans rien compiler d'autre : le navigateur recoit le meme
  // code que celui execute par les tests.
  const code = extname(path) === ".ts" ? stripTypeScriptTypes(source, { mode: "strip" }) : source;

  return rewriteImports(code);
}

// Cette fonction traduit une adresse demandee en chemin de fichier, sans jamais sortir du projet.
function resolveFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");

  if (clean === "/" || clean === "\\") {
    return PAGE;
  }

  if (clean.startsWith("/vendor/") || clean.startsWith("\\vendor\\")) {
    return join(ROOT, "node_modules", clean.slice(8));
  }

  return join(ROOT, clean);
}

const relay = new RelayServer(
  { port: 0, publisherToken: LOCAL_TOKEN, maxListeners: 10 },
  { onEvent: () => {} },
);

const relayPort = await relay.listen();
const publisher = startFixturePublisher(`ws://127.0.0.1:${relayPort}/publisher`, LOCAL_TOKEN, FIXTURE);

const site = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://page.invalid");

  // Ce bouton coupe le direct quelques secondes, pour verifier qu'une coupure produit un rebuffer
  // et non une erreur.
  if (url.pathname === "/control/cut") {
    publisher.cut(3000);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ cut: true }));
    return;
  }

  if (url.pathname === "/control/relay") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ listenerUrl: `ws://127.0.0.1:${relayPort}/listener` }));
    return;
  }

  if (url.pathname.startsWith("/shim/")) {
    const name = url.pathname.slice(6).replace(/\.js$/, "");
    const code = SHIMS[name];

    response.writeHead(code === undefined ? 404 : 200, { "content-type": TYPES[".js"] });
    response.end(code ?? "introuvable");
    return;
  }

  const file = resolveFile(url.pathname);
  const type = TYPES[extname(file)] ?? "application/octet-stream";

  // Ces deux en-tetes isolent la page, ce qui rend `SharedArrayBuffer` disponible. `?shared=0` sur
  // la page les retire, pour verifier aussi le chemin par messages utilise sans eux.
  const headers = { "content-type": type, "cache-control": "no-store" };

  if (process.env.VASSI_NO_ISOLATION !== "1") {
    headers["cross-origin-opener-policy"] = "same-origin";
    headers["cross-origin-embedder-policy"] = "require-corp";
    headers["cross-origin-resource-policy"] = "same-origin";
  }

  try {
    if (extname(file) === ".ts" || extname(file) === ".js") {
      const code = readModule(file);
      headers["content-length"] = Buffer.byteLength(code);
      response.writeHead(200, headers);
      response.end(code);
      return;
    }

    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("introuvable");
  }
});

site.listen(PORT, "127.0.0.1", () => {
  console.log(`Page de test : http://127.0.0.1:${PORT}/`);
  console.log(`Relais local : ws://127.0.0.1:${relayPort}/listener`);
  console.log("Sans SharedArrayBuffer : VASSI_NO_ISOLATION=1 npm run player:fixture");
});

// Cette fonction arrete tout proprement quand la console demande la fin.
async function shutdown() {
  publisher.stop();
  site.close();
  await relay.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
