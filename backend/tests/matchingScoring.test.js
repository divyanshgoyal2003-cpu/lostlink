const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  MATCH_WEIGHTS,
  GENERIC_MATCH_TERMS,
  normalizeMatchingText,
  normalizeKnownValue,
  tokenizeMatchingText,
  textSimilarity,
  calculateBrandModelScore,
  calculateLocationScore,
  calculateTimeScore,
  calculateWeightedScore,
  hasDiscriminativeEvidence,
  isActionableMatch,
} = require("../src/config/matching");

test("matching weights sum to one and scores are finite and bounded", () => {
  assert.ok(Math.abs(Object.values(MATCH_WEIGHTS).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-10);
  const perfect = Object.fromEntries(Object.keys(MATCH_WEIGHTS).map((key) => [key, 100]));
  const neutral = Object.fromEntries(Object.keys(MATCH_WEIGHTS).map((key) => [key, 50]));
  assert.equal(calculateWeightedScore(perfect), 100);
  assert.equal(calculateWeightedScore(neutral), 50);
  assert.equal(calculateWeightedScore({ ...perfect, title_score: Number.NaN }), null);
  assert.equal(calculateWeightedScore({ ...perfect, title_score: 101 }), null);
  assert.equal(calculateWeightedScore({ ...perfect, title_score: null }), null);
  const weak = { ...perfect, location_score: 100, category_score: 100, time_score: 100, color_score: 50, brand_model_score: 50, title_score: 0, description_score: 0 };
  assert.equal(calculateWeightedScore(weak), 80);
  assert.equal(hasDiscriminativeEvidence(weak), false);
  assert.equal(isActionableMatch(weak), false);
  assert.equal(isActionableMatch({ ...weak, title_score: 25 }), true);
  assert.equal(isActionableMatch({ ...weak, brand_model_score: 100 }), false);
  assert.equal(isActionableMatch({ ...weak, brand_model_score: 100 }, { brandModelMatch: true }), true);
});

test("text normalization ignores case and punctuation and excludes generic evidence", () => {
  assert.equal(normalizeMatchingText("  Sony-WH 1000XM5! "), "sony wh 1000xm5");
  assert.deepEqual([...tokenizeMatchingText("Black headphones found item")], []);
  assert.equal(textSimilarity("Black phone red", "Blue phone black"), 0);
  assert.equal(textSimilarity("Black phone", "Black mobile phone"), 0);
  assert.ok(textSimilarity("Black phone with a small crack in the bottom right corner of the screen and a transparent case with a yellow sticker.", "Black phone with a cracked bottom right corner of the screen and a transparent case with a yellow sticker.") > 0);
  assert.equal(textSimilarity("Sony-WH 1000XM5 black headphones", "SONY WH-1000XM5 headphones"), 100);
  assert.ok(GENERIC_MATCH_TERMS.includes("phone"));
});

test("brand and model use available comparable evidence and keep unknowns neutral", () => {
  assert.equal(calculateBrandModelScore("Sony", " sony! ", null, null), 100);
  assert.equal(calculateBrandModelScore(null, null, "WH-1000XM5", "wh 1000xm5"), 100);
  assert.equal(calculateBrandModelScore("Sony", "JBL", "M5", "M5"), 50);
  assert.equal(calculateBrandModelScore(null, null, null, null), 50);
  assert.equal(normalizeKnownValue("I don't know"), null);
  assert.equal(normalizeKnownValue("  UNKNOWN  "), null);
  assert.equal(normalizeKnownValue("Sony"), "sony");
  assert.equal(calculateBrandModelScore("I don't know", "I don't know", "I don't know", "I don't know"), 50);
  assert.equal(calculateBrandModelScore("", "   ", null, undefined), 50);
  assert.equal(calculateBrandModelScore("Unknown", "Sony", "N/A", "WH-1000XM5"), 50);
});

test("location scoring handles approximate, distant, zero-radius, and invalid values", () => {
  assert.equal(calculateLocationScore(75, 75, 75), 50);
  assert.equal(calculateLocationScore(0, 0, 0), 100);
  assert.equal(calculateLocationScore(1, 0, 0), 0);
  assert.equal(calculateLocationScore(1000, 75, 75), 0);
  assert.equal(calculateLocationScore(Number.POSITIVE_INFINITY, 75, 75), 50);
  assert.equal(calculateLocationScore(null, 75, 75), 50);
});

test("production candidate SQL uses the tested factors without exposing found titles", () => {
  const route = fs.readFileSync(path.join(__dirname, "../src/routes/matches.js"), "utf8");
  assert.match(route, /MATCH_WEIGHTS/);
  assert.match(route, /GENERIC_MATCH_TERMS/);
  assert.match(route, /brand_model_score/);
  assert.match(route, /brand_model_match_evidence = TRUE/);
  assert.doesNotMatch(route, /brand_model_score = 100\)/);
  assert.match(route, /unknownMatchValuesSql/);
  assert.match(route, /\$1/);
  assert.match(route, /lost_radius_m \+ found_radius_m = 0/);
  assert.match(route, /isfinite\(lost_report_time\)/);
  assert.match(route, /daysApart: match\.days_apart == null \? null/);
  assert.match(route, /lost_description_norm/);
  assert.match(route, /scoreBreakdown:/);
  assert.doesNotMatch(route, /foundTitle:\s*match\.found_title/);
});

test("time scoring uses absolute UTC elapsed time and neutralizes unavailable dates", () => {
  assert.equal(calculateTimeScore("2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z"), 80);
  assert.equal(calculateTimeScore("2026-01-08T00:00:00Z", "2026-01-01T00:00:00Z"), 80);
  assert.equal(calculateTimeScore("2026-01-01T00:00:00Z", "invalid"), 50);
  assert.equal(calculateTimeScore("2026-01-01T00:00:00Z", "2026-05-02T00:00:00Z"), 0);
});
