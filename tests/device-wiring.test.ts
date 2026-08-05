import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const DEVICE_DIRECTORY = join(process.cwd(), "device", "node");

// Le point d'entree porte un nom unique dans la base de recherche de Max : c'est par ce nom, et
// par lui seul, que le device retrouve son script (voir tests/device-patcher.test.ts).
const ENTRY = "vassi-stream-device.js";

// Cette fonction lit un fichier du device comme texte.
function readDeviceFile(name: string): string {
  return readFileSync(join(DEVICE_DIRECTORY, name), "utf8");
}

// Ce test verifie que le point d'entree relie le pont loopback au publisher.
test("relie le pont loopback au publisher", () => {
  const entry = readDeviceFile(ENTRY);

  assert.match(entry, /require\("\.\/frame-bridge\.js"\)/);
  assert.match(entry, /require\("\.\/publisher\.js"\)/);
  assert.match(entry, /publisher\.sendFrame\(frame\)/);
  assert.match(entry, /Max\.addHandler\("live"/);
  assert.match(entry, /publisher\.start\(selection\)/);
  assert.match(entry, /publisher\.stop\("user_stop"\)/);
});

// Ce test verifie que le device du bloc 5 continue de fonctionner sans modification.
// Le patch de test lit `status`, `port` et `stats` : ces trois sorties doivent survivre.
test("garde les sorties lues par le device du bloc 5", () => {
  const entry = readDeviceFile(ENTRY);

  assert.match(entry, /send\("status", state, detail\)/);
  assert.match(entry, /send\("port", port\)/);
  assert.match(entry, /send\("stats", counters\.frames/);
  assert.match(entry, /Max\.addHandler\("getport"/);
  assert.match(entry, /Max\.addHandler\("reset"/);

  // L'etat du relais sort sur un mot distinct : sans cela, le patch du bloc 5 confondrait
  // l'etat du pont loopback et l'etat de la connexion au relais.
  assert.match(entry, /send\("publisher", state, detail\)/);
});

// Ce test verifie qu'aucun fichier du device n'ecrit dans la console.
// C'est la seule facon simple de garantir qu'un token ne finit jamais dans un log Max.
test("n'ecrit jamais dans la console depuis le device", () => {
  const files = readdirSync(DEVICE_DIRECTORY).filter((name) => name.endsWith(".js"));

  assert.ok(files.length >= 6);

  for (const name of files) {
    const source = readDeviceFile(name);
    assert.doesNotMatch(source, /console\./, `${name} ne doit rien ecrire dans la console`);
    assert.doesNotMatch(source, /Max\.post\(/, `${name} ne doit rien ecrire dans la Max Console`);
  }
});

// Ce test verifie que le token ne sort du module de configuration que vers le message
// d'authentification. Aucun autre fichier du device ne doit toucher a ce champ.
test("limite l'usage du token au message d'authentification", () => {
  const files = readdirSync(DEVICE_DIRECTORY).filter((name) => name.endsWith(".js"));
  const allowed = ["publisher-config.js", "publisher.js"];

  for (const name of files) {
    if (allowed.includes(name)) {
      continue;
    }

    assert.doesNotMatch(readDeviceFile(name), /publisherToken/, `${name} ne doit pas lire le token`);
  }

  const publisher = readDeviceFile("publisher.js");
  const uses = publisher.match(/publisherToken/g) ?? [];
  assert.equal(uses.length, 1);
  assert.match(publisher, /buildAuthMessage\(this\.config\.publisherToken\)/);
});
