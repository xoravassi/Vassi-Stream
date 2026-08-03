import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Le code du device reste en CommonJS parce que Node for Max expose max-api par NODE_PATH.
const require = createRequire(import.meta.url);
const { BACKOFF_STEPS_MS, JITTER_RATIO, backoffStepMs, backoffDelayMs } = require("../device/node/publisher-backoff.js");

// Ce test verifie la suite exacte demandee par la roadmap.
test("suit les paliers 1, 2, 4, 8, 16 et 30 secondes", () => {
  assert.deepEqual(BACKOFF_STEPS_MS, [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((attempt) => backoffStepMs(attempt)), BACKOFF_STEPS_MS);
});

// Ce test verifie qu'une coupure longue continue d'etre retentee au dernier palier.
test("reste au dernier palier apres la derniere tentative", () => {
  assert.equal(backoffStepMs(6), 30000);
  assert.equal(backoffStepMs(50), 30000);
  assert.equal(backoffStepMs(-1), 1000);
});

// Ce test verifie que le jitter reste dans les bornes annoncees, sans jamais donner zero.
test("ajoute un jitter borne autour du palier", () => {
  for (const attempt of [0, 1, 2, 3, 4, 5, 9]) {
    const step: number = backoffStepMs(attempt);
    const lowest: number = backoffDelayMs(attempt, () => 0);
    const highest: number = backoffDelayMs(attempt, () => 1);

    assert.equal(lowest, Math.round(step * (1 - JITTER_RATIO)));
    assert.equal(highest, Math.round(step * (1 + JITTER_RATIO)));
    assert.ok(lowest > 0);

    for (let index = 0; index < 50; index += 1) {
      const delay: number = backoffDelayMs(attempt);
      assert.ok(delay >= lowest && delay <= highest, `delai ${delay} hors bornes pour la tentative ${attempt}`);
    }
  }
});
