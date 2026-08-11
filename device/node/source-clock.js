"use strict";

// Ce module repond a une question que rien d'autre ne posait dans le device : l'encodeur a-t-il
// produit autant de son que le temps qui a passe ?
//
// Il existe a cause de l'essai du 11 aout 2026. Sur 41 minutes, l'external a rendu 24,08 trames par
// seconde au lieu de 25 : 91 s de musique qu'Ableton n'a jamais calculees, parce que le processeur
// etait pris par le partage d'ecran du cours. Aucun compteur ne l'a vu — ni `gaps`, ni
// `framesDropped`, ni saut de sequence — et pour une raison precise : l'external avance son horloge
// d'une trame par trame *produite* (`timestamp_us += FRAME_DURATION_US`). Quand Ableton saute un bloc
// DSP, `perform64` n'est pas appele, aucun sample n'arrive, et l'horloge recolle les deux bords du
// trou comme s'ils etaient contigus. Le paquet suivant ment donc sur l'heure qu'il est.
//
// Le player, lui, consomme le temps reel. Sa file se vide alors de la duree manquante — 37 ms par
// seconde ce jour-la — sans que rien ne la remonte, jusqu'a la coupure. Un decrochage de 40 ms chez
// Ableton coutait 2,3 s de silence a l'auditeur, jusqu'a une minute plus tard, et aucun compteur ne
// permettait de relier les deux.
//
// Declarer le trou la ou il s'est produit ne rend pas le son perdu : rien ne le rend. Cela supprime
// l'amplification. Le player sait deja combler un trou annonce sans interrompre la lecture, tant
// qu'il tient sous `MAX_CONCEAL_MICROS` — et sa file reste alors au niveau demande au lieu de
// s'user trou apres trou.
//
// Ce module ne connait ni socket, ni protocole, ni Max : il recoit des timestamps et des dates, il
// rend un decalage. C'est ce qui le rend verifiable sous Node, seconde par seconde.

// Duree nominale d'une trame du protocole v1, en microsecondes.
const FRAME_MICROS = 40000n;

// Duree de la fenetre de mesure, en millisecondes.
//
// Le retard n'est pas lisible sur une trame isolee. Les trames arrivent du pont loopback par
// paquets, et le tour de boucle de Node ajoute son propre retard : mesure trame par trame, l'ecart
// saute dans les deux sens de plusieurs dizaines de millisecondes. On garde donc une fenetre et on
// n'en retient que le minimum.
//
// Le minimum est la mesure la moins polluee. Un tour de boucle en retard ne peut que gonfler l'ecart
// observe, jamais le reduire : le minimum ecarte donc tout seul les retards de Node, qui sont
// exactement ce qu'il ne faut pas confondre avec un decrochage d'Ableton.
const WINDOW_MS = 2000;

// Le biais qui reste est volontairement du bon cote. Une rafale de trames livrees ensemble fait
// paraitre l'ecart plus petit qu'il n'est, et le minimum garde cette valeur-la : on declare donc un
// peu moins que la verite, et le regime permanent conserve environ `WINDOW_MS` x derive de retard
// jamais declare — 74 ms au taux du 11 aout. C'est un decalage constant, pas une derive, et il est
// du bon cote : sous-declarer laisse passer du son, sur-declarer inventerait un trou qui n'a pas eu
// lieu.

// Retard minimal avant de declarer quoi que ce soit.
//
// Sous une trame il n'y a rien a dire : le player ignore de toute facon tout ecart de timestamp
// inferieur a une trame, parce qu'un timestamp qui n'avance pas de plus d'une trame ne decrit aucun
// trou. C'est aussi pourquoi la correction se fait par trames entieres.
const MIN_LAG_MICROS = FRAME_MICROS;

// Plafond d'une correction unique.
//
// Une machine qui sort de veille produit un ecart de plusieurs minutes d'un seul coup. Le declarer
// tel quel ferait sauter la chronologie de la session. La borne le ramene a un trou long, que le
// player traite comme les autres trous longs : il vide sa file et repart du direct.
const MAX_STEP_MICROS = 5000000n;

