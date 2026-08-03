"use strict";

const { WebSocket } = require("ws");
const { readConfig } = require("./publisher-config.js");
const { backoffDelayMs } = require("./publisher-backoff.js");
const protocol = require("./publisher-protocol.js");

// Ces etats sont ceux affiches par le device. Ils ne decrivent que le lien avec le relais.
const STOPPED = "STOPPED";
const CONNECTING = "CONNECTING";
const LIVE = "LIVE";
const RECONNECTING = "RECONNECTING";
const ERROR = "ERROR";

// Le relais doit repondre a l'authentification rapidement : au-dela, la connexion est perdue.
const AUTH_TIMEOUT_MS = 5000;
// Le relais envoie un ping toutes les vingt secondes. Deux pings manques ferment la connexion,
// ce qui detecte une liaison morte que le systeme d'exploitation croit encore ouverte.
const SILENCE_TIMEOUT_MS = 45000;
// Le publisher envoie aussi son propre ping. Sans lui, la detection de liaison morte dependrait
// entierement du ping du relais : un relais muet mais joignable laisserait le device croire qu'il
// est en direct alors que plus aucun octet n'arrive chez les listeners.
const HEARTBEAT_INTERVAL_MS = 15000;
// Une connexion en direct qui tient au moins ce temps est jugee saine : la coupure suivante repart
// du premier palier. Sans cette regle, un relais qui accepte le token puis coupe aussitot serait
// rappele toutes les secondes sans fin, parce que chaque session remettrait les paliers a zero.
const STABLE_CONNECTION_MS = 30000;
// Cette limite vaut environ 250 ms d'audio en qualite Studio. Au-dela, la sortie reseau est en
// retard : la frame est jetee pour rester en direct au lieu d'empiler de l'audio ancien.
const MAX_BUFFERED_BYTES = 8192;
// Le relais n'envoie que de courts messages JSON : une trame plus grande est refusee d'office.
const MAX_INBOUND_BYTES = 4096;
// Une nouvelle session est creee avant d'atteindre la fin du compteur de sequence de 32 bits.
const SEQUENCE_LIMIT = protocol.MAX_UINT32 - 1000;
// Valeur de `readyState` d'une connexion ouverte, definie par la norme WebSocket.
const SOCKET_OPEN = 1;

// Cette classe tient la connexion WebSocket vers le relais et l'etat visible par le device.
// Elle ne connait ni Max ni le socket loopback : elle recoit des frames deja pretes.
class Publisher {
	constructor(handlers = {}) {
		this.onState = handlers.onState ?? (() => {});
		this.onEncoder = handlers.onEncoder ?? (() => {});
		this.loadConfig = handlers.loadConfig ?? readConfig;
		this.delayFor = handlers.delayFor ?? backoffDelayMs;
		this.SocketClass = handlers.SocketClass ?? WebSocket;
		this.now = handlers.now ?? Date.now;
		// Ces durees sont raccourcies par les tests, qui ne peuvent pas attendre des dizaines de
		// secondes. Le device n'en fournit aucune : il garde les valeurs du protocole.
		this.timings = {
			authMs: handlers.timings?.authMs ?? AUTH_TIMEOUT_MS,
			silenceMs: handlers.timings?.silenceMs ?? SILENCE_TIMEOUT_MS,
			heartbeatMs: handlers.timings?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
			stableMs: handlers.timings?.stableMs ?? STABLE_CONNECTION_MS
		};

		this.state = STOPPED;
		this.detail = "arrete";
		this.wanted = false;
		this.config = null;
		this.bitrate = protocol.DEFAULT_BITRATE;
		this.latencyProfile = protocol.DEFAULT_LATENCY_PROFILE;
		this.socket = null;
		this.session = null;
		this.previousSessionId = 0;
		this.attempt = 0;
		this.closeReason = "";
		this.reconnectTimer = null;
		this.authTimer = null;
		this.silenceTimer = null;
		this.heartbeatTimer = null;
		// Ce drapeau limite `auth_ok` et `auth_error` a la fenetre ou ils ont un sens. Un relais
		// bavard ou compromis ne peut donc pas relancer une session au milieu d'un live.
		this.authPending = false;
		// Instant ou la connexion courante est passee en direct, ou zero hors direct.
		this.liveSince = 0;
		this.discontinuityPending = false;
		this.stats = { framesSent: 0, framesDropped: 0, bytesSent: 0, sessions: 0, reconnects: 0 };
	}

