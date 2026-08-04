import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { networkInterfaces } from "node:os";
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

// Par defaut la page n'est servie qu'a cette machine. `VASSI_HOST=0.0.0.0` l'ouvre au reseau local,
// ce qui permet d'ouvrir la page depuis le Mac du professeur ou depuis un telephone.
//
// Une page servie en `http://` depuis une autre machine n'est pas un contexte securise :
// `SharedArrayBuffer` y est absent quoi qu'il arrive, et le moteur passe en mode messages. Seule la
// machine qui lance le script peut verifier le mode partage, par `http://127.0.0.1`.
const HOST = process.env.VASSI_HOST ?? "127.0.0.1";

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

  // Ce bouton coupe le direct un moment, pour verifier qu'une coupure produit un rebuffer et non
  // une erreur. La duree est choisie par la page : trois secondes pour une coupure ordinaire,
  // trente pour depasser plusieurs paliers de l'escalier de reconnexion.
  if (url.pathname === "/control/cut") {
    const asked = Number(url.searchParams.get("ms") ?? 3000);
    const durationMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 500), 120000) : 3000;

    publisher.cut(durationMs);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ cut: durationMs }));
    return;
  }

  // L'adresse du relais est construite a partir de celle que le navigateur a demandee. Une adresse
  // fixe en `127.0.0.1` renverrait un visiteur venu du reseau local vers sa propre machine.
  if (url.pathname === "/control/relay") {
    const host = (request.headers.host ?? `127.0.0.1:${PORT}`).replace(/:\d+$/, "");

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ listenerUrl: `ws://${host}:${relayPort}/listener` }));
    return;
  }

  if (url.pathname.startsWith("/shim/")) {
    const name = url.pathname.slice(6).replace(/\.js$/, "");
    const code = SHIMS[name];

    response.writeHead(code === undefined ? 404 : 200, { "content-type": TYPES[".js"] });
    response.end(code ?? "introuvable");
    return;
  }

  // Le navigateur demande cette adresse tout seul, sur chaque page. Sans cette reponse, le serveur
  // essaierait de lire un fichier qui n'existe pas.
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
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

    // Un flux de lecture signale un fichier absent par un evenement, pas par une exception : le
    // `catch` ci-dessous ne le verrait jamais. Sans ce gestionnaire, une seule adresse inconnue
    // demandee par le navigateur arrete le serveur au milieu de l'ecoute.
    const stream = createReadStream(file);

    stream.on("error", () => {
      stream.destroy();
      notFound(response);
    });

    stream.on("open", () => {
      response.writeHead(200, headers);
      stream.pipe(response);
    });
  } catch {
    notFound(response);
  }
});

// Cette fonction repond a une adresse inconnue sans arreter le serveur.
function notFound(response) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("introuvable");
}

// Cette fonction rend les adresses IPv4 de la machine sur le reseau local.
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

site.listen(PORT, HOST, () => {
  console.log(`Page de test : http://127.0.0.1:${PORT}/`);
  console.log(`Relais local : ws://127.0.0.1:${relayPort}/listener`);

  if (HOST === "127.0.0.1") {
    console.log("Sans SharedArrayBuffer : $env:VASSI_NO_ISOLATION = \"1\"; npm.cmd run player:fixture");
    console.log("Depuis une autre machine : $env:VASSI_HOST = \"0.0.0.0\"; npm.cmd run player:fixture");
    return;
  }

  for (const address of lanAddresses()) {
    console.log(`Depuis le reseau local : http://${address}:${PORT}/`);
  }

  console.log("Une page servie ainsi n'est pas un contexte securise : mode messages impose.");
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

// Cet outil doit survivre a une longue seance d'ecoute. Une panne imprevue est affichee et le
// serveur continue, plutot que de couper le direct au milieu d'un essai de trente minutes. Le
// moteur audio teste, lui, tourne dans le navigateur : rien de ce qui arrive ici ne le concerne.
process.on("uncaughtException", (error) => {
  console.error("Erreur du serveur de test, l'ecoute continue :", error.message);
});