// Cette classe suit l'ecart entre le temps audio produit et le temps reel, et rend le decalage a
// appliquer aux timestamps sortants.
class SourceClock {
	constructor() {
		this.reset();
	}

	// Cette methode repart de zero pour une nouvelle session.
	//
	// Elle est appelee au meme endroit que la remise a zero de la chronologie de session, et c'est
	// voulu : les deux decrivent la meme origine. Un decalage herite d'une session precedente ferait
	// commencer la nouvelle ailleurs qu'a zero.
	reset() {
		this.baseTimestamp = null;
		this.baseAt = 0;
		this.shiftMicros = 0n;
		this.samples = [];
		this.declaredMicros = 0n;
		this.gaps = 0;
		this.audioMicros = 0n;
		this.elapsedMicros = 0n;
	}

	// Cette methode enregistre l'arrivee d'une trame et rend le decalage a appliquer a partir de
	// maintenant.
	//
	// `timestampMicros` est l'horloge de l'external, qui compte les trames produites. `atMs` est
	// l'horloge de la machine, qui compte le temps reel. Tout ce module tient dans l'ecart entre les
	// deux.
	note(timestampMicros, atMs) {
		if (this.baseTimestamp === null) {
			this.baseTimestamp = timestampMicros;
			this.baseAt = atMs;
			return this.shiftMicros;
		}

		const audio = timestampMicros - this.baseTimestamp;
		const elapsed = BigInt(Math.round((atMs - this.baseAt) * 1000));

		// Une horloge murale qui recule ne mesure rien. Elle arrive apres une remise a l'heure du
		// systeme, et la fenetre courante ne veut alors plus rien dire.
		if (elapsed < 0n) {
			this.samples.length = 0;
			return this.shiftMicros;
		}

		this.audioMicros = audio;
		this.elapsedMicros = elapsed;

		// L'ecart est garde *avant* soustraction du decalage deja applique. Les echantillons de la
		// fenetre restent ainsi comparables entre eux quand une correction tombe au milieu d'elle :
		// sans cela il faudrait rebaser toute la fenetre a chaque correction.
		this.samples.push({ at: atMs, rawLag: elapsed - audio });

		while (this.samples.length > 1 && atMs - this.samples[0].at > WINDOW_MS) {
			this.samples.shift();
		}

		// Tant que la fenetre n'a pas la profondeur voulue, le minimum ne filtre rien et le premier
		// retard de Node passerait pour un decrochage.
		if (atMs - this.baseAt < WINDOW_MS) {
			return this.shiftMicros;
		}

		let smallest = this.samples[0].rawLag;

		for (const sample of this.samples) {
			if (sample.rawLag < smallest) {
				smallest = sample.rawLag;
			}
		}

		const lag = smallest - this.shiftMicros;

		if (lag < MIN_LAG_MICROS) {
			return this.shiftMicros;
		}

		const wanted = lag > MAX_STEP_MICROS ? MAX_STEP_MICROS : lag;
		// La division entiere tronque : la correction ne depasse donc jamais le retard mesure, et le
		// reste attend la fenetre suivante plutot que d'inventer la difference.
		const step = (wanted / FRAME_MICROS) * FRAME_MICROS;

		this.shiftMicros += step;
		this.declaredMicros += step;
		this.gaps += 1;

		return this.shiftMicros;
	}

	// Cette methode rend de quoi juger la sante de la source, pour le journal.
	//
	// `ratio` compare le son produit au temps ecoule, et c'est la mesure qui manquait le 11 aout :
	// elle valait 0,963 pendant que tous les autres compteurs affichaient zero probleme.
	report() {
		const elapsed = Number(this.elapsedMicros);
		const ratio = elapsed <= 0 ? 1 : Number(this.audioMicros) / elapsed;

		return {
			ratio,
			framesPerSecond: ratio * 25,
			declaredMs: Number(this.declaredMicros / 1000n),
			gaps: this.gaps,
			audioMicros: this.audioMicros,
			elapsedMicros: this.elapsedMicros
		};
	}
}

module.exports = {
	SourceClock,
	FRAME_MICROS,
	WINDOW_MS,
	MIN_LAG_MICROS,
	MAX_STEP_MICROS
};
