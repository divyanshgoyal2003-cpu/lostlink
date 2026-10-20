
function calculateModelScore(lostModel, foundModel) {
  const lost = String(lostModel ?? "").trim().toLowerCase();
  const found = String(foundModel ?? "").trim().toLowerCase();

  if (!lost || !found) {
    return 50;
  }

  if (lost === found) {
    return 100;
  }

  return 0;
}

module.exports = { calculateModelScore };
