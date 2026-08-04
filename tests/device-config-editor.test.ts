import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { ConfigEditor } = require("../device/node/config-editor.js");

const RELAY = "wss://live.vassi.click/publisher";
const SECRET = "jeton-de-publication-que-le-device-ne-doit-jamais-afficher";

// Cette fonction fait pointer la configuration vers un fichier temporaire pendant un test.
function useTemporaryConfig(): { file: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "vassi-editor-"));
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

// Ce test verifie le parcours normal : deux champs tapes dans le device, un clic sur Enregistrer.
test("enregistre l'adresse et le token tapes dans le device", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);
  editor.setToken(SECRET);

  const result = editor.apply();
  assert.equal(result.ok, true);

  const written = JSON.parse(readFileSync(temporary.file, "utf8"));
  assert.equal(written.relayUrl, RELAY);
  assert.equal(written.publisherToken, SECRET);
});

// Ce test verifie qu'un champ laisse vide garde sa valeur precedente. Sans cette regle, corriger
// une adresse effacerait le token, et le live suivant echouerait sans raison visible.
test("garde la valeur precedente quand un seul champ est rempli", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);
  editor.setToken(SECRET);
  assert.equal(editor.apply().ok, true);

  editor.setRelayUrl("wss://autre.vassi.click/publisher");
  assert.equal(editor.apply().ok, true);

  const afterUrl = JSON.parse(readFileSync(temporary.file, "utf8"));
  assert.equal(afterUrl.relayUrl, "wss://autre.vassi.click/publisher");
  assert.equal(afterUrl.publisherToken, SECRET);

  editor.setToken("un-autre-jeton-de-publication");
  assert.equal(editor.apply().ok, true);

  const afterToken = JSON.parse(readFileSync(temporary.file, "utf8"));
  assert.equal(afterToken.relayUrl, "wss://autre.vassi.click/publisher");
  assert.equal(afterToken.publisherToken, "un-autre-jeton-de-publication");
});

// Ce test verifie que le token quitte la memoire des qu'il est enregistre.
test("efface le brouillon apres l'enregistrement", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);
  editor.setToken(SECRET);
  editor.apply();

  assert.equal(editor.draft.token, "");
  assert.equal(editor.draft.relayUrl, "");
});

// Ce test verifie que Max peut couper un symbole sur ses espaces sans casser la valeur.
// Un token colle depuis un gestionnaire de mots de passe emporte souvent un espace de bordure.
test("recolle les morceaux d'un symbole et enleve les espaces de bordure", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(" ", RELAY, " ");
  editor.setToken(" ", SECRET, " ");
  assert.equal(editor.apply().ok, true);

  const written = JSON.parse(readFileSync(temporary.file, "utf8"));
  assert.equal(written.relayUrl, RELAY);
  assert.equal(written.publisherToken, SECRET);
});

// Ce test verifie qu'une adresse refusee donne une raison courte au lieu d'une exception.
// Le device tourne dans Node for Max : une exception non capturee y arreterait tout le script.
test("refuse une adresse inutilisable sans lever d'exception", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl("ws://live.vassi.click/publisher");
  editor.setToken(SECRET);

  const result = editor.apply();
  assert.equal(result.ok, false);
  assert.equal(result.code, "config_url_non_chiffree");
  assert.match(result.text, /wss:/);
});

// Ce test verifie qu'un premier enregistrement sans token est refuse proprement.
test("refuse un premier enregistrement sans token", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);

  const result = editor.apply();
  assert.equal(result.ok, false);
  assert.equal(result.code, "config_token_absent");
  assert.match(result.text, /token/);
});

// Ce test verifie que ce qui part vers Max ne contient jamais le token, seulement son indice.
test("decrit la configuration sans jamais rendre le token", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);
  editor.setToken(SECRET);
  editor.apply();

  const status = editor.status();
  assert.equal(status.ready, true);
  assert.equal(status.relayUrl, RELAY);
  assert.equal(status.tokenHint, SECRET.slice(-4));
  assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET));
});

// Ce test verifie qu'un token trop court ne recoit aucun indice : montrer quatre caracteres sur
// six reviendrait a le montrer presque entier.
test("ne donne aucun indice pour un token trop court", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  editor.setRelayUrl(RELAY);
  editor.setToken("court");
  editor.apply();

  assert.equal(editor.status().tokenHint, "");
});

// Ce test verifie l'etat affiche avant toute configuration : le device doit le dire, pas planter.
test("annonce une configuration absente", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const status = new ConfigEditor().status();
  assert.equal(status.ready, false);
  assert.equal(status.relayUrl, "");
  assert.equal(status.tokenHint, "");
  assert.match(status.detail, /config_absente/);
});

// Ce test verifie la phrase affichee par le device. C'est le seul texte qui traverse le pont vers
// Max : il doit se lire sans connaitre les codes du projet, et ne jamais porter le token.
test("rend une phrase lisible pour le device", (t) => {
  const temporary = useTemporaryConfig();
  t.after(temporary.cleanup);

  const editor = new ConfigEditor();
  const missing = editor.deviceStatus();
  assert.equal(missing.ready, false);
  assert.doesNotMatch(missing.text, /config_/);
  assert.match(missing.text, /collez/);

  editor.setRelayUrl(RELAY);
  editor.setToken(SECRET);
  editor.apply();

  const ready = editor.deviceStatus();
  assert.equal(ready.ready, true);
  assert.match(ready.text, new RegExp(RELAY));
  assert.match(ready.text, new RegExp(`token \\.\\.\\.${SECRET.slice(-4)}`));
  assert.doesNotMatch(ready.text, new RegExp(SECRET));
});

// Ce test verifie qu'aucun code brut n'arrive dans le device. Un code affiche tel quel demanderait
// d'ouvrir le code source pour comprendre ce qu'il faut corriger.
test("traduit chaque code de configuration connu", () => {
  const { reasonInFrench } = require("../device/node/config-editor.js");

  for (const code of [
    "config_absente",
    "config_illisible",
    "config_json_invalide",
    "config_url_absente",
    "config_url_invalide",
    "config_url_non_chiffree",
    "config_token_absent",
  ]) {
    const phrase: string = reasonInFrench(code);
    assert.doesNotMatch(phrase, /config_/);
    assert.ok(phrase.length > 10, `phrase trop courte pour ${code}`);
  }

  assert.doesNotMatch(reasonInFrench("code_inconnu"), /code_inconnu/);
});