	// Cette methode demande un live. La configuration est relue a chaque demarrage : une URL
	// corrigee pendant la session Ableton est donc prise en compte sans redemarrer le device.
	start(options = {}) {
		if (this.wanted) {
			return;
		}

		let config = null;
		try {
			config = this.loadConfig();
			this.bitrate = checkedChoice(
				options.bitrate,
				protocol.ALLOWED_BITRATES,
				protocol.DEFAULT_BITRATE,
				"bitrate_inconnu"
			);
			this.latencyProfile = checkedChoice(
				options.latencyProfile,
				protocol.ALLOWED_LATENCY_PROFILES,
				protocol.DEFAULT_LATENCY_PROFILE,
				"profil_latence_inconnu"
			);
		} catch (error) {
			this.fail(error.message);
			return;
		}

		this.config = config;
		this.wanted = true;
		this.attempt = 0;
		this.connect();
	}

	// Cette methode arrete le live et ferme la session proprement quand elle existe.
	// L'ordre suit la roadmap : encodeur, puis `stream_stop`, puis fermeture de la connexion.
	stop(reason = "user_stop") {
		this.wanted = false;
		this.clearTimers();
		this.onEncoder("stop");

		if (this.state === LIVE && this.session !== null) {
			this.trySend(protocol.buildStreamStop(this.session.sessionId, reason));
		}

		this.session = null;
		// La connexion est detachee : son evenement de fermeture ne doit plus rien decider, sinon
		// le device recevrait un second `encoder stop` et un second etat `STOPPED`.
		this.releaseSocket(true);
		this.setState(STOPPED, "arrete");
	}

	// Cette methode ouvre la connexion et attend l'authentification avant toute autre etape.
	connect() {
		this.setState(CONNECTING, "connexion au relais");

		const socket = new this.SocketClass(this.config.relayUrl, {
			handshakeTimeout: this.timings.authMs,
			maxPayload: MAX_INBOUND_BYTES,
			// L'audio Opus est deja compresse : deflate couterait du temps sans rien gagner.
			perMessageDeflate: false
		});

		this.socket = socket;
		socket.on("open", () => this.handleOpen(socket));
		socket.on("message", (data, isBinary) => this.handleMessage(socket, data, isBinary));
		socket.on("ping", () => this.armSilenceTimer());
		// Le pong repond au ping du publisher : c'est le signe de vie qui ne depend pas du relais.
		socket.on("pong", () => this.armSilenceTimer());
		// Une erreur de socket est toujours suivie d'une fermeture : la reconnexion part de la.
		// Sans ce gestionnaire, `ws` transformerait l'erreur en exception non capturee.
		socket.on("error", (error) => {
			this.closeReason = shortReason(error.message);
		});
		socket.on("close", (code) => this.handleClose(socket, code));
	}

	// Cette methode envoie le token des l'ouverture, puis limite l'attente de la reponse.
	handleOpen(socket) {
		if (socket !== this.socket) {
			return;
		}

		this.armSilenceTimer();
		this.armHeartbeat();
		this.clearAuthTimer();
		this.authPending = true;
		this.authTimer = setTimeout(
			() => this.dropSocket("relais sans reponse a l'authentification"),
			this.timings.authMs
		);
		this.trySend(protocol.buildAuthMessage(this.config.publisherToken));
	}

	// Cette methode traite les reponses du relais. Aucune trame binaire n'est attendue ici.
	handleMessage(socket, data, isBinary) {
		if (socket !== this.socket || isBinary) {
			return;
		}

		this.armSilenceTimer();

		let message = null;
		try {
			message = protocol.parseServerMessage(data.toString());
		} catch (error) {
			this.dropSocket(error.message);
			return;
		}

		// Une reponse d'authentification n'a de sens qu'une fois, juste apres `publisher_auth`.
		// Repetee pendant un live, elle rouvrirait une session et relancerait l'encodeur.
		if (message.type === "auth_ok" || message.type === "auth_error") {
			if (!this.authPending) {
				return;
			}

			this.authPending = false;
			this.clearAuthTimer();

			if (message.type === "auth_ok") {
				this.startSession();
				return;
			}

			// Le token est refuse : reessayer ne changerait rien tant qu'il n'est pas corrige.
			// Le message reprend la raison du relais, jamais le token lui-meme.
			this.fail(`token refuse par le relais (${shortReason(message.reason)})`);
			this.releaseSocket(true);
			return;
		}

		if (message.type === "server_error") {
			this.setState(this.state, `relais: ${shortReason(message.reason)}`);
		}
	}

