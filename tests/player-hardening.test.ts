import assert from "node:assert/strict";
import test from "node:test";

import { AudioPlayer } from "../src/player/audio-player.ts";
import { explainPlayer } from "../src/player/player-diagnostics.ts";
import { LATE_MARGIN_MS } from "../src/player/player-state.ts";
import {
  FakeAudioContext,
  FakeAudioWorkletNode,
  FakeWorker,
  installBrowserFakes,
} from "./browser-fakes.ts";
import { audioPacket, startLive, startRelay, waitFor, type TestRelay } from "./relay-harness.ts";

// Ce fichier verifie ce que le player fait quand quelque chose tourne mal. Le bloc 8 verifiait le
// chemin normal ; celui-ci verifie les chemins que personne n'emprunte volontairement.
//
// Chaque panne testee ici est arrivee, ou peut arriver, dans un navigateur reel : une page fermee
// pendant le chargement, un decodeur qui ne compile pas, un worker qui meurt en cours de direct, un
// contexte audio suspendu par le systeme. Aucune ne se voit a l'oreille autrement que par un
// silence.

// Cette horloge remplacable evite d'attendre reellement pour mesurer des durees.
class Horloge {
  private value = 1000;

  now = (): number => this.value;

  avance(ms: number): void {
    this.value += ms;
  }
}

type Montage = {
  relay: TestRelay;
  player: AudioPlayer;
  publisher: Awaited<ReturnType<typeof startLive>>;
  horloge: Horloge;
  restore: () => void;
};

// Cette fonction demarre un relais, un direct et un player pret a jouer.
async function startPlayer(options: { isolated?: boolean; sessionId?: number } = {}): Promise<Montage> {
  const restore = installBrowserFakes({ isolated: options.isolated ?? true });
  const relay = await startRelay();
  const sessionId = options.sessionId ?? 4242;
  const publisher = await startLive(relay, sessionId);
  const horloge = new Horloge();

  const player = new AudioPlayer(
    {
      relayUrl: relay.listenerUrl,
      workerUrl: "/decode-worker.js",
      workletUrl: "/pcm-worklet.js",
    },
    () => {},
    { now: horloge.now },
  );

  player.connect();
  await waitFor(() => player.status().state === "READY", "direct annonce a la page");

  return { relay, player, publisher, horloge, restore };
}

// Cette fonction ferme tout ce qu'un test a ouvert.
async function stopPlayer(montage: Montage): Promise<void> {
  await montage.player.close();
  await montage.relay.close();
  montage.restore();
}

// Ce test couvre l'arret pendant le chargement.
//
// `addModule` peut prendre du temps, et une page peut disparaitre entre-temps : le professeur ferme
// l'onglet, ou le composant Svelte du bloc 9 est demonte. Sans attente, la fermeture laisserait
// derriere elle un contexte audio et un worker crees apres coup, que plus rien ne referme, et le
// son continuerait de sortir d'une page qui n'existe plus.
test("ferme proprement quand la fermeture arrive pendant le chargement du processeur", async (t) => {
  const montage = await startPlayer();
  t.after(async () => {
    await montage.relay.close();
    montage.restore();
  });

  // Le chargement du module est retenu : la fermeture arrive donc au milieu du demarrage.
  let ouvrirLaPorte = (): void => {};
  FakeAudioContext.moduleGate = new Promise<void>((resolve) => {
    ouvrirLaPorte = resolve;
  });

  const lecture = montage.player.play();
  await waitFor(() => FakeAudioContext.last !== null, "contexte audio cree");

  const fermeture = montage.player.close();
  ouvrirLaPorte();
  await Promise.all([lecture, fermeture]);

  const context = FakeAudioContext.last;
  assert.ok(context !== null);
  assert.equal(context.state, "closed", "le contexte cree avant la fermeture doit etre ferme");

  // Rien n'a ete construit apres la fermeture.
  assert.equal(FakeAudioContext.created.length, 1);
  assert.equal(FakeAudioWorkletNode.last, null, "aucun noeud audio ne doit naitre apres la fermeture");
  assert.equal(FakeWorker.last, null, "aucun worker ne doit naitre apres la fermeture");
  assert.equal(montage.player.diagnostics().audio, "CLOSED");
});

