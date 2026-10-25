const MATCH_SCORE_THRESHOLD = 70;
const STRONG_MATCH_THRESHOLD = 85;
const MATCH_WEIGHTS = Object.freeze({
  location_score: 0.40,
  category_score: 0.15,
  color_score: 0.10,
  time_score: 0.15,
  title_score: 0.05,
  description_score: 0.05,
  brand_model_score: 0.10,
});

const UNKNOWN_MATCH_VALUES = Object.freeze([
  "i don t know", "i dont know", "dont know", "do not know",
  "unknown", "not known", "not specified", "unspecified", "n a", "na",
]);
const unknownMatchValues = new Set(UNKNOWN_MATCH_VALUES);

const GENERIC_MATCH_TERMS = Object.freeze([
  "a", "an", "and", "are", "for", "found", "in", "item", "lost", "my", "of", "on", "or", "report", "the", "to", "with",
  "accessory", "accessories", "bag", "bags", "black", "blue", "bluetooth", "brown", "case", "cases", "cellphone", "charger", "chargers",
  "computer", "computers", "device", "devices", "earbud", "earbuds", "earphone", "earphones", "green", "gray", "grey", "headphone", "headphones",
  "headset", "headsets", "item", "items", "key", "keys", "large", "laptop", "laptops", "medium", "mobile", "new", "old", "phone", "phones",
  "purse", "red", "screen", "screens", "shirt", "shirts", "shoe", "shoes", "silver", "small", "smartphone", "tablet", "tablets", "used",
  "wallet", "watch", "watches", "white", "wireless", "yellow",
]);

function normalizeMatchingText(value) {
  return typeof value === "string"
    ? value.toLocaleLowerCase("en").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";
}

function normalizeKnownValue(value) {
  const normalized = normalizeMatchingText(value);
  return normalized && !unknownMatchValues.has(normalized) ? normalized : null;
}

function tokenizeMatchingText(value) {
  return new Set(normalizeMatchingText(value).split(/\s+/u)
    .filter((word) => word.length > 1 && !GENERIC_MATCH_TERMS.includes(word)));
}

function textSimilarity(left, right) {
  const a = tokenizeMatchingText(left);
  const b = tokenizeMatchingText(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return Math.round((100 * intersection / new Set([...a, ...b]).size) * 100) / 100;
}

function scoreKnownField(left, right) {
  const a = normalizeKnownValue(left);
  const b = normalizeKnownValue(right);
  if (!a || !b) return null;
  return a === b ? 100 : 0;
}

function calculateBrandModelScore(lostBrand, foundBrand, lostModel, foundModel) {
  const evidence = [
    scoreKnownField(lostBrand, foundBrand),
    scoreKnownField(lostModel, foundModel),
  ].filter((score) => score !== null);
  return evidence.length
    ? Math.round((evidence.reduce((sum, score) => sum + score, 0) / evidence.length) * 100) / 100
    : 50;
}

function calculateLocationScore(distanceM, lostRadiusM, foundRadiusM) {
  const values = [distanceM, lostRadiusM, foundRadiusM];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value)) || values.some((value) => value < 0)) return 50;
  const [distance, lostRadius, foundRadius] = values;
  const combinedRadius = lostRadius + foundRadius;
  if (combinedRadius === 0) return distance === 0 ? 100 : 0;
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - distance / combinedRadius))) * 100) / 100;
}

function calculateTimeScore(lostTime, foundTime) {
  if (lostTime == null || foundTime == null || lostTime === "" || foundTime === "") return 50;
  const lost = new Date(lostTime).getTime();
  const found = new Date(foundTime).getTime();
  if (!Number.isFinite(lost) || !Number.isFinite(found)) return 50;
  const daysApart = Math.abs(lost - found) / 86400000;
  if (daysApart <= 1) return 100;
  if (daysApart <= 7) return 80;
  if (daysApart <= 30) return 50;
  if (daysApart <= 90) return 25;
  return 0;
}

function hasDiscriminativeEvidence(scores, evidence = {}) {
  if (!scores || ![scores.title_score, scores.description_score, scores.brand_model_score]
    .every((score) => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100)) return false;
  return scores.title_score > 0 || scores.description_score > 0 || evidence.brandModelMatch === true;
}

function isActionableMatch(scores, evidence) {
  const score = calculateWeightedScore(scores);
  return score !== null && score >= MATCH_SCORE_THRESHOLD && hasDiscriminativeEvidence(scores, evidence);
}

function calculateWeightedScore(scores) {
  const entries = Object.entries(MATCH_WEIGHTS);
  if (!scores || entries.some(([key]) => typeof scores[key] !== "number" || !Number.isFinite(scores[key]) || scores[key] < 0 || scores[key] > 100)) return null;
  const weightTotal = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const raw = entries.reduce((sum, [key, weight]) => sum + Number(scores[key]) * weight, 0);
  if (!Number.isFinite(raw) || Math.abs(weightTotal - 1) > Number.EPSILON * 8) return null;
  return Math.round(Math.max(0, Math.min(100, raw)) * 100) / 100;
}

function isQualifyingMatchScore(score) {
  return Number.isFinite(Number(score)) && Number(score) >= MATCH_SCORE_THRESHOLD;
}

function getMatchStrength(score) {
  if (!isQualifyingMatchScore(score)) return null;
  return Number(score) >= STRONG_MATCH_THRESHOLD ? "STRONG" : "POTENTIAL";
}

module.exports = {
  MATCH_SCORE_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
  MATCH_WEIGHTS,
  GENERIC_MATCH_TERMS,
  normalizeMatchingText,
  normalizeKnownValue,
  UNKNOWN_MATCH_VALUES,
  tokenizeMatchingText,
  textSimilarity,
  calculateBrandModelScore,
  calculateLocationScore,
  calculateTimeScore,
  calculateWeightedScore,
  hasDiscriminativeEvidence,
  isActionableMatch,
  getMatchStrength,
  isQualifyingMatchScore,
};