	// Cette methode ouvre une session : nouvel identifiant, `stream_start`, puis encodeur.
	// L'ordre compte : le relais refuse toute frame audio recue avant son `stream_start`.
	// `startEncoder` reste faux quand la session est renouvelee au milieu d'un live : relancer
	// l'encodeur remettrait sa numerotation a zero et demanderait aussitot une session de plus.
	startSession(startEncoder = true) {
		this.previousSessionId = protocol.createSessionId(this.previousSessionId);
		this.session = { sessionId: this.previousSessionId, firstSequence: -1, firstTimestamp: 0n };
		this.stats.sessions += 1;
		// Le compte de stabilite mesure la connexion, pas la session : un renouvellement de session
		// au milieu d'un live ne doit pas faire croire a une connexion toute neuve.
		if (this.liveSince === 0) {
			this.liveSince = this.now();
		}
		this.discontinuityPending = false;

		this.trySend(protocol.buildStreamStart({
			sessionId: this.session.sessionId,
			bitrate: this.bitrate,
			latencyProfile: this.latencyProfile
		}));

		this.setState(LIVE, "en direct");

		if (startEncoder) {
			this.onEncoder("start");
		}
	}

	// Cette methode publie une frame du pont loopback sous la forme du paquet binaire v1.
	sendFrame(frame) {
		if (this.state !== LIVE || this.socket === null || this.session === null) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		// Une sortie reseau en retard signifie que l'audio le plus ancien serait joue trop tard.
		// La frame est abandonnee et la suivante porte le bit de discontinuite.
		if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		// Une frame que l'en-tete public ne peut pas porter est refusee avant d'entrer dans la
		// session. Refusee apres coup, elle aurait deja ancre la chronologie : le premier paquet
		// reellement transmis ne partirait alors ni de la sequence zero ni du timestamp zero.
		if (!sendableFrame(frame)) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		// Ce filet couvre le reste. Le pont remet ses frames depuis un evenement de socket : une
		// exception y deviendrait une erreur non capturee et arreterait tout le processus Node.
		let packet = null;
		try {
			const placed = this.placeInSession(frame);
			packet = protocol.encodeAudioPacket({
				sessionId: this.session.sessionId,
				sequenceNumber: placed.sequenceNumber,
				timestampMicros: placed.timestampMicros,
				flags: this.frameFlags(frame),
				payload: frame.payload
			});
		} catch (error) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		this.discontinuityPending = false;
		this.stats.framesSent += 1;
		this.stats.bytesSent += packet.length;
		this.trySend(packet);
		return true;
	}

	// Cette methode place une frame du pont sur la chronologie de la session courante.
	// Les numeros du pont continuent d'avancer d'une session a l'autre : ils sont ramenes a zero
	// sur la premiere frame recue, ce qui conserve les trous et l'avance des timestamps.
	placeInSession(frame) {
		const session = this.session;

		if (session.firstSequence < 0) {
			session.firstSequence = frame.sequence;
			session.firstTimestamp = frame.timestampMicros;
		}

		const sequenceNumber = frame.sequence - session.firstSequence;
		const timestampMicros = frame.timestampMicros - session.firstTimestamp;

		// L'encodeur est reparti de zero, ou le compteur de 32 bits arrive au bout. Les deux cas
		// demandent une nouvelle session : un listener ne doit jamais voir un numero reculer.
		if (sequenceNumber < 0 || timestampMicros < 0n || sequenceNumber > SEQUENCE_LIMIT) {
			this.renewSession();
			return this.placeInSession(frame);
		}

		return { sequenceNumber, timestampMicros };
	}

	// Cette methode ferme la session courante et en ouvre une autre sans couper la connexion.
	renewSession() {
		this.trySend(protocol.buildStreamStop(this.session.sessionId, "error"));
		this.startSession(false);
		this.discontinuityPending = true;
	}

	// Cette methode pose le bit de discontinuite quand de l'audio manque avant cette frame.
	frameFlags(frame) {
		const fromEncoder = (frame.flags & protocol.DISCONTINUITY_FLAG) !== 0;
		return fromEncoder || this.discontinuityPending ? protocol.DISCONTINUITY_FLAG : 0;
	}

