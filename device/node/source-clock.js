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

// Plafond d'un pas ordinaire.
//
// Cette valeur est un contrat avec le player, pas un reglage : `MAX_CONCEAL_MICROS` vaut 500 ms
// (`src/player/decode-worker.js`), et un trou annonce au-dela de cette duree fait vider la file au
// lieu d'etre comble. Declarer plus de 500 ms en un seul pas, c'est donc demander une coupure.
//
// Le cas qui l'impose n'est pas la sous-production lissee — celle-la ne produit jamais que des pas
// d'une trame, parce que `lag` retranche le decalage deja applique et ne declare que l'increment.
// C'est l'**arret franc** : quand le moteur audio ne ralentit pas mais s'arrete net puis repart, la
// fenetre rend un seul ecart egal a toute la duree de l'arret. Au banc de rejeu
// (`scripts/bench-continuite.mjs`), une session de 41 minutes contenant des arrets de 600 ms et de
// 2 s passe de 98 coupures et 89 vidages a 8 coupures et zero vidage par ce seul bornage.
//
// Le reliquat ne traine pas : `lag = smallest - shiftMicros` rend a la trame suivante ce que le pas
// precedent n'a pas pris. Un arret d'une seconde part en trois pas, sur 80 ms de temps reel.
const MAX_STEP_MICROS = 400000n;

// Retard au-dela duquel on cesse de declarer un trou pour demander une resynchronisation.
//
// Une machine qui sort de veille produit un ecart de plusieurs minutes d'un seul coup. Il n'y a rien
// a combler la : le son n'existe pas, et l'auditeur n'attend pas trois minutes de silence. Le seul
// geste utile est de le dire une fois, en entier, pour que le player vide sa file et reparte du
// direct.
//
// Ce regime existe parce que borner ce cas-la comme les autres fabrique exactement ce qu'il faut
// eviter. Avec un pas plafonne, le reliquat redeclare a chaque trame suivante et le player recoit un
// **train** de trous trop longs : 12 vidages pour une veille d'une minute, 36 pour trois minutes,
// 120 pour dix. Chacun est un vidage de file suivi d'une remise a zero du decodeur, tires en rafale.
// Un saut unique en rend exactement un, quelle que soit la duree de la veille.
const RESYNC_MICROS = 5000000n;

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
		// Ces trois compteurs decrivent la *forme* du deficit, et pas seulement sa taille.
		//
		// Ils existent parce que le journal ne permettait pas de trancher. Ses lignes `sante` sont
		// ecrites toutes les dix secondes, et a cette granularite une baisse de cadence et un arret
		// franc sont indistinguables — alors que le banc de rejeu leur donne des consequences
		// opposees, zero vidage contre quatre-vingt-neuf. Le pire intervalle du 11 aout 2026, 3440 ms
		// manquants entre 10:22:15 et 10:22:25, peut etre l'un ou l'autre et personne ne peut le dire.
		//
		// `stalls` est la reponse, et c'est celui-la qu'il faut lire : un deficit lisse ne fait jamais
		// depasser la borne d'un pas, parce que `lag` retranche le decalage deja applique et ne declare
		// que l'increment — quarante millisecondes a la fois. Seul un arret franc rend un retard plus
		// grand que ce qu'un pas peut porter.
		//
		// Un arret compte pour **un**, quelle que soit sa taille : le reliquat s'ecoule sur les trames
		// suivantes et ne doit pas se lire comme autant d'arrets. D'ou le drapeau `stalling`, qui tient
		// la suite de pas bornes d'un meme arret.
		this.stalls = 0;
		this.stalling = false;
		// Taille du plus grand arret, mesuree avant bornage : c'est la duree pendant laquelle le moteur
		// audio n'a rien produit du tout.
		this.largestStallMicros = 0n;
		// Nombre de sauts de resynchronisation — les seuls trous que le player ne comble pas.
		this.resyncs = 0;
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

		// Deux regimes, et c'est le retard mesure qui choisit — pas un reglage.
		//
		// Sous le seuil de resynchronisation, le pas est borne a ce que le player sait combler sans
		// interrompre la lecture, et le reliquat part aux trames suivantes. Au-dessus, le combler n'a
		// plus de sens : on le declare en une fois et le player repart du direct.
		const resync = lag > RESYNC_MICROS;
		const wanted = resync ? lag : (lag > MAX_STEP_MICROS ? MAX_STEP_MICROS : lag);
		// La division entiere tronque : la correction ne depasse donc jamais le retard mesure, et le
		// reste attend la fenetre suivante plutot que d'inventer la difference.
		const step = (wanted / FRAME_MICROS) * FRAME_MICROS;

		this.shiftMicros += step;
		this.declaredMicros += step;
		this.gaps += 1;

		// Un pas borne veut dire que le retard mesure depassait ce qu'une seule declaration peut
		// porter : c'est la signature d'un arret franc, et de rien d'autre. La suite de pas bornes qui
		// ecoule le reliquat appartient au meme arret et ne le recompte pas.
		const bounded = !resync && lag > MAX_STEP_MICROS;

		if (bounded && !this.stalling) {
			this.stalls += 1;

			if (lag > this.largestStallMicros) {
				this.largestStallMicros = lag;
			}
		}

		this.stalling = bounded;

		if (resync) {
			this.resyncs += 1;
		}

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
			// Ces trois chiffres disent la forme du deficit, et pas seulement sa taille : une source qui
			// ralentit n'en leve aucun, une source qui s'arrete net les leve tous. Les deux ne se
			// corrigent pas au meme endroit, et le taux ci-dessus ne les distingue pas.
			stalls: this.stalls,
			largestStallMs: Number(this.largestStallMicros / 1000n),
			resyncs: this.resyncs,
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
	MAX_STEP_MICROS,
	RESYNC_MICROS
};
