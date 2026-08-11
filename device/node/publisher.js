"use strict";

const { WebSocket } = require("ws");
const { readConfig } = require("./publisher-config.js");
const { backoffDelayMs } = require("./publisher-backoff.js");
const { BitrateController } = require("./publisher-bitrate.js");
const { SourceClock } = require("./source-clock.js");
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
// Duree d'audio que la file d'envoi garde au plus, en millisecondes.
//
// Au-dela, le lien montant est en retard d'une demi-seconde et le rattrapera d'autant moins qu'on
// continue d'empiler. La file jette alors sa trame **la plus ancienne**, jamais la plus recente :
// dans un direct, l'audio qui vient d'etre encode est celui qui compte, et garder les vieilles au
// prix des nouvelles produit un trou d'un seul tenant de la taille de la file.
//
// Une demi-seconde parce que le player rattrape ce retard sans coupure — son seuil monte jusqu'a
// deux secondes quand le lien le demande — alors qu'un abandon, lui, est definitif.
const MAX_QUEUE_MS = 500;

// Nombre de trames confiees a la socket sans que le systeme ait encore accuse reception.
//
// C'est ce plafond qui donne son sens a la file ci-dessus. Node n'expose aucun reglage de la taille
// du tampon d'envoi du noyau : sans cette fenetre, une seconde d'audio s'empilerait dans le noyau,
// invisible et hors de portee, et la file applicative resterait vide pendant que le retard grandit.
// En n'en confiant que quelques-unes a la fois, le retard s'accumule la ou on peut le voir et
// decider quoi jeter.
//
// Quatre trames font 160 ms. Sur un lien sain le rappel d'ecriture revient en moins d'une
// milliseconde et cette fenetre n'est jamais atteinte : elle ne coute rien tant que rien ne va mal.
const MAX_INFLIGHT_FRAMES = 4;
// Le relais n'envoie que de courts messages JSON : une trame plus grande est refusee d'office.
const MAX_INBOUND_BYTES = 4096;
// Une nouvelle session est creee avant d'atteindre la fin du compteur de sequence de 32 bits.
const SEQUENCE_LIMIT = protocol.MAX_UINT32 - 1000;
// Valeur de `readyState` d'une connexion ouverte, definie par la norme WebSocket.
const SOCKET_OPEN = 1;
// Ecart de debit en dessous duquel l'encodeur n'est pas prevenu. La rampe du regulateur avance par
// tres petits pas, et un message par trame chargerait Max pour rien : seuls les pas qui comptent
// traversent.
const BITRATE_STEP_BYTES = 1000;

// Cette fonction rend une duree en millisecondes qui n'avance qu'avec le temps qui passe.
//
// `Date.now` ne convient a rien de ce que le publisher mesure. Toutes ses durees sont des ecarts —
// age de la plus vieille trame en vol, temps passe en direct, retard de l'horloge de source — et une
// horloge murale saute quand le systeme se remet a l'heure. Le recul est deja traite
// (`source-clock.js`), **l'avance ne l'etait pas** : une resynchronisation NTP de +1 s se lisait
// comme une seconde de son jamais produite, et comme elle depasse les 500 ms que le player sait
// combler, elle faisait vider sa file. Une coupure pour rien, invisible a tous les compteurs.
//
// `process.hrtime.bigint()` supprime la classe entiere : il compte depuis un point arbitraire et ne
// recule ni ne saute jamais. L'origine arbitraire n'a aucune importance ici, puisque rien ne compare
// ces valeurs a une date.
function monotonicNow() {
	return Number(process.hrtime.bigint() / 1000n) / 1000;
}

// Cette classe tient la connexion WebSocket vers le relais et l'etat visible par le device.
// Elle ne connait ni Max ni le socket loopback : elle recoit des frames deja pretes.
class Publisher {
	constructor(handlers = {}) {
		this.onState = handlers.onState ?? (() => {});
		this.onEncoder = handlers.onEncoder ?? (() => {});
		this.loadConfig = handlers.loadConfig ?? readConfig;
		this.delayFor = handlers.delayFor ?? backoffDelayMs;
		this.SocketClass = handlers.SocketClass ?? WebSocket;
		// Les tests injectent la leur ; le device garde l'horloge monotone. Voir `monotonicNow`.
		this.now = handlers.now ?? monotonicNow;
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
		// Ce regulateur decide du debit reellement produit. Il est cree au demarrage du live, quand
		// la qualite choisie est connue : c'est elle qui devient son plafond.
		this.bitrateController = null;
		// Dernier debit annonce a l'encodeur, pour ne pas repeter le meme ordre cinquante fois par
		// seconde.
		this.appliedBitrate = 0;
		// Instants d'envoi des trames audio que la socket n'a pas encore ecrites. L'age de la plus
		// ancienne est la mesure du retard du lien montant : une duree, donc comparable directement au
		// budget de latence, et qui commence a croitre des que le systeme cesse d'accepter des octets.
		// `bufferedAmount` ne le dirait pas — il reste nul tant que le tampon du noyau n'est pas plein,
		// puis saute d'un coup.
		this.pendingSends = [];
		// Trames encodees par l'external et pas encore confiees a la socket, avec leur date d'entree.
		// C'est la seule file du systeme dont le publisher decide du contenu : celle du noyau ne se
		// regle pas depuis Node, et celle de `ws` se remplit sans qu'on puisse choisir quoi y laisser.
		this.queue = [];
		// Cette horloge compare le son produit par l'external au temps reel. Elle ne sert pas a
		// surveiller la machine : elle corrige les timestamps sortants pour que le trou laisse par un
		// decrochage d'Ableton soit annonce a l'auditeur au lieu d'user sa file en silence. Voir
		// `source-clock.js`.
		this.sourceClock = new SourceClock();
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
		// La qualite choisie devient le plafond du regulateur, jamais une valeur figee : produire
		// moins vaut toujours mieux que jeter, et c'est la seule reponse a un lien qui retrecit.
		this.bitrateController = new BitrateController(this.bitrate);
		this.appliedBitrate = this.bitrate;
		this.connect();
	}

