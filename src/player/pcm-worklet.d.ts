// Ce fichier decrit `pcm-worklet.js` pour le code TypeScript du thread principal.
//
// Le fichier decrit est ecrit en JavaScript sans aucun `import`, parce qu'un module charge par
// `audioWorklet.addModule()` ne peut pas en utiliser sous Safari. Ces declarations donnent au reste
// du projet les memes verifications de type que le reste du code.

export declare const PCM_PROCESSOR_NAME: string;
export declare const PCM_CHANNELS: number;
export declare const PCM_SAMPLE_RATE: number;
export declare const PCM_CAPACITY_FRAMES: number;
export declare const NET_CEILING_MAX_MS: number;
export declare const CONTROL_WRITE_INDEX: number;
export declare const CONTROL_READ_INDEX: number;
export declare const CONTROL_UNDERRUNS: number;
export declare const CONTROL_OVERFLOWS: number;
export declare const CONTROL_SKIPS: number;
export declare const CONTROL_TRIMS: number;
export declare const RATE_DEADBAND: number;
export declare const RATE_SPAN: number;
export declare const RATE_MAX: number;

// Cette fonction cree la memoire d'une file PCM, partagee entre threads ou non.
export declare function createPcmBuffer(shared: boolean, capacityFrames?: number): ArrayBufferLike;

// Cette classe est la file circulaire d'echantillons stereo lue par le processeur audio.
export declare class PcmRing {
  readonly capacity: number;
  readonly control: Int32Array;
  readonly samples: Float32Array;

  constructor(buffer: ArrayBufferLike, capacityFrames?: number);

  readonly available: number;
  readonly availableMs: number;
  readonly underruns: number;
  readonly overflows: number;
  readonly skips: number;
  readonly trims: number;

  clear(): void;
  // `counter` choisit le compteur qui enregistre l'operation : les sauts du filet par defaut, les
  // ebarbages d'une reprise quand l'appelant passe `CONTROL_TRIMS`.
  dropOldest(keepFrames: number, counter?: number): boolean;
  write(left: Float32Array, right: Float32Array): boolean;
  // `ratio` est la vitesse de lecture, en part de la vitesse nominale.
  read(left: Float32Array, right: Float32Array, ratio?: number): number;
}