// Ce test verifie qu'un player ferme reste ferme. Un clic sur Play arrive apres coup ne doit rien
// rebatir.
test("ignore un clic sur Play apres la fermeture", async (t) => {
  const montage = await startPlayer();
  t.after(async () => {
    await montage.relay.close();
    montage.restore();
  });

  await montage.player.close();
  await montage.player.play();

  assert.equal(FakeAudioContext.created.length, 0);
  assert.equal(montage.player.diagnostics().audio, "CLOSED");
});

// Ce test couvre la fermeture pendant une reconnexion. Le socket doit lacher sa tentative en cours
// au lieu de revenir toucher une machine d'etats demontee.
test("ferme proprement pendant une reconnexion", async (t) => {
  const montage = await startPlayer();
  t.after(() => montage.restore());

  await montage.player.play();

  // Le relais disparait : le socket entre dans son escalier de reconnexion.
  await montage.relay.close();
  await waitFor(() => montage.player.status().state === "OFFLINE", "coupure vue par le player");

  await montage.player.close();

  const apres = montage.player.diagnostics();
  assert.equal(apres.audio, "CLOSED");
  assert.equal(apres.connected, false);

  // Rien ne doit revenir apres la fermeture : ni reconnexion, ni changement d'etat.
  const etat = montage.player.status().state;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(montage.player.status().state, etat);
});

// Ce test couvre un navigateur qui ne fournit pas `audioWorklet`.
//
// La propriete n'existe que dans un contexte securise : une page en `https://`, ou servie depuis
// `localhost`. Une page en `http://` venue d'une autre machine n'en a pas — c'est ce qui arrive en
// ouvrant la page de test depuis un telephone sur le reseau local. La panne doit se nommer, sinon
// elle se presente sous la forme d'une erreur de propriete indefinie qui n'indique rien a corriger.
test("nomme l'absence d'audioWorklet au lieu d'une erreur de propriete", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  FakeAudioContext.sansAudioWorklet = true;
  await montage.player.play();

  const diagnostics = montage.player.diagnostics();
  assert.equal(diagnostics.state, "ERROR");
  assert.equal(diagnostics.errorReason, "audioworklet_unavailable");
  assert.equal(explainPlayer(diagnostics).area, "audio");

  // Le contexte a moitie construit est ferme : rien ne survit a l'echec.
  const context = FakeAudioContext.last;
  assert.ok(context !== null);
  assert.equal(context.state, "closed");
});

// Ce test couvre un decodeur qui ne demarre pas : WebAssembly refuse, memoire insuffisante, module
// bloque par une politique du site. La panne doit etre nommee et rangee dans le decodage.
test("nomme une panne du decodeur et la range dans le decodage", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  FakeWorker.failOnConfigure = true;
  await montage.player.play();

  const diagnostics = montage.player.diagnostics();
  assert.equal(diagnostics.state, "ERROR");
  assert.equal(diagnostics.errorReason, "opus_start_failed");
  assert.equal(explainPlayer(diagnostics).area, "decode");

  // Les pieces a moitie construites sont jetees : aucun contexte audio ne survit a l'echec.
  const context = FakeAudioContext.last;
  assert.ok(context !== null);
  assert.equal(context.state, "closed");
});

// Ce test couvre un worker qui meurt pendant le direct.
//
// Le branchement d'erreur du demarrage ne sert plus une fois la promesse resolue : sans un second
// branchement, la mort du worker ne dirait rien du tout et la page resterait en lecture, muette.
test("signale un worker qui meurt pendant le direct", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.equal(montage.player.status().state, "PLAYING");

  worker.crash();

  const diagnostics = montage.player.diagnostics();
  assert.equal(diagnostics.state, "ERROR");
  assert.equal(diagnostics.errorReason, "worker_failed");
  assert.equal(explainPlayer(diagnostics).area, "decode");
});

