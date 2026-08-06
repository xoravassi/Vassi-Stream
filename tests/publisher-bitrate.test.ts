import assert from "node:assert/strict";
import test from "node:test";

import {
  BitrateController,
  CALM_MS,
  HOLD_MS,
  MIN_BITRATE,
  PRESSURE_MS,
} from "../device/node/publisher-bitrate.js";

// Ce fichier verifie le regulateur de debit du publisher. Il est entierement calculable : le
// regulateur ne connait ni socket ni encodeur, il recoit une duree de retard et rend un debit.
//
// Chaque test decrit une situation de lien reelle, et verifie la propriete qui compte pour l'ecoute,
// pas la valeur exacte du debit : celle-ci depend de constantes qui seront reglees par la mesure.

const PLAFOND = 256000;

// `publisher-bitrate.js` est un module CommonJS sans declaration de types : le nom de la classe est
// une valeur, et son type d'instance se nomme ainsi.
type Controleur = InstanceType<typeof BitrateController>;

// Cette fonction fait avancer le temps en poussant des mesures regulieres, comme le publisher le
// fait a chaque trame. Elle rend le dernier debit applique.
function pousser(
  controleur: Controleur,
  retardMs: number,
  dureeMs: number,
  depuis: number,
  pasMs = 20,
): number {
  let applique = controleur.report().applied;

  for (let ecoule = 0; ecoule < dureeMs; ecoule += pasMs) {
    applique = controleur.update(retardMs, depuis + ecoule);
  }

  return applique;
}

test("part au plafond choisi et n'en bouge pas tant que le lien suit", () => {
  const controleur = new BitrateController(PLAFOND);

  assert.equal(controleur.report().applied, PLAFOND);
  assert.equal(pousser(controleur, 0, 60000, 1000), PLAFOND);
  assert.equal(controleur.report().decreases, 0);
});

test("baisse le debit quand les trames attendent trop longtemps", () => {
  const controleur = new BitrateController(PLAFOND);

  const applique = pousser(controleur, PRESSURE_MS + 100, 20000, 1000);

  assert.ok(applique < PLAFOND, `${applique} devrait etre sous ${PLAFOND}`);
  assert.ok(controleur.report().decreases > 1);
});

test("ne descend jamais sous le plancher, qui garde la stereo et la bande pleine", () => {
  const controleur = new BitrateController(PLAFOND);

  // Un lien effondre, longtemps : le regulateur doit se poser sur le plancher et y rester.
  pousser(controleur, 5000, 600000, 1000);

  assert.equal(controleur.report().target, MIN_BITRATE);
  assert.equal(controleur.report().applied, MIN_BITRATE);
});

test("ne remonte pas au-dessus du plafond choisi par Vassi", () => {
  const controleur = new BitrateController(PLAFOND);

  pousser(controleur, PRESSURE_MS + 100, 10000, 1000);
  pousser(controleur, 0, 600000, 100000);

  assert.equal(controleur.report().applied, PLAFOND);
});

test("remonte seule apres un long calme, sans depasser le plafond", () => {
  const controleur = new BitrateController(PLAFOND);

  const creux = pousser(controleur, PRESSURE_MS + 100, 10000, 1000);
  assert.ok(creux < PLAFOND);

  // Le lien redevient sain : le debit doit remonter, mais pas d'un coup.
  const apresUnPeu = pousser(controleur, 0, CALM_MS + 1000, 20000);
  assert.ok(apresUnPeu > creux, "le debit doit remonter apres le calme");
  assert.ok(apresUnPeu < PLAFOND, "la remontee doit etre progressive, pas immediate");
});

// Ce test couvre la raison d'etre de l'etat de maintien. Une rafale de retransmissions de quelques
// centaines de millisecondes est ordinaire sur un lien 4G : elle doit couter une baisse, pas
// descendre toute l'echelle.
test("une rafale courte ne coute qu'une seule baisse", () => {
  const controleur = new BitrateController(PLAFOND);

  pousser(controleur, PRESSURE_MS + 100, 400, 1000);

  assert.equal(controleur.report().decreases, 1);
});

test("l'attente entre deux decisions est bien respectee", () => {
  const controleur = new BitrateController(PLAFOND);

  pousser(controleur, PRESSURE_MS + 100, HOLD_MS - 100, 1000);
  assert.equal(controleur.report().decreases, 1);

  pousser(controleur, PRESSURE_MS + 100, 200, 1000 + HOLD_MS - 100);
  assert.equal(controleur.report().decreases, 2);
});

// Ce test couvre la condition posee par Vassi : descendre bas est acceptable, s'entendre descendre
// ne l'est pas. Le debit applique ne doit jamais sauter.
test("le debit applique varie en rampe, jamais par sauts audibles", () => {
  const controleur = new BitrateController(PLAFOND);
  const sauts: number[] = [];
  let precedent = controleur.report().applied;

  for (let ecoule = 0; ecoule < 30000; ecoule += 20) {
    const applique = controleur.update(PRESSURE_MS + 100, 1000 + ecoule);
    sauts.push(Math.abs(applique - precedent));
    precedent = applique;
  }

  // A la cadence d'une trame, la rampe ne peut pas depasser 1 % du plafond d'un coup.
  const plusGrandSaut = Math.max(...sauts);
  assert.ok(
    plusGrandSaut <= PLAFOND * 0.011,
    `le plus grand saut vaut ${plusGrandSaut}, soit ${((plusGrandSaut / PLAFOND) * 100).toFixed(1)} % du plafond`,
  );
});

test("une nouvelle session repart du plafond", () => {
  const controleur = new BitrateController(PLAFOND);

  pousser(controleur, 5000, 60000, 1000);
  assert.ok(controleur.report().applied < PLAFOND);

  controleur.reset();

  assert.equal(controleur.report().applied, PLAFOND);
  assert.equal(controleur.report().target, PLAFOND);
});

// Ce test verifie qu'un plafond deja bas ne descend pas sous lui-meme par le jeu du plancher.
test("un plafond sous le plancher reste utilisable", () => {
  const controleur = new BitrateController(MIN_BITRATE);

  pousser(controleur, 5000, 60000, 1000);

  assert.equal(controleur.report().applied, MIN_BITRATE);
});
