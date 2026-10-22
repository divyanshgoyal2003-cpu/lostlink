const MATCH_SCORE_THRESHOLD = 70;
const STRONG_MATCH_THRESHOLD = 85;

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
  getMatchStrength,
  isQualifyingMatchScore,
};