// Ce test verifie la seconde chance. Une page bloquee sur `ERROR` jusqu'au rechargement est une
// mauvaise reponse a une panne passagere : le clic suivant doit tout rebatir a neuf.
test("repart a neuf quand l'auditeur reclique sur Play apres une panne", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  FakeWorker.failOnConfigure = true;
  await montage.player.play();
  assert.equal(montage.player.status().state, "ERROR");

  FakeWorker.failOnConfigure = false;
  await montage.player.play();

  assert.equal(montage.player.status().state, "BUFFERING");
  assert.equal(montage.player.diagnostics().audio, "RUNNING");
  assert.equal(montage.player.diagnostics().errorReason, null);

  // Un contexte et un worker entierement neufs : rien n'est repris de la tentative ratee.
  assert.equal(FakeAudioContext.created.length, 2);
  assert.equal(FakeWorker.created.length, 2);

  // Le worker neuf apprend la session, sans quoi il refuserait chaque paquet en silence.
  const worker = FakeWorker.last;
  assert.ok(worker !== null);
  assert.deepEqual(worker.messagesOfType("session"), [{ type: "session", sessionId: 4242 }]);

  // Et la lecture repart vraiment.
  const node = FakeAudioWorkletNode.last;
  assert.ok(node !== null);
  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.equal(montage.player.status().state, "PLAYING");
});

// Ce test couvre un changement de session survenu pendant que le moteur etait en panne.
//
// Le relais n'annonce un direct qu'au moment ou il change. Un moteur qui ignorerait ces annonces
// pendant sa panne repartirait sur la session precedente : le decodeur refuserait chaque paquet pour
// session etrangere, la page resterait en bufferisation, et rien ne l'annoncerait. La seconde chance
// du bloc 8b ne servirait alors a rien des que la panne dure plus qu'un direct.
test("apprend la nouvelle session annoncee pendant une panne", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  FakeWorker.failOnConfigure = true;
  await montage.player.play();
  assert.equal(montage.player.status().state, "ERROR");

  // Le direct s'arrete et un autre commence, pendant que la page est bloquee sur l'erreur.
  montage.publisher.stop();
  const suivant = await startLive(montage.relay, 777);
  t.after(() => suivant.stop());
  await waitFor(() => montage.player.diagnostics().sessionId === 777, "nouvelle session enregistree");

  assert.equal(montage.player.status().state, "ERROR", "la panne tient jusqu'au prochain clic");

  FakeWorker.failOnConfigure = false;
  await montage.player.play();

  // Le worker neuf apprend la session du direct en cours, pas celle d'avant la panne.
  const worker = FakeWorker.last;
  assert.ok(worker !== null);
  assert.deepEqual(worker.messagesOfType("session"), [{ type: "session", sessionId: 777 }]);
});

// Ce test verifie que les compteurs de decodage decrivent le worker vivant.
//
// Un worker neuf compte a partir de zero et n'annonce ses compteurs qu'une fois par seconde. Garder
// ceux du worker precedent pendant ce temps ne fait pas qu'afficher un chiffre faux : la regle
// « des paquets acceptes mais rien de decode » ne pourrait plus jamais se declencher, puisque le
// nombre de frames decodees resterait celui d'avant, donc non nul.
test("oublie les compteurs du worker precedent quand un worker neuf demarre", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const premier = FakeWorker.last;
  assert.ok(premier !== null);
  premier.deliver({ type: "stats", accepted: 1500, decoded: 1500, refused: 3, discontinuities: 2, lastRefusal: "x" });
  assert.equal(montage.player.diagnostics().decoded, 1500);

  // Le worker meurt, la page repart : les compteurs affiches ne doivent plus rien devoir a l'ancien.
  premier.crash();
  await montage.player.play();

  const apres = montage.player.diagnostics();
  assert.equal(apres.accepted, 0);
  assert.equal(apres.decoded, 0);
  assert.equal(apres.refused, 0);
  assert.equal(apres.discontinuities, 0);
  assert.equal(apres.lastRefusal, null);
});

