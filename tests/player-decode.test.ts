import assert from "node:assert/strict";
import test from "node:test";

import { encodeAudioPacket } from "../src/protocol/audio-packet.ts";
import { createSharedSink, FrameDecoder } from "../src/player/decode-worker.js";
import type { DecoderNote } from "../src/player/decode-worker.d.ts";
import { createPcmBuffer, PcmRing } from "../src/player/pcm-worklet.js";
import { CollectingSink, frequencyOf, levelOf, readFixturePackets, SAMPLE_RATE } from "./opus-fixture.ts";

// Ce fichier decode la vraie fixture Opus avec le vrai decodeur du player. Il verifie le seul point
// qu'aucun test de structure ne peut couvrir : les echantillons qui sortent sont bien le son qui
// est entre, sur le bon canal.

// La fixture porte cette session, fixee par l'outil qui la produit.
const FIXTURE_SESSION_ID = 1;

// Cette capacite est celle du player : trois secondes a 48 kHz.
const CAPACITY_FRAMES = 48000 * 3;

// Cette fonction cree un decodeur pret a l'emploi, branche sur une file qui garde tout.
async function makeDecoder(): Promise<{ decoder: FrameDecoder; sink: CollectingSink; notes: DecoderNote[] }> {
  const sink = new CollectingSink();
  const notes: DecoderNote[] = [];
  const decoder = new FrameDecoder(sink, (note) => notes.push(note));

  await decoder.start();
  decoder.setSession(FIXTURE_SESSION_ID);
  decoder.setAccepting(true);
  // L'ouverture de session vide deja la file : le compteur repart de zero pour que chaque test ne
  // mesure que ses propres vidages.
  sink.clears = 0;

  return { decoder, sink, notes };
}

// Ce test verifie que la fixture est un flux Opus complet et regulier.
test("la fixture contient dix secondes de paquets Opus reguliers", () => {
  const packets = readFixturePackets();

  assert.equal(packets.length, 500);
  assert.ok(packets.every((packet) => packet.byteLength > 28));
});

// Ce test couvre la premiere verification courte du bloc : le son sort en stereo, sans inversion des
// canaux. La fixture porte un sinus 440 Hz a gauche et 880 Hz a droite.
test("decode la fixture en stereo avec les deux canaux a leur place", async (t) => {
  const { decoder, sink } = await makeDecoder();
  t.after(() => decoder.stop());

  for (const packet of readFixturePackets()) {
    await decoder.push(packet);
  }

  assert.equal(sink.left.length, 500 * 960);
  assert.equal(sink.right.length, sink.left.length);

  // Les cent premieres millisecondes sont ignorees : l'encodeur Opus a besoin de quelques frames
  // avant d'etre a son regime normal.
  const debut = SAMPLE_RATE / 10;
  const gauche = sink.left.slice(debut);
  const droite = sink.right.slice(debut);

  assert.ok(Math.abs(frequencyOf(gauche) - 440) < 15, `gauche mesuree a ${frequencyOf(gauche)} Hz`);
  assert.ok(Math.abs(frequencyOf(droite) - 880) < 15, `droite mesuree a ${frequencyOf(droite)} Hz`);
  assert.ok(levelOf(gauche) > 0.05);
  assert.ok(levelOf(droite) > 0.05);
});

// Ce test verifie qu'un paquet d'une autre session est jete sans etre decode. Sans cette regle, un
// paquet en retard d'un direct precedent entrerait dans le son du direct courant.
test("jette les paquets d'une autre session", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packet = readFixturePackets()[0];
  assert.ok(packet !== undefined);

  const etranger = new Uint8Array(packet);
  // L'identifiant de session occupe les quatre octets a partir du huitieme.
  new DataView(etranger.buffer).setUint32(8, 999);

  await decoder.push(etranger);

  assert.equal(sink.left.length, 0);
  assert.deepEqual(notes, [{ type: "refused", reason: "session_mismatch" }]);
});

// Ce test verifie qu'un paquet abime est refuse sans arreter le player. Un octet perdu ne doit pas
// couper l'ecoute du professeur.
test("refuse un paquet abime et continue de decoder les suivants", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const premier = packets[0];
  const second = packets[1];
  assert.ok(premier !== undefined && second !== undefined);

  await decoder.push(premier.subarray(0, 20));
  assert.equal(notes[0]?.type, "refused");

  await decoder.push(premier);
  await decoder.push(second);
  assert.equal(sink.left.length, 2 * 960);
});

