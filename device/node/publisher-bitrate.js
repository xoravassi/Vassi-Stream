"use strict";

// Ce module decide, seul, a quel debit l'encodeur produit. Il ne connait ni socket, ni Max, ni
// encodeur : il recoit une mesure de retard et rend un debit. C'est ce qui le rend verifiable sous
// Node.
//
// Il existe parce qu'un lien montant trop etroit laisse deux issues : jeter des trames, ou en
// produire de plus legeres. Jeter est toujours la mauvaise, sur tous les plans a la fois — un flux
// complet a 96 kbit/s vaut mieux qu'un tiers de flux a 256 kbit/s. Opus accepte n'importe quel debit
// et le change sans coupure : produire moins ne coute donc que de la finesse.

// Debit le plus bas autorise. En dessous de 17,3 kbit/s libopus abandonne la stereo pour du mono
// (`stereo_music_threshold`), ce qui s'entend brutalement sur un mix ; sous 32 kbit/s il commence a
// retrecir l'image stereo. Ce plancher garde donc la bande pleine et l'image intactes, avec presque
// deux fois de marge sur la bascule mono.
const MIN_BITRATE = 32000;

// Duree de retard au-dela de laquelle le lien est declare trop lent. Elle est comparee a l'age de la
// trame la plus ancienne encore en attente d'envoi : c'est une duree, donc elle se compare
// directement au budget de latence, et elle ne depend ni du debit ni de la taille des tampons du
// systeme.
//
// Elle est precise parce que le publisher tient sa propre file d'envoi : elle commence a croitre
// des que la fenetre d'envoi se ferme, c'est-a-dire des les premieres dizaines de millisecondes de
// retard. Une mesure prise sur le seul tampon du noyau ne verrait rien tant que celui-ci n'est pas
// plein, puis sauterait d'un coup a plusieurs centaines de millisecondes.
const PRESSURE_MS = 150;

// Duree de calme exigee avant de remonter.
//
// Dix secondes de lien propre sont un signal solide, et cette duree n'a pas a etre plus longue :
// ce n'est pas elle qui empeche l'oscillation, c'est l'attente de `HOLD_MS` apres chaque decision,
// pendant laquelle plus rien n'est decide. La rallonger coute cher a la remontee — a quinze
// secondes, le journal du 6 aout 2026 montre quatre-vingt-quinze secondes pour remonter de 44 a
// 109 kbit/s sous un plafond de 128, sur un lien qui allait deja tres bien.
const CALM_MS = 10000;

// Facteur applique a chaque decision de baisse. Une baisse multiplicative rattrape une congestion
// severe en quelques decisions, la ou une baisse par paliers fixes resterait derriere.
const DECREASE_FACTOR = 0.85;

// Part du plafond regagnee a chaque decision de hausse. La hausse est additive et lente : c'est la
// forme AIMD, celle de tous les regulateurs de congestion, et la seule qui converge sans osciller.
const INCREASE_STEP = 0.08;

// Duree pendant laquelle aucune decision n'est prise apres un changement. C'est cette attente, plus
// que l'hysteresis, qui empeche l'oscillation : la mesure met du temps a refleter un changement de
// debit, et decider avant qu'elle ne l'ait fait revient a decider sur du bruit. Une rafale de
// retransmissions de 200 a 500 ms est ordinaire en 4G, et ne doit declencher qu'une seule baisse.
const HOLD_MS = 2000;

// Vitesse maximale de variation du debit reellement applique, en part du plafond par seconde.
//
// Le debit vise saute ; le debit applique le rejoint en rampe. Un saut de 256 a 128 kbit/s s'entend
// comme une marche, alors qu'une rampe de quelques pour cent par decisecondes est inaudible. C'est
// la condition posee par Vassi : descendre bas est acceptable, s'entendre descendre ne l'est pas.
const RAMP_PER_SECOND = 0.5;