// Ce test couvre la borne posee sur la file quand le thread audio s'arrete.
//
// En memoire partagee, la file bute sur ses trois secondes. En mode messages, rien ne borne la file
// d'attente du port : les blocs decodes s'y entassent a 384 ko par seconde tant que le thread audio
// ne les prend pas. Le decodeur cesse donc de remplir des que le contexte n'est plus `running`.
test("arrete de remplir la file quand le contexte audio s'arrete", async (t) => {
  const montage = await startPlayer({ isolated: false });
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const context = FakeAudioContext.last;
  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(context !== null && node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.deepEqual(worker.messagesOfType("accepting"), [{ type: "accepting", accepting: true }]);

  // Le systeme suspend le contexte : appel telephonique, peripherique debranche, onglet gele. La
  // reprise suit aussitot, donc les trois ordres decrivent l'aller et le retour.
  context.interrupt("suspended");
  assert.equal(context.state, "running", "le contexte suspendu doit etre repris");

  assert.deepEqual(
    worker.messagesOfType("accepting"),
    [
      { type: "accepting", accepting: true },
      { type: "accepting", accepting: false },
      { type: "accepting", accepting: true },
    ],
    "le decodeur cesse de remplir une file que personne ne vide, et reprend au retour",
  );
});

// Ce test couvre le thread audio arrete alors que le contexte se dit toujours `running`.
//
// C'est ce que fait une mise en veille du portable, un onglet gele ou un peripherique de sortie qui
// bafouille : `onstatechange` ne dit rien, et la seule preuve de l'arret est l'absence de niveau
// annonce. Le decodeur ne doit pas continuer de remplir une file que personne ne vide. En memoire
// partagee, il compterait des blocs abandonnes par centaines ; en mode messages, la file d'attente
// du port grossirait sans aucune limite, a 384 ko par seconde.
test("arrete de remplir la file quand le thread audio ne rend plus la main", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const context = FakeAudioContext.last;
  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(context !== null && node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.deepEqual(worker.messagesOfType("accepting"), [{ type: "accepting", accepting: true }]);

  // Le thread audio se tait pendant une seconde, alors que le relais, lui, continue d'envoyer.
  montage.horloge.avance(1000);
  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => montage.player.diagnostics().packets === 1, "paquet recu pendant l'arret");

  assert.equal(context.state, "running", "le contexte ne signale rien : c'est tout le probleme");
  assert.deepEqual(
    worker.messagesOfType("accepting"),
    [{ type: "accepting", accepting: true }, { type: "accepting", accepting: false }],
    "le decodeur cesse de remplir une file que personne ne vide",
  );

  // Le thread audio revient : le remplissage reprend, sur du son neuf.
  node.port.deliver({ type: "level", availableMs: 0, underruns: 1, overflows: 0 });

  assert.deepEqual(
    worker.messagesOfType("accepting"),
    [
      { type: "accepting", accepting: true },
      { type: "accepting", accepting: false },
      { type: "accepting", accepting: true },
    ],
    "le remplissage reprend des le premier niveau annonce",
  );
});

// Ce test verifie que le meme arret est borne en mode messages, ou rien d'autre ne borne la file.
test("borne aussi la file d'attente du port quand le thread audio s'arrete", async (t) => {
  const montage = await startPlayer({ isolated: false });
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });

  montage.horloge.avance(1000);
  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => montage.player.diagnostics().packets === 1, "paquet recu pendant l'arret");

  const ordres = worker.messagesOfType("accepting");
  assert.deepEqual(ordres[ordres.length - 1], { type: "accepting", accepting: false });
});

// Ce test verifie qu'un silence plus court que le seuil ne coupe rien : le niveau annonce arrive
// toutes les quarante millisecondes, mais un retard ordinaire ne doit pas interrompre le son.
test("ne coupe pas le remplissage pour un retard ordinaire du thread audio", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });

  montage.horloge.avance(300);
  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => montage.player.diagnostics().packets === 1, "paquet recu");

  assert.deepEqual(worker.messagesOfType("accepting"), [{ type: "accepting", accepting: true }]);
});