// Ce test verifie qu'un trou dans les numeros de sequence est traite comme une discontinuite. Le
// relais ne modifie jamais un paquet : quand il abandonne les paquets d'un auditeur en retard, le
// trou de sequence est le seul indice, et le player doit le reconnaitre.
test("traite un trou de sequence comme une discontinuite", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();

  await decoder.push(packets[0] as Uint8Array);
  await decoder.push(packets[1] as Uint8Array);
  assert.equal(sink.left.length, 2 * 960);
  assert.equal(notes.length, 0);

  // Ce paquet saute deux numeros. Le trou vient donc du reseau, apres l'envoi : seul le relais jette
  // des paquets deja transmis. Il est comble sur place, sans rien jeter de ce qui est deja decode.
  await decoder.push(packets[4] as Uint8Array);

  assert.deepEqual(notes, [
    { type: "discontinuity", reason: "relay_drop", missingMs: 40, recovered: true },
  ]);
  // Rien n'est vide : les deux frames deja decodees sont du bon son, et les jeter ne rapprocherait
  // pas du direct.
  assert.equal(sink.clears, 0);
  // Deux frames decodees, plus les 40 ms du trou ecrites en silence, plus la frame de ce paquet.
  assert.equal(sink.left.length, 5 * 960);
  assert.equal(decoder.stats().concealedMs, 40);
});

// Ce test couvre le seul cas ou vider la file est le bon choix : un trou trop grand pour etre
// comble. Une seconde de silence s'entendrait plus longtemps que la rebufferisation qu'elle evite.
test("jette la file quand le trou depasse le plafond de comblement", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const source = packets[0];
  assert.ok(source !== undefined);

  await decoder.push(source);
  assert.equal(sink.left.length, 960);

  // Ce paquet arrive une seconde plus tard sur la chronologie : 980 ms manquent, bien au-dela des
  // 500 ms comblables.
  const loin = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 50,
    timestampMicros: 1000000n,
    payload: source.subarray(28),
    flags: 0,
  });

  await decoder.push(loin);

  assert.deepEqual(notes, [
    { type: "discontinuity", reason: "relay_drop", missingMs: 980, recovered: false },
  ]);
  assert.equal(sink.clears, 1);
  assert.equal(sink.left.length, 960);
  assert.equal(decoder.stats().concealedMs, 0);
});

// Ce test decrit un lien degrade qui ne laisse passer qu'un tiers des paquets : un trou toutes les
// quelques trames, pendant longtemps. C'est la situation ou la continuite se joue.
//
// Deux proprietes la definissent, et ce test tient les deux :
//
//   1. la file n'est jamais videe, donc le son deja decode n'est jamais perdu ;
//   2. la chronologie reste exacte — le PCM produit vaut exactement la duree audio couverte, donc la
//      marge anti-gigue ne s'use pas trou apres trou.
//
// La seconde depend entierement du comblement : sans lui la file baisserait de la duree de chaque
// trou, definitivement, et rien ne la ferait remonter.
test("garde la file et la chronologie sur un lien qui perd deux paquets sur trois", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const source = packets[0];
  assert.ok(source !== undefined);

  // Un paquet sur trois arrive, cinquante fois de suite.
  const recus = 50;
  const pas = 3;

  for (let index = 0; index < recus; index += 1) {
    await decoder.push(
      encodeAudioPacket({
        sessionId: FIXTURE_SESSION_ID,
        sequenceNumber: index * pas,
        timestampMicros: BigInt(index * pas) * 20000n,
        payload: source.subarray(28),
        flags: 0,
      }),
    );
  }

  // Aucun vidage : chaque trou laisse intact le son deja accumule.
  assert.equal(sink.clears, 0);

  // Le PCM produit couvre exactement la duree audio du premier au dernier paquet : chaque frame
  // recue, plus chaque trou comble.
  const framesCouvertes = (recus - 1) * pas + 1;
  assert.equal(sink.left.length, framesCouvertes * 960);

  // Chaque trou vaut deux frames manquantes, et il y en a un par paquet sauf le premier.
  assert.equal(decoder.stats().concealedMs, (recus - 1) * 40);

  // Chaque trou est signale comme comble : la machine d'etats n'a donc jamais a rebufferiser.
  assert.equal(notes.length, recus - 1);
  assert.ok(notes.every((note) => note.type === "discontinuity" && note.recovered === true));
});

// Ce test verifie la troisieme origine possible d'un trou : le poste Ableton a perdu de l'audio
// avant de construire le paquet. Aucun numero de sequence n'est saute — l'encodeur ne numerote que
// ce qu'il construit — mais le timestamp avance de la duree perdue.
test("reconnait une perte survenue dans l'encodeur, sans trou de sequence", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const source = packets[0];
  assert.ok(source !== undefined);

  await decoder.push(source);

  // Numero suivant, mais timestamp avance de trois frames au lieu d'une : 40 ms ont disparu chez
  // l'encodeur. Le bit accompagne toujours ce cas, pose par le device.
  const perdu = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 1,
    timestampMicros: 60000n,
    payload: source.subarray(28),
    flags: 1,
  });

  await decoder.push(perdu);

  assert.deepEqual(notes, [
    { type: "discontinuity", reason: "encoder_loss", missingMs: 40, recovered: true },
  ]);
  assert.equal(sink.clears, 0);
  assert.equal(sink.left.length, 4 * 960);
});

