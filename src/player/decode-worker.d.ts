// Ce fichier decrit `decode-worker.js` pour le code TypeScript et pour les tests.
//
// Le fichier decrit est ecrit en JavaScript parce qu'il est charge comme worker de module par le
// bundler du site. Ces declarations donnent au reste du projet les memes verifications de type que
// le reste du code.

// Ce type decrit ce que le decodeur signale a son appelant.
export type DecoderNote = {
  type: "discontinuity" | "refused";
  reason: string;
};

// Ce type rassemble les compteurs de diagnostic du decodeur.
export type DecoderStats = {
  accepted: number;
  decoded: number;
  refused: number;
  discontinuities: number;
  lastRefusal: string | null;
};

// Ce type decrit le depot d'echantillons : file partagee ou envoi par un port.
export type PcmSink = {
  clear: () => void;
  write: (left: Float32Array, right: Float32Array, count: number) => void;
};

// Cette classe valide, decode et depose les echantillons dans la file PCM.
export declare class FrameDecoder {
  constructor(sink: PcmSink, notify: (note: DecoderNote) => void);

  start(): Promise<void>;
  stop(): void;
  setSession(sessionId: number): void;
  setAccepting(accepting: boolean): void;
  flush(): void;
  push(bytes: Uint8Array): Promise<void>;
  stats(): DecoderStats;
  // Cette methode applique `OPUS_RESET_STATE`. Elle est asynchrone, et c'est la seule attente au
  // milieu du traitement d'une frame : les tests s'en servent pour placer un evenement exactement
  // dans cet intervalle.
  resetDecoder(): Promise<void>;
}

// Cette fonction cree le depot qui ecrit dans la memoire partagee avec le processeur audio.
export declare function createSharedSink(buffer: ArrayBufferLike, capacityFrames: number): PcmSink;

// Cette fonction cree le depot qui transfere chaque bloc au processeur audio par un port.
export declare function createPortSink(port: MessagePort): PcmSink;
