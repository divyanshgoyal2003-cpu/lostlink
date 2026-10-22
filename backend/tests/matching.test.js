const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MATCH_SCORE_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
  getMatchStrength,
  isQualifyingMatchScore,
} = require("../src/config/matching");

test("the shared match threshold uses a 0–100 score and includes 70 exactly", () => {
  assert.equal(MATCH_SCORE_THRESHOLD, 70);
  assert.equal(isQualifyingMatchScore(69.99), false);
  assert.equal(isQualifyingMatchScore(70), true);
  assert.equal(isQualifyingMatchScore(100), true);
  assert.equal(isQualifyingMatchScore(Number.NaN), false);
});

test("match strength bands follow the normalized score scale", () => {
  assert.equal(getMatchStrength(69.99), null);
  assert.equal(getMatchStrength(70), "POTENTIAL");
  assert.equal(getMatchStrength(84.99), "POTENTIAL");
  assert.equal(STRONG_MATCH_THRESHOLD, 85);
  assert.equal(getMatchStrength(85), "STRONG");
  assert.equal(getMatchStrength(100), "STRONG");
});
