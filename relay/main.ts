import { readRelayConfig, type RelayConfig } from "./config.ts";
import { log } from "./log.ts";
import { RelayServer } from "./server.ts";

// Ce fichier demarre le relais sur le serveur. Il lit la configuration, ouvre le port et arrete le
// service proprement quand l'hebergeur demande la fin du conteneur.

// Ce delai laisse partir l'etat hors ligne vers les auditeurs avant la fermeture des connexions.
const SHUTDOWN_FLUSH_MS = 250;
// Au-dela de ce delai, l'arret est force : un socket bloque ne doit pas retenir le conteneur.
const SHUTDOWN_TIMEOUT_MS = 5000;

// Cette fonction lit la configuration ou arrete le processus avec une raison lisible.
// Un relais sans token accepterait n'importe quel publisher : il ne doit pas demarrer.
function loadConfig(): RelayConfig {
  try {
    return readRelayConfig();
  } catch (error) {
    // La raison est un code court. Le token n'apparait jamais, meme quand il est en cause.
    log("relais_config_invalide", { reason: error instanceof Error ? error.message : "inconnue" });
    process.exit(1);
  }
}

const config = loadConfig();
const relay = new RelayServer(config);
let stopping = false;

// Cette fonction ferme le relais dans l'ordre : etat hors ligne, connexions, port, processus.
function shutdown(signal: string): void {
  if (stopping) {
    return;
  }

  stopping = true;
  log("relais_arret", { signal });
  relay.announceShutdown();

  const forced = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  setTimeout(() => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  }, SHUTDOWN_FLUSH_MS);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Une promesse rejetee sans gestionnaire arrete Node depuis la version 15. Le relais signale
// l'incident et continue a diffuser : une seule connexion fautive ne doit pas couper le direct
// de tout le monde.
process.on("unhandledRejection", (reason) => {
  log("promesse_rejetee", { reason: reason instanceof Error ? reason.message : "inconnue" });
});

// Une exception non capturee laisse le processus dans un etat inconnu. Le relais s'arrete pour que
// l'hebergeur le redemarre proprement.
process.on("uncaughtException", (error) => {
  log("exception_non_capturee", { reason: error.message });
  process.exit(1);
});

relay.listen().then(
  (port) => log("relais_demarre", { port, maxListeners: config.maxListeners }),
  (error) => {
    log("relais_demarrage_impossible", { reason: error instanceof Error ? error.message : "inconnue" });
    process.exit(1);
  },
);
