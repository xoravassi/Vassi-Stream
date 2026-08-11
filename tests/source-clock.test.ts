import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { SourceClock, FRAME_MICROS, WINDOW_MS, MAX_STEP_MICROS } = require("../device/node/source-clock.js");

// Ce fichier verifie l'horloge de source. Elle est pure — elle recoit des timestamps et des dates,
// elle rend un decalage — donc chaque scenario se joue ici en quelques microsecondes au lieu de
// demander quarante minutes de direct et une machine saturee.
//
// Ce qu'elle doit distinguer tient en une phrase : un moteur audio qui ne calcule plus assez de son
// doit etre vu, et le desordre ordinaire de Node ne doit jamais passer pour ca.

// Cette fonction fait tourner une source pendant `secondes`, en produisant `ratio` fois le temps
// reel. A `ratio` egal a un, l'external suit l'horloge murale ; a 0,963, il rend 24,08 trames par
// seconde au lieu de 25, ce qui est exactement ce qu'a mesure l'essai du 11 aout 2026.
//
// `retardMs` permet d'ajouter le desordre de Node a une trame donnee sans toucher a la source.
function tourner(
  horloge: any,
  options: { secondes: number; ratio?: number; depart?: number; retardMs?: (index: number) => number }
): { shift: bigint; at: number } {
  const ratio = options.ratio ?? 1;
  const depart = options.depart ?? 1000;
  const retardMs = options.retardMs ?? (() => 0);
  const trames = Math.round((options.secondes * 1000 * ratio) / 40);

  let shift = 0n;
  let at = depart;

  for (let index = 0; index < trames; index += 1) {
    // La trame porte toujours 40 ms d'audio ; c'est le temps reel qui en met davantage a passer
    // quand la machine ne suit plus.
    at = depart + Math.round(((index + 1) * 40) / ratio);
    shift = horloge.note(BigInt((index + 1) * 40000), at + retardMs(index));
  }

  return { shift, at };
}

// Ce test fixe le cas normal. Une machine qui suit ne doit rien produire du tout : la moindre
// correction inventee ici serait un trou de silence que personne n'a perdu.
test("ne declare rien quand la source suit le temps reel", () => {
  const horloge = new SourceClock();

  const { shift } = tourner(horloge, { secondes: 120 });

  assert.equal(shift, 0n);
  assert.equal(horloge.report().gaps, 0);
});

// Ce test est celui du 11 aout 2026. La source rend 96,3 % du temps reel, et l'horloge doit
// retrouver les 37 ms par seconde qui manquent — sans quoi la file du player se vide de cette
// quantite jusqu'a la coupure.
test("retrouve le deficit d'une source qui ne produit que 96,3 % du temps reel", () => {
  const horloge = new SourceClock();

  const { shift } = tourner(horloge, { secondes: 60, ratio: 0.963 });

  // Le minimum de la fenetre est celui d'il y a `WINDOW_MS`, donc la mesure est en retard d'autant :
  // c'est voulu, et c'est du bon cote. On attend 37 ms/s sur 60 s moins ce retard.
  const attendu = 0.037 * (60 - WINDOW_MS / 1000) * 1_000_000;

  assert.ok(
    Number(shift) > attendu - 100_000 && Number(shift) < attendu + 100_000,
    `decalage ${Number(shift) / 1000} ms, attendu autour de ${attendu / 1000} ms`
  );

  // Le player ignore tout ecart de timestamp inferieur a une trame : declarer autre chose que des
  // trames entieres perdrait le reste en route.
  assert.equal(shift % FRAME_MICROS, 0n);
});

// Ce test protege contre la confusion qui rendrait tout le module nuisible. Un tour de boucle de
// Node en retard ressemble a un decrochage d'Ableton — sauf qu'il ne l'est pas, et declarer un trou
// la ou le son existe le remplacerait par du silence.
test("ne prend pas un tour de boucle de Node en retard pour un decrochage", () => {
  const horloge = new SourceClock();

  // Une trame livree une demi-seconde trop tard, largement au-dessus du seuil d'une trame.
  const { shift } = tourner(horloge, {
    secondes: 60,
    retardMs: (index) => (index === 500 ? 500 : 0)
  });

  assert.equal(shift, 0n);
});

// Ce test couvre l'autre moitie du desordre de Node : les trames arrivent souvent par paquets. Le
// minimum de la fenetre les traverse sans rien declarer, et surtout sans jamais reculer.
test("traverse une rafale de trames sans rien declarer ni reculer", () => {
  const horloge = new SourceClock();

  // Une trame sur quatre arrive collee a la precedente, puis le retard se resorbe.
  const { shift } = tourner(horloge, {
    secondes: 60,
    retardMs: (index) => (index % 4 === 0 ? -20 : 0)
  });

  assert.equal(shift, 0n);
});

// Ce test verifie le cas de la mise en veille. L'ecart se compte alors en minutes, et le declarer
// tel quel ferait sauter la chronologie de la session d'un bloc.
test("borne une seule correction, meme apres une mise en veille", () => {
  const horloge = new SourceClock();

  tourner(horloge, { secondes: 10 });

  // La machine se reveille une minute plus tard : l'audio n'a pas avance, le temps si.
  const shift = horloge.note(BigInt(251 * 40000), 1000 + 10_040 + 60_000);

  assert.equal(shift, MAX_STEP_MICROS);
});

// Ce test verifie qu'une horloge murale remise a l'heure ne produit rien. Elle recule alors d'un
// coup, et l'ecart mesure n'a plus de sens jusqu'a ce que la fenetre se soit renouvelee.
test("ne declare rien quand l'horloge de la machine recule", () => {
  const horloge = new SourceClock();

  tourner(horloge, { secondes: 10 });
  const shift = horloge.note(BigInt(251 * 40000), 500);

  assert.equal(shift, 0n);
});

// Ce test verifie que le rapport rend bien ce que le journal affiche. C'est ce chiffre, et lui seul,
// qui aurait nomme le probleme du 11 aout : tous les autres compteurs du device etaient au vert.
test("rend un taux de production lisible par le journal", () => {
  const horloge = new SourceClock();

  tourner(horloge, { secondes: 60, ratio: 0.963 });

  const rapport = horloge.report();

  assert.ok(
    rapport.framesPerSecond > 24.0 && rapport.framesPerSecond < 24.2,
    `${rapport.framesPerSecond} trames/s, attendu autour de 24,08`
  );
  assert.ok(rapport.gaps > 0);
});

// Ce test verifie qu'un nouveau direct repart a neuf, comme la chronologie de session avec laquelle
// cette horloge est remise a zero.
test("oublie tout a la remise a zero", () => {
  const horloge = new SourceClock();

  tourner(horloge, { secondes: 60, ratio: 0.963 });
  assert.ok(horloge.shiftMicros > 0n);

  horloge.reset();

  assert.equal(horloge.shiftMicros, 0n);
  assert.equal(horloge.report().gaps, 0);
  assert.equal(horloge.report().ratio, 1);
});