// Ce test verifie que le bit de discontinuite pose par le device produit le meme traitement, sans
// que le numero de sequence ait a sauter.
test("traite le bit de discontinuite du device", async (t) => {
  const { decoder, sink, notes } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const source = packets[0];
  assert.ok(source !== undefined);

  await decoder.push(source);

  // Ce paquet reprend le payload de la fixture avec le bit de discontinuite, le numero attendu et
  // le timestamp attendu : le device signale une perte, mais aucune duree ne manque reellement.
  // C'est ce que produit une reconnexion du pont loopback, ou le device se declare non autonome
  // sans qu'aucun temps audio se soit ecoule.
  const marque = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 1,
    timestampMicros: 20000n,
    payload: source.subarray(28),
    flags: 1,
  });

  await decoder.push(marque);

  assert.deepEqual(notes, [
    { type: "discontinuity", reason: "encoder_loss", missingMs: 0, recovered: true },
  ]);
  // Le bit remet le decodeur a zero, comme l'encodeur l'a fait de son cote. Aucune duree ne manque :
  // il n'y a donc rien a combler, et rien a jeter.
  assert.equal(sink.clears, 0);
  assert.equal(sink.left.length, 2 * 960);
});

// Ce test verifie que les paquets recus pendant une pause sont jetes. Reprendre doit repartir du
// direct, pas d'un retard egal a la duree de la pause.
test("jette les paquets recus pendant une pause", async (t) => {
  const { decoder, sink } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();

  decoder.setAccepting(false);
  await decoder.push(packets[0] as Uint8Array);
  await decoder.push(packets[1] as Uint8Array);
  assert.equal(sink.left.length, 0);

  decoder.setAccepting(true);
  await decoder.push(packets[2] as Uint8Array);
  assert.equal(sink.left.length, 960);
});

// Ce test traverse la chaine complete du mode partage : paquets du relais, decodage, ecriture dans
// la file, puis lecture comme le fait le processeur audio. C'est le seul test qui relie les trois
// pieces, avec le vrai code des trois. Ce qui en sort est ce que le navigateur entendra.
test("rend le son attendu de bout en bout par la file partagee", async (t) => {
  // Le depot d'ecriture et la file relue partagent la meme memoire, exactement comme le worker de
  // decodage et le processeur audio dans un navigateur.
  const memory = createPcmBuffer(false);
  const decoder = new FrameDecoder(createSharedSink(memory, CAPACITY_FRAMES), () => {});
  const reader = new PcmRing(memory, CAPACITY_FRAMES);
  t.after(() => decoder.stop());

  await decoder.start();
  decoder.setSession(FIXTURE_SESSION_ID);
  decoder.setAccepting(true);

  // Cent paquets font deux secondes, bien en dessous des trois secondes de capacite.
  for (const packet of readFixturePackets().slice(0, 100)) {
    await decoder.push(packet);
  }

  assert.equal(reader.available, 100 * 960);

  const left = new Float32Array(reader.available);
  const right = new Float32Array(left.length);
  assert.equal(reader.read(left, right), left.length);
  assert.equal(reader.underruns, 0);
  assert.equal(reader.available, 0);

  // Les cent premieres millisecondes sont ignorees : l'encodeur monte en regime.
  const debut = SAMPLE_RATE / 10;
  const gauche = Array.from(left.subarray(debut));
  const droite = Array.from(right.subarray(debut));

  assert.ok(Math.abs(frequencyOf(gauche) - 440) < 15, `gauche mesuree a ${frequencyOf(gauche)} Hz`);
  assert.ok(Math.abs(frequencyOf(droite) - 880) < 15, `droite mesuree a ${frequencyOf(droite)} Hz`);
  assert.ok(levelOf(gauche) > 0.05);
  assert.ok(levelOf(droite) > 0.05);

  // Une lecture de plus ne trouve rien et rend du silence, sans jamais repeter le dernier bloc.
  const vide = new Float32Array(128);
  const videDroite = new Float32Array(128);
  assert.equal(reader.read(vide, videDroite), 0);
  assert.ok(vide.every((sample) => sample === 0));
  assert.equal(reader.underruns, 1);
});