	// Cette methode arrete le live et ferme la session proprement quand elle existe.
	// L'ordre suit la roadmap : encodeur, puis `stream_stop`, puis fermeture de la connexion.
	stop(reason = "user_stop") {
		this.wanted = false;
		this.clearTimers();
		this.bitrateController = null;
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
		// L'horloge de source decrit une chronologie de session : elle repart avec elle.
		this.sourceClock.reset();
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
	//
	// La frame n'est pas envoyee tout de suite : elle entre dans une file bornee en temps, que
	// `drain` vide au rythme que le lien accepte. C'est cette indirection qui permet de choisir *quoi*
	// jeter quand le lien ne suit plus, au lieu de subir ce que le systeme refuse.
	sendFrame(frame) {
		if (this.state !== LIVE || this.socket === null || this.session === null) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		// Le decalage est mesure ici, a l'arrivee, et non au moment de transmettre : c'est l'arrivee qui
		// dit quand l'external a produit cette trame. Le temps passe ensuite dans la file d'envoi
		// appartient au lien montant, pas a la source, et le compter ici ferait passer un lien lent
		// pour un decrochage d'Ableton.
		const shiftMicros = this.sourceClock.note(frame.timestampMicros, this.now());

		// Le debit est revu a chaque trame, avant tout abandon. C'est l'ordre qui compte : jeter est
		// l'aveu que le lien ne suit plus, et produire moins evite d'en arriver la.
		this.reviewBitrate();

		// Une frame que l'en-tete public ne peut pas porter est refusee avant d'entrer dans la file.
		// Refusee apres coup, elle aurait deja pris une place dans la chronologie.
		if (!sendableFrame(frame)) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		this.enqueue(frame, shiftMicros);
		this.drain();
		return true;
	}

	// Cette methode met une frame en file et jette la plus ancienne quand la file deborde.
	//
	// L'ordre est celui-la et pas l'inverse : la frame qui arrive est toujours acceptee, et c'est le
	// vieux fond de file qui part. Une trame d'il y a une demi-seconde n'a plus aucune valeur dans un
	// direct, alors que celle qui vient d'etre encodee en a toute.
	// Le decalage de l'horloge de source voyage avec la trame plutot que d'etre relu a la sortie de
	// file : relu plus tard, il attribuerait a cette trame un trou apparu apres son arrivee.
	enqueue(frame, shiftMicros) {
		this.queue.push({ frame, shiftMicros, at: this.now() });

		const limit = Math.max(1, Math.floor(MAX_QUEUE_MS / protocol.FRAME_DURATION_MS));

		while (this.queue.length > limit) {
			this.queue.shift();
			this.stats.framesDropped += 1;
			// La prochaine frame reellement transmise portera le bit : c'est ce qui dit au player que
			// le trou vient du lien montant, et non du relais.
			this.discontinuityPending = true;
		}
	}

	// Cette methode transmet ce que la fenetre d'envoi permet, et pas plus.
	drain() {
		while (this.queue.length > 0 && this.pendingSends.length < MAX_INFLIGHT_FRAMES) {
			const entry = this.queue.shift();

			if (!this.transmit(entry.frame, entry.shiftMicros)) {
				return;
			}
		}
	}

	// Cette methode place une frame sur la chronologie, l'encode et la confie a la socket.
	transmit(frame, shiftMicros = 0n) {
		if (this.state !== LIVE || this.socket === null || this.session === null) {
			this.stats.framesDropped += 1;
			this.discontinuityPending = true;
			return false;
		}

		// Ce filet couvre le reste. Le pont remet ses frames depuis un evenement de socket : une
		// exception y deviendrait une erreur non capturee et arreterait tout le processus Node.
		let packet = null;
		try {
			const placed = this.placeInSession(frame, shiftMicros);
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
		this.trackedSend(packet);
		return true;
	}

	// Cette methode fait avancer le regulateur d'une trame et transmet le debit qui en sort.
	//
	// Un ordre ne part que lorsque le debit a bouge d'assez : la rampe du regulateur avance par pas
	// minuscules, et cinquante messages par seconde vers Max ne diraient rien de plus.
	reviewBitrate() {
		if (this.bitrateController === null) {
			return;
		}

		const applied = this.bitrateController.update(this.oldestPendingMs(), this.now());

		if (Math.abs(applied - this.appliedBitrate) < BITRATE_STEP_BYTES) {
			return;
		}

		this.appliedBitrate = applied;
		this.onEncoder("bitrate", applied);
	}

	// Cette methode rend l'age de la plus vieille trame qui attend quelque part.
	//
	// Les deux attentes se suivent dans cet ordre : la socket tient les plus anciennes, la file les
	// plus recentes. Il suffit donc de regarder la socket d'abord, et la file seulement si la socket
	// n'a plus rien en vol.
	//
	// C'est cette duree que lit le regulateur de debit. Elle commence a croitre des que la fenetre
	// d'envoi se ferme, donc bien avant que le tampon du noyau soit plein : c'est ce qui la rend
	// utilisable comme signal precoce de congestion.
	oldestPendingMs() {
		const oldestSend = this.pendingSends[0];

		if (oldestSend !== undefined) {
			return this.now() - oldestSend;
		}

		const oldestQueued = this.queue[0];

		return oldestQueued === undefined ? 0 : this.now() - oldestQueued.at;
	}

	// Cette methode envoie une trame audio en notant combien de temps la socket met a l'accepter.
	//
	// `ws` rend la main a ce rappel quand les octets sont ecrits sur le socket, donc acceptes par le
	// systeme. Tant qu'il ne revient pas, le lien montant est en retard, et c'est cette duree que le
	// regulateur lit. Les rappels arrivent dans l'ordre des envois : retirer le plus ancien suffit.
	trackedSend(packet) {
		const socket = this.socket;

		if (socket === null || socket.readyState !== SOCKET_OPEN) {
			return;
		}

		this.pendingSends.push(this.now());

		try {
			socket.send(packet, () => {
				this.pendingSends.shift();
				// La fenetre vient de se rouvrir d'une place : ce qui attendait peut partir. Sans ce
				// rappel, la file ne se viderait qu'a l'arrivee de la trame suivante, donc jamais plus
				// vite que la cadence de l'encodeur, et un retard pris ne se rattraperait pas.
				this.drain();
			});
		} catch (error) {
			this.pendingSends.shift();
			this.dropSocket("envoi impossible");
		}
	}

	// Cette methode place une frame du pont sur la chronologie de la session courante.
	// Les numeros du pont continuent d'avancer d'une session a l'autre : ils sont ramenes a zero
	// sur la premiere frame recue, ce qui conserve les trous et l'avance des timestamps.
	// `shiftMicros` est la duree que l'external a perdue sans le savoir depuis le debut de la session,
	// mesuree par `source-clock.js`. L'ajouter ici est tout ce qui separe un trou annonce d'un trou
	// invisible : le timestamp avance alors de plus d'une trame, le player comble la duree exacte en
	// silence, et sa file garde son niveau. Sans lui, la meme perte se paie une minute plus tard en
	// coupure de deux secondes.
	//
	// Le bit de discontinuite n'est volontairement pas pose. Il dit au player que l'encodeur s'est
	// remis a zero, ce qui n'est pas le cas ici : les samples de part et d'autre du trou sont
	// contigus pour Opus, et reinitialiser le decodeur allongerait l'artefact au lieu de l'ecourter.
	placeInSession(frame, shiftMicros = 0n) {
		const session = this.session;

		if (session.firstSequence < 0) {
			session.firstSequence = frame.sequence;
			session.firstTimestamp = frame.timestampMicros;
		}

		const sequenceNumber = frame.sequence - session.firstSequence;
		const timestampMicros = frame.timestampMicros - session.firstTimestamp + shiftMicros;

		// L'encodeur est reparti de zero, ou le compteur de 32 bits arrive au bout. Les deux cas
		// demandent une nouvelle session : un listener ne doit jamais voir un numero reculer.
		if (sequenceNumber < 0 || timestampMicros < 0n || sequenceNumber > SEQUENCE_LIMIT) {
			this.renewSession();
			// La session neuve a remis l'horloge de source a zero : reprendre le decalage de l'ancienne
			// ferait commencer la nouvelle chronologie ailleurs qu'a zero.
			return this.placeInSession(frame, this.sourceClock.shiftMicros);
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
		// Les rappels d'envoi de la connexion perdue n'arriveront jamais : les garder ferait croire a
		// un retard permanent et bloquerait le debit au plancher pour toujours. La file part avec eux :
		// son contenu appartient a une session terminee, et la reprise ouvrira la sienne.
		this.pendingSends = [];
		this.queue = [];
		// Le lien d'apres n'a aucune raison de ressembler a celui d'avant : le debit repart du
		// plafond et redescend si besoin.
		this.bitrateController?.reset();
		this.appliedBitrate = this.bitrate;
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
		this.pendingSends = [];
		this.queue = [];
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
	MAX_QUEUE_MS,
	MAX_INFLIGHT_FRAMES,
	AUTH_TIMEOUT_MS,
	SILENCE_TIMEOUT_MS,
	HEARTBEAT_INTERVAL_MS,
	STABLE_CONNECTION_MS
};
