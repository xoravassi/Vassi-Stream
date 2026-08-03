import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { readConfig, writeConfig, describeConfig, configPath } = require("../device/node/publisher-config.js");

const SECRET = "jeton-que-personne-ne-doit-lire";

// Cette fonction fait pointer la configuration vers un fichier temporaire pendant un test.
function useTemporaryConfig(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "vassi-config-"));
  const file = join(directory, "publisher.json");
  const previous = process.env.VASSI_PUBLISHER_CONFIG;

  process.env.VASSI_PUBLISHER_CONFIG = file;

  return {
    file,
    cleanup: () => {
      if (previous === undefined) {
        delete process.env.VASSI_PUBLISHER_CONFIG;
      } else {
        process.env.VASSI_PUBLISHER_CONFIG = previous;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Ce test verifie l'aller-retour ecriture puis lecture de la configuration.
test("ecrit puis relit l'URL et le token", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const written: string = writeConfig({
    relayUrl: "wss://relai.vassi.click/publisher",
    publisherToken: SECRET,
  });

  assert.equal(written, temporary.file);
  assert.equal(configPath(), temporary.file);
  assert.deepEqual(readConfig(), {
    relayUrl: "wss://relai.vassi.click/publisher",
    publisherToken: SECRET,
  });
});

test("nettoie les espaces autour du token de publication", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  writeConfig({
    relayUrl: "wss://relai.vassi.click/publisher",
    publisherToken: "  jeton-avec-espaces  ",
  });

  assert.equal(readConfig().publisherToken, "jeton-avec-espaces");
});

// Ce test verifie qu'une adresse en clair reste possible en local et refusee a distance.
// Le token de publication ne doit jamais traverser un reseau sans chiffrement.
test("refuse une adresse en clair vers un hote distant", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  assert.doesNotThrow(() => writeConfig({ relayUrl: "ws://127.0.0.1:9000/publisher", publisherToken: SECRET }));
  assert.doesNotThrow(() => writeConfig({ relayUrl: "wss://relai.vassi.click/publisher", publisherToken: SECRET }));
  assert.throws(
    () => writeConfig({ relayUrl: "ws://relai.vassi.click/publisher", publisherToken: SECRET }),
    /config_url_non_chiffree/,
  );
  assert.throws(() => writeConfig({ relayUrl: "https://vassi.click", publisherToken: SECRET }), /config_url_non_chiffree/);
  assert.throws(() => writeConfig({ relayUrl: "pas une url", publisherToken: SECRET }), /config_url_invalide/);
});

// Ce test verifie que chaque contenu inutilisable donne une erreur courte et lisible.
test("refuse une configuration incomplete", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  assert.throws(() => readConfig(), /config_absente/);

  writeFileSync(temporary.file, "ceci n'est pas du json", "utf8");
  assert.throws(() => readConfig(), /config_json_invalide/);

  writeFileSync(temporary.file, JSON.stringify({ publisherToken: SECRET }), "utf8");
  assert.throws(() => readConfig(), /config_url_absente/);

  writeFileSync(temporary.file, JSON.stringify({ relayUrl: "wss://relai.vassi.click/publisher" }), "utf8");
  assert.throws(() => readConfig(), /config_token_absent/);

  writeFileSync(
    temporary.file,
    JSON.stringify({ relayUrl: "wss://relai.vassi.click/publisher", publisherToken: "   " }),
    "utf8",
  );
  assert.throws(() => readConfig(), /config_token_absent/);
});

// Ce test verifie que la description destinee a l'affichage ne contient jamais le token.
test("decrit la configuration sans exposer le token", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  writeConfig({ relayUrl: "wss://relai.vassi.click/publisher", publisherToken: SECRET });

  const description = describeConfig();
  assert.equal(description.ready, true);
  assert.equal(description.relayUrl, "wss://relai.vassi.click/publisher");
  assert.doesNotMatch(JSON.stringify(description), new RegExp(SECRET));

  rmSync(temporary.file, { force: true });
  const missing = describeConfig();
  assert.equal(missing.ready, false);
  assert.equal(missing.relayUrl, "");
  assert.match(missing.detail, /config_absente/);
});
