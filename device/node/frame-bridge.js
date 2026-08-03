"use strict";

const net = require("net");
const { FrameReader } = require("./frame-reader.js");

// Cette classe ecoute en loopback et remet a l'appelant les frames Opus produites par Max.
class FrameBridge {
	constructor(handlers) {
		this.onFrame = handlers.onFrame;
		this.onStatus = handlers.onStatus;
		this.reader = new FrameReader();
		this.connection = null;
		this.port = 0;
		this.server = net.createServer((socket) => this.accept(socket));
		this.server.on("error", (error) => this.onStatus("error", error.message));
	}

	// Cette methode ouvre le port loopback et retourne le numero choisi par le systeme.
	listen() {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			// L'ecoute reste sur 127.0.0.1 : le pont n'est jamais visible depuis le reseau.
			this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				this.server.removeListener("error", reject);
				this.port = this.server.address().port;
				resolve(this.port);
			});
		});
	}

	// Cette methode garde une seule connexion vivante : la plus recente remplace la precedente.
	accept(socket) {
		// L'encodeur ne rouvre le pont qu'apres avoir ferme le sien. Une connexion neuve signifie
		// donc que l'ancienne est morte, meme si Node n'a pas encore recu son evenement close.
		if (this.connection !== null) {
			this.connection.destroy();
		}

		this.connection = socket;
		this.reader.reset();
		socket.setNoDelay(true);
		socket.on("data", (chunk) => this.receive(chunk));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			// Une connexion deja remplacee ne doit pas effacer l'etat de celle qui la remplace.
			if (this.connection !== socket) {
				return;
			}
			this.connection = null;
			this.reader.reset();
			this.onStatus("stopped", "encodeur deconnecte");
		});
		this.onStatus("ready", "encodeur connecte");
	}

	// Cette methode transforme les octets recus en frames completes.
	// Une erreur du consommateur remonte ici depuis un evenement de socket : sans ce filet, elle
	// devient une exception non capturee et arrete tout le processus node.script.
	receive(chunk) {
		try {
			const frames = this.reader.push(chunk);
			for (const frame of frames) {
				this.onFrame(frame);
			}
		} catch (error) {
			this.onStatus("error", error.message);
		}
	}

	// Cette methode ferme la connexion courante et le port d'ecoute.
	close() {
		if (this.connection !== null) {
			this.connection.destroy();
			this.connection = null;
		}
		return new Promise((resolve) => this.server.close(resolve));
	}
}

module.exports = { FrameBridge };
