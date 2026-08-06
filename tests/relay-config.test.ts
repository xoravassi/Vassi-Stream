import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_MAX_LISTENERS, DEFAULT_PORT, MIN_TOKEN_LENGTH, readRelayConfig } from "../relay/config.ts";
import {
  buildStreamState,
  parseClientMessage,
  readStreamStart,
  readStreamStop,
} from "../relay/protocol.ts";
import { tokensMatch } from "../relay/token.ts";

const RELAY_DIRECTORY = join(process.cwd(), "relay");
const VALID_TOKEN = "a".repeat(MIN_TOKEN_LENGTH);

// Ce fichier verifie la configuration, la lecture des messages et la comparaison du token.

// Ce test verifie qu'un relais sans token ne demarre pas : il accepterait n'importe quel publisher.
test("refuse une configuration sans token utilisable", () => {
  assert.throws(() => readRelayConfig({}), /config_token_absent/);
  assert.throws(() => readRelayConfig({ VASSI_PUBLISHER_TOKEN: "   " }), /config_token_absent/);
  assert.throws(() => readRelayConfig({ VASSI_PUBLISHER_TOKEN: "trop_court" }), /config_token_trop_court/);
});

// Ce test verifie les valeurs par defaut et la lecture des variables Sliplane.
test("lit le port et la limite d'auditeurs", () => {
  const defaut = readRelayConfig({ VASSI_PUBLISHER_TOKEN: VALID_TOKEN });
  assert.equal(defaut.port, DEFAULT_PORT);
  assert.equal(defaut.maxListeners, DEFAULT_MAX_LISTENERS);
  assert.equal(defaut.publisherToken, VALID_TOKEN);

  const choisi = readRelayConfig({
    VASSI_PUBLISHER_TOKEN: VALID_TOKEN,
    PORT: "9000",
    VASSI_MAX_LISTENERS: "5",
  });
  assert.equal(choisi.port, 9000);
  assert.equal(choisi.maxListeners, 5);

  assert.throws(() => readRelayConfig({ VASSI_PUBLISHER_TOKEN: VALID_TOKEN, PORT: "0" }), /config_port_invalide/);
  assert.throws(() => readRelayConfig({ VASSI_PUBLISHER_TOKEN: VALID_TOKEN, PORT: "abc" }), /config_port_invalide/);
  assert.throws(
    () => readRelayConfig({ VASSI_PUBLISHER_TOKEN: VALID_TOKEN, VASSI_MAX_LISTENERS: "0" }),
    /config_max_listeners_invalide/,
  );
});

// Ce test verifie que la comparaison du token accepte le bon et refuse tout le reste, quelle que
// soit la longueur proposee.
test("compare le token sans se tromper de valeur", () => {
  assert.equal(tokensMatch(VALID_TOKEN, VALID_TOKEN), true);
  assert.equal(tokensMatch(VALID_TOKEN, `${VALID_TOKEN}x`), false);
  assert.equal(tokensMatch(VALID_TOKEN, VALID_TOKEN.slice(0, -1)), false);
  assert.equal(tokensMatch(VALID_TOKEN, ""), false);
  assert.equal(tokensMatch(VALID_TOKEN, undefined), false);
  assert.equal(tokensMatch(VALID_TOKEN, 42), false);
  assert.equal(tokensMatch(VALID_TOKEN, { toString: () => VALID_TOKEN }), false);
});

// Ce test verifie que seuls les messages du protocole v1 sont acceptes.
test("refuse un message hors du protocole v1", () => {
  assert.throws(() => parseClientMessage("pas du json"), /invalid_json/);
  assert.throws(() => parseClientMessage("[]"), /invalid_json/);
  assert.throws(() => parseClientMessage('{"protocolVersion":1}'), /missing_type/);
  assert.throws(() => parseClientMessage('{"type":"x","protocolVersion":2}'), /unsupported_protocol_version/);

  const message = parseClientMessage('{"type":"publisher_auth","protocolVersion":1,"token":"x"}');
  assert.equal(message.type, "publisher_auth");
});

