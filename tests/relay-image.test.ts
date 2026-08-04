import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Ce fichier verifie que l'image deployee sur Sliplane contient tout ce dont le relais a besoin.
//
// Il ne construit pas d'image Docker : il reproduit sa disposition de fichiers en lisant le
// `Dockerfile`, puis il y demarre le relais exactement comme le fait le conteneur. C'est la seule
// erreur que les autres tests ne peuvent pas voir : ils tournent depuis la racine du projet, ou tout
// est present, alors que l'image ne recoit qu'une petite partie des fichiers.
//
// Une ligne `COPY` oubliee ne se verrait autrement qu'au premier deploiement.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 8402;
const TOKEN = "image_simulee_du_relais_vassi_stream_0123456789";

// Ce type decrit une instruction de copie lue dans le `Dockerfile`.
type CopyStep = { sources: string[]; target: string };

// Cette fonction lit les copies et la commande de demarrage declarees par le `Dockerfile`.
// Les valeurs viennent du fichier lui-meme : le test suit donc l'image reellement deployee.
function readDockerfile(): { copies: CopyStep[]; command: string[] } {
  const lines = readFileSync(join(ROOT, "Dockerfile"), "utf8").split("\n");
  const copies: CopyStep[] = [];
  let command: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("COPY ")) {
      const parts = trimmed.slice(5).trim().split(/\s+/);
      const target = parts[parts.length - 1];

      if (target !== undefined && parts.length > 1) {
        copies.push({ sources: parts.slice(0, -1), target });
      }

      continue;
    }

    if (trimmed.startsWith("CMD ")) {
      command = JSON.parse(trimmed.slice(4).trim()) as string[];
    }
  }

  return { copies, command };
}

// Cette fonction reproduit le contenu de l'image dans un dossier temporaire.
function buildImageTree(copies: CopyStep[]): string {
  const root = mkdtempSync(join(tmpdir(), "vassi-image-"));
  const app = join(root, "app");
  mkdirSync(app, { recursive: true });

  for (const step of copies) {
    for (const source of step.sources) {
      // Une destination terminee par une barre est un dossier : le nom du fichier y est conserve.
      const clean = step.target.replace(/^\.\//, "").replace(/\/$/, "");
      const destination = step.target.endsWith("/")
        ? join(app, clean, source.split("/").pop() as string)
        : join(app, clean);

      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(ROOT, source), destination, { recursive: true });
    }
  }

  // Le `Dockerfile` installe les dependances avec `npm ci`. Le test recopie la bibliotheque deja
  // installee : un autre test verifie deja qu'elle porte la meme version des deux cotes, et une
  // installation reseau rendrait celui-ci lent et dependant d'Internet.
  cpSync(join(ROOT, "node_modules", "ws"), join(app, "relay", "node_modules", "ws"), { recursive: true });

  return root;
}

// Ce test demarre le relais depuis la seule arborescence que l'image contient. Il echoue si une
// dependance de fichier manque, ou si Node ne sait pas lire un module a cet emplacement.
test("le relais demarre depuis les seuls fichiers copies dans l'image", async (t) => {
  const { copies, command } = readDockerfile();

  // La commande du conteneur est celle utilisee ici : le test ne peut pas lancer autre chose.
  assert.deepEqual(command, ["node", "relay/main.ts"]);
  assert.ok(copies.length >= 2, "le Dockerfile doit copier le relais et le protocole partage");

  const root = buildImageTree(copies);

  const child = spawn(process.execPath, command.slice(1), {
    cwd: join(root, "app"),
    env: { ...process.env, PORT: String(PORT), VASSI_PUBLISHER_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  // Le nettoyage arrete le relais avant d'effacer le dossier, et attend sa fin. Windows refuse de
  // supprimer un dossier dont un processus vivant tient encore les fichiers ; l'ordre inverse
  // laisserait le relais tourner et le test ne se terminerait jamais.
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }

    rmSync(root, { recursive: true, force: true });
  });

  const deadline = Date.now() + 15000;
  let health: Record<string, unknown> | null = null;

  while (Date.now() < deadline && health === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);

      if (response.ok) {
        health = (await response.json()) as Record<string, unknown>;
      }
    } catch {
      // Le relais n'ecoute pas encore.
    }

    if (health === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert.ok(health !== null, `le relais n'a pas demarre depuis l'image. Sortie :\n${output}`);
  assert.equal(health.status, "ok");
  assert.equal(health.live, false);

  // Le journal du demarrage confirme que la configuration a ete lue, et ne contient pas le token.
  assert.ok(output.includes("relais_demarre"), `journal inattendu :\n${output}`);
  assert.ok(!output.includes(TOKEN));
});
