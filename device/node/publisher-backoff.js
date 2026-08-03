"use strict";

// Cette suite est celle fixee par la roadmap. La derniere valeur se repete indefiniment :
// une coupure longue continue d'etre retentee toutes les trente secondes environ.
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// Ce ratio etale les tentatives entre 80 % et 120 % du palier.
// Sans cet ecart, un relais qui redemarre recevrait toutes les reconnexions au meme instant.
const JITTER_RATIO = 0.2;

// Cette fonction donne le palier brut d'une tentative, sans jitter.
// La tentative zero est la premiere reconnexion apres une coupure.
function backoffStepMs(attempt) {
	const index = Math.min(Math.max(attempt, 0), BACKOFF_STEPS_MS.length - 1);
	return BACKOFF_STEPS_MS[index];
}

// Cette fonction donne le delai reel avant la prochaine tentative.
// Le generateur aleatoire est injectable pour rendre les tests reproductibles.
function backoffDelayMs(attempt, random = Math.random) {
	const step = backoffStepMs(attempt);
	const factor = 1 - JITTER_RATIO + random() * JITTER_RATIO * 2;
	return Math.round(step * factor);
}

module.exports = { BACKOFF_STEPS_MS, JITTER_RATIO, backoffStepMs, backoffDelayMs };