// Ce test verifie que chaque champ de `stream_start` est controle. Le relais ne decode pas l'audio :
// cette description est la seule chose que la page recoit pour configurer son decodeur.
test("controle chaque champ de stream_start", () => {
  const valide = {
    type: "stream_start",
    protocolVersion: 1,
    sessionId: 42,
    codec: "opus",
    bitrate: 192000,
    sampleRate: 48000,
    channels: 2,
    frameDurationMs: 40,
    latencyProfile: "stable",
  };

  const session = readStreamStart(valide);
  assert.deepEqual(session, { sessionId: 42, bitrate: 192000, latencyProfile: "stable" });

  assert.throws(() => readStreamStart({ ...valide, sessionId: 0 }), /invalid_session_id/);
  assert.throws(() => readStreamStart({ ...valide, sessionId: 1.5 }), /invalid_session_id/);
  assert.throws(() => readStreamStart({ ...valide, sessionId: 4294967296 }), /invalid_session_id/);
  assert.throws(() => readStreamStart({ ...valide, codec: "mp3" }), /invalid_codec/);
  assert.throws(() => readStreamStart({ ...valide, bitrate: 96000 }), /invalid_bitrate/);
  assert.throws(() => readStreamStart({ ...valide, sampleRate: 44100 }), /invalid_sample_rate/);
  assert.throws(() => readStreamStart({ ...valide, channels: 1 }), /invalid_channels/);
  assert.throws(() => readStreamStart({ ...valide, frameDurationMs: 10 }), /invalid_frame_duration/);
  assert.throws(() => readStreamStart({ ...valide, latencyProfile: "rapide" }), /invalid_latency_profile/);
});

// Ce test verifie que `stream_stop` est refuse hors de ses valeurs autorisees.
test("controle stream_stop", () => {
  const valide = { type: "stream_stop", protocolVersion: 1, sessionId: 7, reason: "user_stop" };

  assert.equal(readStreamStop(valide), 7);
  assert.equal(readStreamStop({ ...valide, reason: "error" }), 7);
  assert.throws(() => readStreamStop({ ...valide, reason: "parce_que" }), /invalid_stop_reason/);
  assert.throws(() => readStreamStop({ ...valide, sessionId: 0 }), /invalid_session_id/);
});

// Ce test verifie que l'etat envoye aux auditeurs contient exactement ce que decrit le protocole.
test("construit les deux etats du direct", () => {
  assert.deepEqual(JSON.parse(buildStreamState(null)), {
    type: "stream_state",
    protocolVersion: 1,
    live: false,
  });

  assert.deepEqual(JSON.parse(buildStreamState({ sessionId: 5, bitrate: 128000, latencyProfile: "low" })), {
    type: "stream_state",
    protocolVersion: 1,
    live: true,
    sessionId: 5,
    codec: "opus",
    bitrate: 128000,
    sampleRate: 48000,
    channels: 2,
    frameDurationMs: 40,
    latencyProfile: "low",
  });
});

// Ce test verifie que le relais, le device et les tests utilisent exactement la meme version de
// `ws`. Deux versions differentes rendraient les tests inutiles : ils ne verifieraient pas le code
// reellement deploye.
test("verrouille la meme version de ws partout", () => {
  const relais = JSON.parse(readFileSync(join(RELAY_DIRECTORY, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const device = JSON.parse(readFileSync(join(process.cwd(), "device", "node", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const racine = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };

  assert.match(relais.dependencies.ws ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(relais.dependencies.ws, device.dependencies.ws);
  assert.equal(relais.dependencies.ws, racine.devDependencies.ws);
});

// Ce test verifie que l'image deployee contient bien le relais et le module de protocole partage.
// Une image sans `src/protocol` demarrerait puis echouerait au premier import.
test("construit une image qui contient tout ce que le relais importe", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY src\/protocol \.\/src\/protocol/);
  assert.match(dockerfile, /COPY relay \.\/relay/);
  assert.match(dockerfile, /relay\/package\.json relay\/package-lock\.json/);
  assert.match(dockerfile, /CMD \["node", "relay\/main\.ts"\]/);
  // Sliplane impose un port entre 8080 et 65535 et le transmet par `PORT`.
  assert.match(dockerfile, /ENV PORT=8080/);
});

// Ce test verifie qu'aucun fichier du relais n'ecrit le token dans un journal. Les journaux
// Sliplane sont lisibles depuis l'interface d'hebergement : un token y resterait visible.
test("n'ecrit jamais le token dans un journal", () => {
  const fichiers = readdirSync(RELAY_DIRECTORY).filter((name) => name.endsWith(".ts"));
  assert.ok(fichiers.length >= 7);

  for (const nom of fichiers) {
    const source = readFileSync(join(RELAY_DIRECTORY, nom), "utf8");

    // Seul le module de configuration lit la variable d'environnement du token, et seul le module
    // de comparaison manipule sa valeur. Personne ne l'ecrit dans un message ou dans un journal.
    if (nom !== "config.ts") {
      assert.doesNotMatch(source, /VASSI_PUBLISHER_TOKEN/, `${nom} ne doit pas lire le token`);
    }

    assert.doesNotMatch(source, /console\./, `${nom} ne doit pas ecrire dans la console`);
    assert.doesNotMatch(source, /log\([^)]*token/i, `${nom} ne doit pas journaliser un token`);
  }
});
