import type { PlayerState } from "./player-state.ts";

// Ce module range une panne du moteur audio dans la bonne famille. Il ne mesure rien lui-meme : il
// lit les compteurs deja tenus par le player et rend une seule phrase.
//
// Il existe parce que les trois pannes possibles se ressemblent toutes de l'exterieur : dans les
// trois cas, le son ne sort pas. Distinguer « le relais ne parle plus », « le decodeur ne rend
// rien » et « le thread audio s'est arrete » a l'oreille est impossible ; avec les compteurs, c'est
// immediat. La fonction est pure, donc elle se teste sous Node, panne par panne.

// Ces trois familles couvrent tout ce qui peut mal tourner entre le relais et le haut-parleur.
export type DiagnosticArea = "network" | "decode" | "audio";

// Cette valeur decrit l'avancement du contexte audio, que la machine d'etats ne connait pas :
// elle raisonne sur le direct, pas sur les pieces du navigateur.
export type AudioStage = "IDLE" | "STARTING" | "RUNNING" | "FAILED" | "CLOSED";

// Ce type rassemble tout ce que le moteur sait de lui-meme a un instant donne.
export type PlayerDiagnostics = {
  state: PlayerState;
  sessionId: number | null;
  // Debit annonce par la session, en bits par seconde, ou `null` hors direct. C'est un plafond : le
  // device produit en dessous des qu'il juge que le lien ne suit plus.
  sessionBitrate: number | null;
  targetBufferMs: number;
  shared: boolean;

  // Reseau : ce qui arrive du relais.
  connected: boolean;
  packets: number;
  // Octets audio recus depuis la connexion. Rapporte a une duree, il donne le debit reellement porte
  // par le lien, en-tetes du protocole compris.
  bytes: number;
  sincePacketMs: number | null;
  // Duree ecoulee depuis l'annonce de la session en cours, ou `null` hors direct. Elle remplace la
  // precedente tant qu'aucun paquet n'est arrive.
  sinceLiveMs: number | null;

  // Decodage : ce que le worker fait de ces paquets.
  accepted: number;
  decoded: number;
  refused: number;
  lastRefusal: string | null;
  discontinuities: number;
  // Duree totale comblee par du silence, en millisecondes. C'est la mesure de ce que le lien a
  // perdu, independante de tout seuil et jamais remise a zero pendant une session.
  concealedMs: number;
  // Ou le son a disparu la derniere fois, et combien il en manquait :
  // `publisher_drop` sur le lien montant du poste Ableton, `encoder_loss` dans son encodeur ou son
  // pont, `relay_drop` entre le relais et cet auditeur.
  lastGapReason: string | null;
  lastGapMs: number | null;

  // Audio : ce que le contexte et le processeur font des echantillons.
  audio: AudioStage;
  contextState: string | null;
  bufferedMs: number;
  underruns: number;
  overflows: number;
  // Nombre de sauts au direct decides par le processeur audio lui-meme, quand une rafale a distance
  // le vidage. Ce compteur ne change aucun verdict : il dit ou regarder quand le son a saute sans
  // qu'aucune rebufferisation ne l'explique.
  skips: number;
  sinceLevelMs: number | null;

  errorReason: string | null;
  errorArea: DiagnosticArea | null;
};

// Ce type est la reponse rendue : une famille et une phrase lisible. `ok` veut dire que rien ne
// cloche, `idle` que le moteur attend quelque chose qui ne depend pas de lui.
export type PlayerVerdict = {
  area: DiagnosticArea | "ok" | "idle";
  message: string;
};

// Un direct qui n'envoie plus rien pendant deux secondes a un probleme de reseau : le relais envoie
// cinquante paquets par seconde, et son ping toutes les vingt secondes garde la connexion ouverte
// meme sans audio.
export const SILENT_NETWORK_MS = 2000;

// Le processeur audio annonce son niveau toutes les quarante millisecondes environ. Un demi-seconde
// sans nouvelle veut dire que le thread audio ne tourne plus : contexte suspendu, onglet gele, ou
// peripherique de sortie disparu.
export const AUDIO_STALL_MS = 500;

// Une demi-seconde de paquets acceptes sans une seule frame decodee est une panne de decodage, pas
// un demarrage lent.
export const DECODE_SAMPLE = 25;

// Cette fonction range l'etat courant du moteur dans une famille.
//
// L'ordre des regles compte : la cause la plus en amont l'emporte. Un relais muet produit forcement
// une file vide, donc il faut le reconnaitre avant de conclure a une panne de decodage.
export function explainPlayer(diagnostics: PlayerDiagnostics): PlayerVerdict {
  if (diagnostics.state === "ERROR") {
    return {
      area: diagnostics.errorArea ?? "audio",
      message: `panne definitive : ${diagnostics.errorReason ?? "raison inconnue"}`,
    };
  }

  if (!diagnostics.connected) {
    return { area: "network", message: "pas de connexion au relais" };
  }

  if (diagnostics.sessionId === null) {
    return { area: "idle", message: "le relais est joignable mais aucun direct n'est en cours" };
  }

  // Le silence se mesure depuis le dernier paquet, ou depuis l'annonce du direct tant qu'aucun
  // paquet n'est arrive. Sans ce second point de depart, le cas le plus franc — un direct annonce
  // qui n'envoie jamais rien — n'aurait aucune duree a comparer et passerait pour un demarrage.
  const silenceMs = diagnostics.sincePacketMs ?? diagnostics.sinceLiveMs;

  if (silenceMs !== null && silenceMs > SILENT_NETWORK_MS) {
    const seconds = Math.round(silenceMs / 1000);
    const jamais = diagnostics.sincePacketMs === null ? " recu" : "";

    return { area: "network", message: `direct annonce mais aucun paquet${jamais} depuis ${seconds} s` };
  }

  if (diagnostics.audio === "IDLE") {
    return { area: "idle", message: "le son n'a pas encore ete demande" };
  }

  if (diagnostics.audio === "STARTING") {
    return { area: "idle", message: "le contexte audio demarre" };
  }

  if (diagnostics.audio === "CLOSED") {
    return { area: "idle", message: "le moteur est ferme" };
  }

  if (diagnostics.contextState !== null && diagnostics.contextState !== "running") {
    return { area: "audio", message: `contexte audio ${diagnostics.contextState}` };
  }

  if (diagnostics.sinceLevelMs !== null && diagnostics.sinceLevelMs > AUDIO_STALL_MS) {
    const seconds = (diagnostics.sinceLevelMs / 1000).toFixed(1);
    return { area: "audio", message: `le thread audio ne rend plus la main depuis ${seconds} s` };
  }

  if (diagnostics.accepted >= DECODE_SAMPLE && diagnostics.decoded === 0) {
    const cause = diagnostics.lastRefusal ?? "aucune frame rendue";
    return { area: "decode", message: `les paquets arrivent mais rien n'est decode : ${cause}` };
  }

  if (diagnostics.state === "PAUSED") {
    return { area: "idle", message: "l'auditeur a coupe le son" };
  }

  return { area: "ok", message: "rien a signaler" };
}