// Ce test couvre le seul instant ou le decodeur attend au milieu d'une frame : la remise a zero qui
// suit une discontinuite.
//
// Une coupure produit les deux evenements a la fois, et dans cet ordre : la frame marquee arrive,
// puis le relais annonce la session suivante. Si la frame reprenait son chemin sans regarder, elle
// deposerait vingt millisecondes du direct precedent en tete de la file que la session neuve vient
// de vider — le seul endroit du moteur ou du son perime peut passer devant du son neuf.
test("abandonne une frame dont la session a change pendant la remise a zero", async (t) => {
  const { decoder, sink } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  const source = packets[0];
  assert.ok(source !== undefined);

  await decoder.push(source);
  assert.equal(sink.left.length, 960);

  // Cette frame porte le bit de discontinuite : son traitement passe donc par la remise a zero.
  const marque = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 1,
    timestampMicros: 20000n,
    payload: source.subarray(28),
    flags: 1,
  });

  // La nouvelle session est annoncee pendant cette remise a zero, et une seule fois : celle que
  // `setSession` enchaine a son tour ne doit pas relancer le meme changement.
  const vraiReset = decoder.resetDecoder.bind(decoder);
  let deja = false;

  decoder.resetDecoder = async (): Promise<void> => {
    await vraiReset();

    if (!deja) {
      deja = true;
      decoder.setSession(2);
    }
  };

  await decoder.push(marque);

  assert.equal(deja, true, "le test doit avoir change la session pendant la remise a zero");
  assert.equal(sink.left.length, 0, "la frame du direct precedent ne doit pas entrer dans la file neuve");
});

// Ce test verifie qu'une nouvelle session vide tout ce qui restait de la precedente.
test("vide le PCM et le decodeur a chaque nouvelle session", async (t) => {
  const { decoder, sink } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();
  await decoder.push(packets[0] as Uint8Array);
  assert.equal(sink.left.length, 960);

  decoder.setSession(2);
  assert.equal(sink.left.length, 0);

  // Les paquets de l'ancienne session ne passent plus.
  await decoder.push(packets[1] as Uint8Array);
  assert.equal(sink.left.length, 0);
});

// Ce test couvre la course entre un vidage et une frame arretee sur son `await`.
//
// Le worker traite `flush` des la reception du message, donc en dehors de la chaine des paquets. Une
// frame marquee discontinue attend la remise a zero du decodeur ; si le vidage tombe pendant cette
// attente, la frame reprend son cours ensuite et ecrit dans une file que le vidage venait de
// nettoyer. Le son ecrit est alors precisement celui que le moteur avait decide de jeter.
//
// La fenetre est etroite — seule une discontinuite la produit — mais elle est reelle, et elle
// s'ouvre au pire moment : pendant le rattrapage qui suit un reveil, ou les discontinuites et les
// vidages arrivent ensemble.
test("abandonne une frame en vol quand un vidage la depasse", async (t) => {
  const { decoder, sink } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();

  // Cette frame est marquee discontinue : son traitement passe par la remise a zero du decodeur,
  // qui est asynchrone.
  const marque = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 900,
    timestampMicros: 0n,
    payload: (packets[1] as Uint8Array).subarray(28),
    flags: 1,
  });

  const enVol = decoder.push(marque);
  // Le vidage arrive pendant que la frame attend : c'est ce que fait le worker sur le message.
  decoder.flush();
  await enVol;

  assert.equal(sink.left.length, 0, "la frame depassee par le vidage ne doit pas entrer dans la file");

  // Le decodeur reste utilisable : les paquets arrives apres le vidage passent normalement.
  await decoder.push(packets[2] as Uint8Array);
  assert.equal(sink.left.length, 960, "un paquet posterieur au vidage est decode comme avant");
});

// Ce test verifie que la frame abandonnee n'est comptee ni acceptee ni refusee. Le compteur de
// paquets refuses sert a reperer un decodeur qui ne sait pas lire ce qu'on lui donne ; une frame
// jetee par decision du moteur n'a rien a y faire, et la fiche de validation exige qu'il reste a
// zero pendant tout l'essai.
test("ne compte pas comme refusee une frame depassee par un vidage", async (t) => {
  const { decoder } = await makeDecoder();
  t.after(() => decoder.stop());

  const packets = readFixturePackets();

  const marque = encodeAudioPacket({
    sessionId: FIXTURE_SESSION_ID,
    sequenceNumber: 900,
    timestampMicros: 0n,
    payload: (packets[1] as Uint8Array).subarray(28),
    flags: 1,
  });

  const enVol = decoder.push(marque);
  decoder.flush();
  await enVol;

  assert.equal(decoder.stats().refused, 0, "aucun refus : la frame etait lisible, elle etait perimee");
});
