import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { inspectAudioPacket } from "../src/protocol/audio-packet.ts";
import type { PcmSink } from "../src/player/decode-worker.d.ts";

// Ce fichier lit la fixture Opus utilisee par les tests du player et rassemble les echantillons
// decodes. La fixture est produite par `npm run fixture:opus`, qui la fabrique avec l'encodeur reel
// du device : les tests decodent donc ce qu'un vrai live transmet.

// Ce chemin pointe la fixture stereo de dix secondes : 440 Hz a gauche, 880 Hz a droite.
export const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/stereo-440-880-256k.vsa1", import.meta.url));

// La sortie du protocole est a 48 kHz.
export const SAMPLE_RATE = 48000;

// Cette fonction decoupe la fixture en paquets VSA1 complets. Chaque paquet porte sa propre taille
// de payload, donc le fichier se relit sans index ni separateur.
export function readFixturePackets(path: string = FIXTURE_PATH): Uint8Array[] {
  const content = new Uint8Array(readFileSync(path));
  const packets: Uint8Array[] = [];
  let position = 0;

  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);

  while (position < content.byteLength) {
    // La taille du payload occupe deux octets a partir du vingt-sixieme. Elle est lue avant toute
    // validation, parce que c'est elle qui donne la fin du paquet a valider.
    const size = 28 + view.getUint16(position + 26);
    const packet = content.slice(position, position + size);

    // Chaque paquet est valide au passage : une fixture abimee doit se voir ici, pas plus loin.
    inspectAudioPacket(packet);
    packets.push(packet);
    position += size;
  }

  return packets;
}

// Cette classe remplace la file PCM dans les tests : elle garde tout ce que le decodeur produit,
// sans limite de taille et sans thread audio.
export class CollectingSink implements PcmSink {
  readonly left: number[] = [];
  readonly right: number[] = [];
  clears = 0;

  clear(): void {
    this.clears += 1;
    this.left.length = 0;
    this.right.length = 0;
  }

  write(left: Float32Array, right: Float32Array, count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.left.push(left[index] ?? 0);
      this.right.push(right[index] ?? 0);
    }
  }
}

// Cette fonction compte les passages par zero d'un signal. Pour un sinus, ce nombre vaut deux fois
// sa frequence par seconde : c'est la facon la plus simple de verifier qu'un canal porte bien le
// son attendu, sans transformee de Fourier et sans dependance supplementaire.
export function frequencyOf(samples: number[], sampleRate = SAMPLE_RATE): number {
  let crossings = 0;
  let previous = samples[0] ?? 0;

  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index] ?? 0;

    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
      crossings += 1;
    }

    previous = current;
  }

  return (crossings * sampleRate) / (2 * samples.length);
}

// Cette fonction donne le niveau moyen d'un signal, utilise pour verifier qu'un canal porte du son.
export function levelOf(samples: number[]): number {
  let total = 0;

  for (const sample of samples) {
    total += sample * sample;
  }

  return samples.length === 0 ? 0 : Math.sqrt(total / samples.length);
}