// Ce test verifie l'ordre des ordres autour d'un vidage.
//
// Le processeur audio doit cesser de lire avant que la file soit videe. Vider une file qu'il lit
// encore lui fait rendre du silence pendant un bloc ou deux : le compteur de manques de donnees
// monte pour un incident qui n'existe pas, et ce faux manque peut a son tour faire rebufferiser.
test("arrete la lecture avant de vider la file", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.equal(montage.player.status().state, "PLAYING");

  const lecturesAvant = node.port.messagesOfType("pause").length;
  node.port.deliver({ type: "level", availableMs: 400 + LATE_MARGIN_MS + 600, underruns: 0, overflows: 0 });

  assert.equal(node.port.messagesOfType("pause").length, lecturesAvant + 1, "la lecture doit s'arreter");

  // Le rang des deux messages dans leur file respective ne se compare pas directement : ce qui se
  // verifie est que l'arret est parti avant que le thread principal demande le vidage.
  const arret = node.port.sent.find((message) => message.data.type === "pause");
  const vidage = worker.sent.find((message) => message.data.type === "flush");
  assert.ok(arret !== undefined && vidage !== undefined);
  assert.ok(arret.ordre < vidage.ordre, "l'arret de lecture doit partir avant l'ordre de vidage");
});

// Ce test couvre la derive de retard, la panne que rien ne signale.
//
// Un contexte suspendu arrete le thread audio sans arreter le decodeur : la file grossit, et le son
// qu'elle contient vieillit d'autant. La lecture doit repartir du direct, pas de ce son ancien.
test("jette le son devenu vieux quand le thread audio a pris du retard", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.equal(montage.player.status().state, "PLAYING");
  assert.deepEqual(worker.messagesOfType("flush"), []);

  // Le thread audio revient apres une longue absence : la file porte plusieurs secondes de son.
  node.port.deliver({ type: "level", availableMs: 400 + LATE_MARGIN_MS + 600, underruns: 0, overflows: 12 });

  assert.equal(montage.player.status().state, "REBUFFERING");
  assert.deepEqual(worker.messagesOfType("flush"), [{ type: "flush" }], "le son en attente doit etre jete");
  assert.equal(montage.player.diagnostics().overflows, 12);

  // La reprise se fait au seuil habituel, sur du son neuf.
  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 12 });
  assert.equal(montage.player.status().state, "PLAYING");
  assert.deepEqual(worker.messagesOfType("flush").length, 1, "un seul vidage pour un seul retard");
});

// Ce test couvre la suspension elle-meme : le player doit tenter de reprendre, et l'etat du
// contexte doit apparaitre dans le diagnostic.
test("tente de reprendre un contexte audio suspendu par le systeme", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const context = FakeAudioContext.last;
  const node = FakeAudioWorkletNode.last;
  assert.ok(context !== null && node !== null);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  const reprisesAvant = context.resumes;

  // Safari annonce `interrupted` la ou les autres annoncent `suspended`.
  context.interrupt("interrupted");
  await waitFor(() => context.resumes > reprisesAvant, "reprise du contexte demandee");

  assert.equal(context.state, "running");
});

// Ce test verifie qu'un thread audio arrete se voit, meme si le contexte pretend tourner. C'est le
// seul indice disponible quand un onglet est gele : plus aucun niveau n'arrive.
//
// Les paquets continuent d'arriver pendant ce temps : c'est ce qui distingue cette panne d'un relais
// devenu muet, qui produirait le meme silence pour une raison situee bien plus en amont.
test("voit un thread audio qui ne rend plus la main", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  assert.ok(node !== null);
  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => montage.player.diagnostics().packets === 1, "premier paquet recu");

  assert.equal(explainPlayer(montage.player.diagnostics()).area, "ok");

  // Plus aucun niveau n'arrive pendant trois secondes, alors que le reseau, lui, continue.
  montage.horloge.avance(3000);
  montage.publisher.sendBinary(audioPacket(4242, 1, 8));
  await waitFor(() => montage.player.diagnostics().packets === 2, "paquet suivant recu");

  const verdict = explainPlayer(montage.player.diagnostics());
  assert.equal(verdict.area, "audio");
  assert.match(verdict.message, /thread audio/);
});