	// Cette methode traite une connexion fermee : l'encodeur s'arrete avant toute reconnexion.
	handleClose(socket, code) {
		if (socket !== this.socket) {
			return;
		}

		const reason = this.closeReason !== "" ? this.closeReason : `code ${code}`;
		// Une session qui a tenu assez longtemps efface l'historique des paliers : la coupure
		// suivante est traitee comme la premiere. Une session trop courte le conserve, ce qui
		// espace les tentatives face a un relais qui accepte puis coupe aussitot.
		const liveMs = this.liveSince === 0 ? 0 : this.now() - this.liveSince;
		if (liveMs >= this.timings.stableMs) {
			this.attempt = 0;
		}

		this.socket = null;
		this.session = null;
		this.liveSince = 0;
		this.closeReason = "";
		this.authPending = false;
		this.clearAuthTimer();
		this.clearSilenceTimer();
		this.clearHeartbeat();
		this.onEncoder("stop");

		if (!this.wanted) {
			if (this.state !== ERROR) {
				this.setState(STOPPED, "arrete");
			}
			return;
		}

		const delay = this.delayFor(this.attempt);
		this.attempt += 1;
		this.stats.reconnects += 1;
		this.setState(RECONNECTING, `${reason}, nouvelle tentative dans ${Math.round(delay / 100) / 10} s`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.wanted) {
				this.connect();
			}
		}, delay);
	}

	// Cette methode ferme une connexion jugee inutilisable ; la suite passe par `handleClose`,
	// qui decide seul de l'arret ou de la reconnexion.
	dropSocket(reason) {
		if (this.socket === null) {
			return;
		}

		this.closeReason = reason;
		this.socket.terminate();
	}

	// Cette methode envoie sans jamais laisser une erreur de socket arreter le processus Node.
	trySend(payload) {
		if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) {
			return;
		}

		try {
			this.socket.send(payload);
		} catch (error) {
			this.dropSocket("envoi impossible");
		}
	}

	// Cette methode ferme la connexion et cesse d'ecouter ses evenements : l'appelant a deja
	// decide de la suite, `handleClose` n'a plus rien a annoncer. Une fermeture douce laisse partir
	// les messages deja mis en file, dont `stream_stop` ; une fermeture dure coupe tout de suite.
	releaseSocket(graceful) {
		const socket = this.socket;
		if (socket === null) {
			return;
		}

		this.socket = null;
		this.closeReason = "";
		this.authPending = false;
		this.liveSince = 0;
		this.clearSilenceTimer();
		this.clearHeartbeat();

		if (graceful) {
			socket.close(1000);
			return;
		}

		socket.terminate();
	}

	// Cette methode redemarre le compte a rebours du silence a chaque signe de vie du relais.
	armSilenceTimer() {
		this.clearSilenceTimer();
		this.silenceTimer = setTimeout(() => this.dropSocket("relais silencieux"), this.timings.silenceMs);
	}

	// Cette methode envoie un ping regulier tant que la connexion est ouverte. Le pong du relais
	// relance le compte a rebours du silence : la liaison est alors testee de bout en bout, meme
	// si le relais n'envoie aucun ping de son cote.
	armHeartbeat() {
		this.clearHeartbeat();
		this.heartbeatTimer = setInterval(() => this.sendPing(), this.timings.heartbeatMs);
	}

	// Cette methode envoie un ping sans jamais laisser une erreur de socket arreter Node.
	sendPing() {
		const socket = this.socket;
		if (socket === null || socket.readyState !== SOCKET_OPEN || typeof socket.ping !== "function") {
			return;
		}

		try {
			socket.ping();
		} catch (error) {
			this.dropSocket("ping impossible");
		}
	}

	clearHeartbeat() {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	clearAuthTimer() {
		if (this.authTimer !== null) {
			clearTimeout(this.authTimer);
			this.authTimer = null;
		}
	}

	clearSilenceTimer() {
		if (this.silenceTimer !== null) {
			clearTimeout(this.silenceTimer);
			this.silenceTimer = null;
		}
	}

	clearTimers() {
		this.clearAuthTimer();
		this.clearSilenceTimer();
		this.clearHeartbeat();
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	// Cette methode place l'etat d'erreur et coupe toute tentative automatique.
	fail(detail) {
		this.wanted = false;
		this.clearTimers();
		this.onEncoder("stop");
		this.setState(ERROR, detail);
	}

	// Cette methode publie l'etat courant vers le device.
	setState(state, detail) {
		this.state = state;
		this.detail = detail;
		this.onState(state, detail);
	}
}

// Cette fonction dit si une frame du pont peut devenir un paquet du protocole v1.
// Seul le payload vient de l'exterieur : les autres champs de l'en-tete sont poses par le publisher.
function sendableFrame(frame) {
	const payload = frame.payload;

	if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
		return false;
	}

	return payload.length >= 1 && payload.length <= protocol.MAX_PAYLOAD_SIZE;
}

// Cette fonction garde une valeur seulement si elle fait partie des choix connus.
function checkedChoice(value, allowed, fallback, errorCode) {
	if (value === undefined || value === null) {
		return fallback;
	}

	if (!allowed.includes(value)) {
		throw new Error(errorCode);
	}

	return value;
}

// Cette fonction rend lisible un texte venu du reseau sans faire confiance a son contenu.
function shortReason(reason) {
	if (typeof reason !== "string" || reason === "") {
		return "raison inconnue";
	}

	return reason.replace(/[^a-zA-Z0-9_ .-]/g, "").slice(0, 64);
}

module.exports = {
	Publisher,
	STOPPED,
	CONNECTING,
	LIVE,
	RECONNECTING,
	ERROR,
	MAX_BUFFERED_BYTES,
	AUTH_TIMEOUT_MS,
	SILENCE_TIMEOUT_MS,
	HEARTBEAT_INTERVAL_MS,
	STABLE_CONNECTION_MS
};
