// Ce module lit la configuration du relais depuis les variables d'environnement Sliplane.
// Il refuse un demarrage incomplet : un relais sans token accepterait n'importe quel publisher.

// Sliplane impose un port entre 8080 et 65535 et le transmet par la variable `PORT`.
export const DEFAULT_PORT = 8080;
// Le projet prevoit peu d'auditeurs. Cette limite protege la memoire du serveur.
export const DEFAULT_MAX_LISTENERS = 50;
// Un token plus court serait devinable. Trente-deux caracteres correspondent a 16 octets aleatoires.
export const MIN_TOKEN_LENGTH = 32;

// Ce type decrit la configuration complete du relais.
export type RelayConfig = {
  port: number;
  publisherToken: string;
  maxListeners: number;
};

// Cette fonction lit la configuration et refuse toute valeur qui rendrait le relais dangereux.
// Les messages sont des codes courts : ils apparaissent dans les logs Sliplane, jamais le token.
export function readRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const publisherToken = (env.VASSI_PUBLISHER_TOKEN ?? "").trim();

  if (publisherToken === "") {
    throw new Error("config_token_absent");
  }

  if (publisherToken.length < MIN_TOKEN_LENGTH) {
    throw new Error("config_token_trop_court");
  }

  return {
    port: readPort(env.PORT),
    publisherToken,
    maxListeners: readCount(env.VASSI_MAX_LISTENERS, DEFAULT_MAX_LISTENERS, "config_max_listeners_invalide"),
  };
}

// Cette fonction lit le port et refuse une valeur qui ne pourrait pas etre ouverte.
function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("config_port_invalide");
  }

  return port;
}

// Cette fonction lit un compteur entier positif et garde la valeur par defaut si rien n'est fourni.
function readCount(value: string | undefined, fallback: number, errorCode: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const count = Number(value);

  if (!Number.isInteger(count) || count < 1) {
    throw new Error(errorCode);
  }

  return count;
}