// Ce test couvre le direct annonce qui n'envoie jamais rien : le relais dit « live », et pas un seul
// paquet ne suit. C'est la panne reseau la plus franche, et c'est celle qui n'avait aucune duree a
// comparer tant que le silence se mesurait depuis le dernier paquet recu.
test("reconnait un direct qui n'a jamais envoye le moindre paquet", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();
  assert.equal(montage.player.diagnostics().packets, 0);

  const node = FakeAudioWorkletNode.last;
  assert.ok(node !== null);
  node.port.deliver({ type: "level", availableMs: 0, underruns: 1, overflows: 0 });

  // Trois secondes apres l'annonce du direct, toujours rien.
  montage.horloge.avance(3000);

  const verdict = explainPlayer(montage.player.diagnostics());
  assert.equal(verdict.area, "network");
  assert.match(verdict.message, /aucun paquet/);
});

// Ce test verifie que les compteurs du diagnostic decrivent vraiment ce qui traverse le moteur, du
// paquet recu jusqu'a la frame decodee.
test("compte ce qui traverse reellement le moteur", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const worker = FakeWorker.last;
  assert.ok(worker !== null);

  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  montage.publisher.sendBinary(audioPacket(4242, 1, 8));
  await waitFor(() => montage.player.diagnostics().packets === 2, "deux paquets recus");

  // Le worker remonte ses propres compteurs une fois par seconde.
  worker.deliver({ type: "stats", accepted: 2, decoded: 2, refused: 0, discontinuities: 0, lastRefusal: null });

  const diagnostics = montage.player.diagnostics();
  assert.equal(diagnostics.packets, 2);
  assert.equal(diagnostics.accepted, 2);
  assert.equal(diagnostics.decoded, 2);
  assert.equal(diagnostics.sincePacketMs, 0);
  assert.equal(diagnostics.sessionId, 4242);
  assert.equal(diagnostics.shared, true);

  // Une refusal signalee par le worker est retenue pour l'affichage.
  worker.deliver({ type: "refused", reason: "session_mismatch" });
  assert.equal(montage.player.diagnostics().lastRefusal, "session_mismatch");
});

// Ce test verifie qu'un relais devenu muet est reconnu comme un probleme de reseau, et non comme un
// probleme de decodage. C'est la distinction que la page doit afficher pour eviter de chercher au
// mauvais endroit.
test("reconnait un direct annonce mais muet", async (t) => {
  const montage = await startPlayer();
  t.after(() => stopPlayer(montage));

  await montage.player.play();
  montage.publisher.sendBinary(audioPacket(4242, 0, 7));
  await waitFor(() => montage.player.diagnostics().packets === 1, "premier paquet recu");

  const node = FakeAudioWorkletNode.last;
  assert.ok(node !== null);
  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });

  // Plus rien n'arrive pendant cinq secondes, mais la connexion tient.
  montage.horloge.avance(5000);

  const verdict = explainPlayer(montage.player.diagnostics());
  assert.equal(verdict.area, "network");
  assert.match(verdict.message, /aucun paquet/);
});

// Ce test verifie le mode sans `SharedArrayBuffer` sur les memes pannes : le chemin par messages ne
// doit pas se comporter autrement.
test("garde le meme comportement sans SharedArrayBuffer", async (t) => {
  const montage = await startPlayer({ isolated: false });
  t.after(() => stopPlayer(montage));

  await montage.player.play();

  const node = FakeAudioWorkletNode.last;
  const worker = FakeWorker.last;
  assert.ok(node !== null && worker !== null);

  assert.equal(montage.player.diagnostics().shared, false);

  node.port.deliver({ type: "level", availableMs: 400, underruns: 0, overflows: 0 });
  assert.equal(montage.player.status().state, "PLAYING");

  node.port.deliver({ type: "level", availableMs: 400 + LATE_MARGIN_MS + 600, underruns: 0, overflows: 4 });
  assert.equal(montage.player.status().state, "REBUFFERING");
  assert.deepEqual(worker.messagesOfType("flush"), [{ type: "flush" }]);
});
