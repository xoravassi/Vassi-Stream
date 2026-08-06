"use strict";

// Ces constantes decrivent l'en-tete interne ecrit par vassi.encoder~.
const MAGIC = Buffer.from("VSF1", "ascii");
const HEADER_SIZE = 20;
const MAX_PAYLOAD_SIZE = 2560;
const MAX_BUFFERED_BYTES = 64 * 1024;

// Cette classe reassemble les frames VSF1 depuis un flux TCP decoupe en morceaux quelconques.
class FrameReader {
	constructor() {
		this.pending = Buffer.alloc(0);
		this.resyncCount = 0;
	}

	// Cette methode oublie les octets en attente quand la connexion repart de zero.
	reset() {
		this.pending = Buffer.alloc(0);
	}

	// Cette methode ajoute un morceau recu et retourne toutes les frames completes qu'il termine.
	push(chunk) {
		this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);

		const frames = [];
		let offset = 0;

		while (this.pending.length - offset >= HEADER_SIZE) {
			const magicOffset = this.findMagic(offset);
			if (magicOffset === -1) {
				// Aucun debut de frame lisible : seuls les trois derniers octets peuvent en commencer une.
				offset = Math.max(offset, this.pending.length - (MAGIC.length - 1));
				break;
			}
			if (magicOffset !== offset) {
				this.resyncCount += 1;
				offset = magicOffset;
				continue;
			}

			const payloadSize = this.pending.readUInt16BE(offset + 18);
			if (payloadSize < 1 || payloadSize > MAX_PAYLOAD_SIZE) {
				// Un en-tete impossible signifie un faux magic : la recherche reprend apres lui.
				this.resyncCount += 1;
				offset += MAGIC.length;
				continue;
			}

			const totalSize = HEADER_SIZE + payloadSize;
			if (this.pending.length - offset < totalSize) {
				break;
			}

			frames.push({
				sequence: this.pending.readUInt32BE(offset + 4),
				timestampMicros: this.pending.readBigUInt64BE(offset + 8),
				flags: this.pending.readUInt8(offset + 16),
				payload: Buffer.from(this.pending.subarray(offset + HEADER_SIZE, offset + totalSize))
			});
			offset += totalSize;
		}

		this.pending = offset === 0 ? this.pending : Buffer.from(this.pending.subarray(offset));

		// Les octets gardes ici valent au plus une frame incomplete, donc moins de 1300 octets.
		// Cette limite reste un dernier garde-fou : un reste impossible est oublie, pas conserve.
		if (this.pending.length > MAX_BUFFERED_BYTES) {
			this.pending = Buffer.alloc(0);
			this.resyncCount += 1;
		}

		return frames;
	}

	// Cette methode cherche le prochain debut de frame a partir d'une position donnee.
	findMagic(offset) {
		return this.pending.indexOf(MAGIC, offset);
	}
}

module.exports = { FrameReader, HEADER_SIZE, MAX_PAYLOAD_SIZE, MAX_BUFFERED_BYTES };
