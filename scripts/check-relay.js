import { WebSocket } from "ws";

// Ce script verifie un relais deja deploye, depuis l'exterieur, comme le ferait un navigateur.
// Il repond a la question que la roadmap laisse ouverte : « la connexion `wss://` reelle
// fonctionne-t-elle ? »
//
// Usage : npm run relay:check -- https://live.vassi.click
//
// Il ne demande aucun token : il ne verifie que ce qui est public, la route de sante et le chemin
// listener. Un token n'a rien a faire dans une ligne de commande ni dans un historique de console.

const target = process.argv[2];

if (target === undefined) {
  console.error("Usage : npm run relay:check -- https://<domaine-du-relais>");
  process.exit(1);
}

const base = new URL(target);
const secure = base.protocol === "https:" || base.protocol === "wss:";
const listenerUrl = `${secure ? "wss" : "ws"}://${base.host}/listener`;
const healthUrl = `${secure ? "https" : "http"}://${base.host}/health`;

// Cette fonction affiche une ligne de resultat lisible.
function report(ok, label, detail = "") {
  console.log(`${ok ? "OK  " : "ECHEC"} ${label}${detail === "" ? "" : ` : ${detail}`}`);
  return ok;
}

// Cette fonction interroge la route de sante et verifie sa forme.
async function checkHealth() {
  try {
    const response = await fetch(healthUrl);

    if (!response.ok) {
      return report(false, "route de sante", `code ${response.status}`);
    }

    const body = await response.json();

    if (body.status !== "ok" || typeof body.listeners !== "number") {
      return report(false, "route de sante", "reponse inattendue");
    }

    report(true, "route de sante", `live=${body.live}, auditeurs=${body.listeners}, uptime=${body.uptimeSeconds}s`);
    return true;
  } catch (error) {
    return report(false, "route de sante", error instanceof Error ? error.message : "inconnue");
  }
}

// Cette fonction ouvre une vraie connexion listener et attend le premier `stream_state`. C'est ce
// qui prouve que le certificat TLS et le proxy de l'hebergeur laissent bien passer le WebSocket.
function checkListener() {
  return new Promise((resolve) => {
    const socket = new WebSocket(listenerUrl, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(report(false, "connexion listener", "aucun etat recu en dix secondes"));
    }, 10000);

    socket.on("message", (data) => {
      clearTimeout(timer);

      try {
        const message = JSON.parse(data.toString());
        const ok = message.type === "stream_state" && message.protocolVersion === 1;
        resolve(report(ok, "connexion listener", ok ? `live=${message.live}` : "premier message inattendu"));
      } catch {
        resolve(report(false, "connexion listener", "message illisible"));
      }

      socket.close();
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(report(false, "connexion listener", error.message));
    });
  });
}

// Cette fonction verifie que le chemin publisher refuse une connexion sans token. Elle ne devine
// aucun token : elle verifie seulement que le relais ferme la connexion au lieu de l'accepter.
function checkPublisherIsClosed() {
  return new Promise((resolve) => {
    const url = `${secure ? "wss" : "ws"}://${base.host}/publisher`;
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(report(false, "chemin publisher protege", "connexion restee ouverte"));
    }, 8000);

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "publisher_auth", protocolVersion: 1, token: "token_manifestement_faux" }));
    });

    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve(report(code === 1008, "chemin publisher protege", `ferme avec le code ${code}`));
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(report(false, "chemin publisher protege", error.message));
    });
  });
}

console.log(`Verification de ${base.host}\n`);

const results = [await checkHealth(), await checkListener(), await checkPublisherIsClosed()];

console.log("");

if (results.every((ok) => ok)) {
  console.log(`Relais utilisable. URL a donner au device : ${secure ? "wss" : "ws"}://${base.host}/publisher`);
  process.exit(0);
}

console.log("Le relais n'est pas encore utilisable. Voir docs/deploiement-sliplane.md.");
process.exit(1);
