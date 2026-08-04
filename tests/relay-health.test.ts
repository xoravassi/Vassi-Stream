import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { checkRelay, healthUrlFrom } = require("../device/node/relay-health.js");

type Answer = { status: number; body: string; delayMs?: number };

// Cette fonction ouvre un serveur qui repond une seule chose, sur un port libre.
// Elle remplace le relais : la verification interroge une route HTTP ordinaire.
async function fakeRelay(answer: Answer): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const reply = () => {
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    };

    if (answer.delayMs === undefined) {
      reply();
      return;
    }

    setTimeout(reply, answer.delayMs);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `ws://127.0.0.1:${port}/publisher`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Ce test verifie la conversion d'adresse : le device connait le chemin publisher, pas la sante.
test("deduit la route de sante de l'adresse du publisher", () => {
  assert.equal(healthUrlFrom("wss://live.vassi.click/publisher"), "https://live.vassi.click/health");
  assert.equal(healthUrlFrom("ws://127.0.0.1:8080/publisher"), "http://127.0.0.1:8080/health");
});

// Ce test verifie le cas normal : le relais repond et le device l'annonce.
test("reconnait un relais qui repond", async (t) => {
  const relay = await fakeRelay({ status: 200, body: JSON.stringify({ status: "ok", live: false, listeners: 2 }) });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, true);
  assert.match(result.detail, /joignable/);
  assert.match(result.detail, /2 auditeur/);
});

// Ce test verifie que le direct deja en cours est signale : c'est ce qui explique qu'un second
// device prendrait la place du premier.
test("signale un relais deja en direct", async (t) => {
  const relay = await fakeRelay({ status: 200, body: JSON.stringify({ status: "ok", live: true, listeners: 0 }) });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, true);
  assert.match(result.detail, /deja en direct/);
});

// Ce test verifie qu'une adresse qui repond autre chose n'est pas prise pour le relais.
test("refuse une adresse qui n'est pas le relais", async (t) => {
  const relay = await fakeRelay({ status: 200, body: "<html>page d'accueil</html>" });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, false);
  assert.match(result.detail, /pas le relais/);
});

// Ce test verifie qu'un JSON valide mais etranger est refuse lui aussi.
test("refuse un JSON qui ne vient pas de la route de sante", async (t) => {
  const relay = await fakeRelay({ status: 200, body: JSON.stringify({ hello: "world" }) });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, false);
  assert.match(result.detail, /pas le relais/);
});

// Ce test verifie qu'un code d'erreur est repete tel quel : 502 et 404 ne se corrigent pas pareil.
test("rapporte le code rendu par le serveur", async (t) => {
  const relay = await fakeRelay({ status: 502, body: "" });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, false);
  assert.match(result.detail, /502/);
});

// Ce test verifie qu'un serveur muet ne bloque pas le device pour toujours.
test("abandonne un serveur qui ne repond pas", async (t) => {
  const relay = await fakeRelay({ status: 200, body: "{}", delayMs: 2000 });
  t.after(relay.close);

  const result = await checkRelay(relay.url, { timeoutMs: 120 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /aucune reponse/);
});

// Ce test verifie qu'une adresse fermee donne une raison lisible plutot qu'un code systeme.
test("traduit une connexion refusee", async () => {
  const relay = await fakeRelay({ status: 200, body: "{}" });
  const closedUrl = relay.url;
  await relay.close();

  const result = await checkRelay(closedUrl, { timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /refusee|injoignable/);
});

// Ce test verifie qu'une adresse illisible ne fait pas d'exception : le champ vient d'un collage.
test("refuse une adresse illisible sans lever d'exception", async () => {
  const result = await checkRelay("pas une adresse");
  assert.equal(result.ok, false);
  assert.match(result.detail, /illisible/);
});

// Ce test verifie qu'une reponse enorme est coupee au lieu d'etre gardee en memoire. Une adresse
// qui rend un site entier n'est pas le relais, et le device ne doit pas charger ce site pour
// s'en apercevoir.
test("coupe une reponse trop grande", async (t) => {
  const relay = await fakeRelay({ status: 200, body: "x".repeat(200000) });
  t.after(relay.close);

  const result = await checkRelay(relay.url);
  assert.equal(result.ok, false);
  assert.match(result.detail, /pas le relais/);
});