// Cette classe tient le debit courant et le fait evoluer a chaque mesure.
//
// Deux debits coexistent et c'est volontaire : `target` est ce que le regulateur a decide, `applied`
// est ce que l'encodeur recoit. Le second rejoint le premier en rampe, ce qui rend chaque variation
// inaudible sans ralentir la decision elle-meme.
class BitrateController {
	// `ceiling` est la qualite choisie par Vassi dans le device. Elle devient un plafond, jamais une
	// valeur figee.
	constructor(ceiling, options = {}) {
		this.ceiling = ceiling;
		this.floor = Math.min(options.floor ?? MIN_BITRATE, ceiling);
		this.pressureMs = options.pressureMs ?? PRESSURE_MS;
		this.calmMs = options.calmMs ?? CALM_MS;
		this.holdMs = options.holdMs ?? HOLD_MS;

		this.target = ceiling;
		this.applied = ceiling;
		// Instant de la derniere decision, et instant depuis lequel le lien est calme. Tous deux
		// valent zero tant qu'aucune mesure n'est arrivee.
		this.decidedAt = 0;
		this.calmSince = 0;
		this.lastAt = 0;
		this.decreases = 0;
		this.increases = 0;
	}

	// Cette methode remet le regulateur au plafond, pour une nouvelle session ou une reconnexion.
	// Le lien d'apres n'a aucune raison de ressembler a celui d'avant.
	reset() {
		this.target = this.ceiling;
		this.applied = this.ceiling;
		this.decidedAt = 0;
		this.calmSince = 0;
		this.lastAt = 0;
	}

	// Cette methode recoit une mesure et rend le debit a appliquer maintenant.
	//
	// `oldestPendingMs` est l'age de la trame la plus ancienne encore en attente d'envoi, ou zero
	// quand rien n'attend. `at` est l'horloge, fournie par l'appelant pour que les tests mesurent des
	// durees sans attendre.
	update(oldestPendingMs, at) {
		const elapsed = this.lastAt === 0 ? 0 : at - this.lastAt;
		this.lastAt = at;

		if (this.calmSince === 0) {
			this.calmSince = at;
		}

		if (oldestPendingMs > this.pressureMs) {
			// Le lien est en retard. Le compte de calme repart de zero, quelle que soit la suite :
			// meme si la decision est retenue par l'attente, la pression vient d'avoir lieu.
			this.calmSince = at;
			this.decide(at, () => {
				this.target = Math.max(this.floor, Math.round(this.target * DECREASE_FACTOR));
				this.decreases += 1;
			});
		} else if (at - this.calmSince >= this.calmMs && this.target < this.ceiling) {
			this.decide(at, () => {
				this.target = Math.min(this.ceiling, Math.round(this.target + this.ceiling * INCREASE_STEP));
				this.increases += 1;
				// La remontee ne se paie pas d'un droit a remonter aussitot apres : chaque palier
				// demande a nouveau son temps de calme complet.
				this.calmSince = at;
			});
		}

		this.rampTowardTarget(elapsed);
		return this.applied;
	}

	// Cette methode applique une decision seulement si la precedente a eu le temps de se voir.
	decide(at, change) {
		if (this.decidedAt !== 0 && at - this.decidedAt < this.holdMs) {
			return;
		}

		this.decidedAt = at;
		change();
	}

	// Cette methode rapproche le debit applique du debit vise, sans jamais le rejoindre d'un coup.
	rampTowardTarget(elapsedMs) {
		if (this.applied === this.target) {
			return;
		}

		const step = this.ceiling * RAMP_PER_SECOND * (elapsedMs / 1000);

		if (step <= 0) {
			return;
		}

		if (this.applied > this.target) {
			this.applied = Math.max(this.target, Math.round(this.applied - step));
			return;
		}

		this.applied = Math.min(this.target, Math.round(this.applied + step));
	}

	// Cette methode rend ce que le device affiche : le debit reellement applique, et de combien il
	// s'ecarte du plafond choisi.
	report() {
		return {
			ceiling: this.ceiling,
			target: this.target,
			applied: this.applied,
			decreases: this.decreases,
			increases: this.increases,
		};
	}
}

module.exports = {
	BitrateController,
	MIN_BITRATE,
	PRESSURE_MS,
	CALM_MS,
	HOLD_MS,
	DECREASE_FACTOR,
	INCREASE_STEP,
	RAMP_PER_SECOND,
};
