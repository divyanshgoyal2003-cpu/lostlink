
function areBrandsCompatible(lostBrand, foundBrand) {
  const lost = String(lostBrand ?? "").trim().toLowerCase();
  const found = String(foundBrand ?? "").trim().toLowerCase();

  // Unknown brands do not automatically reject a candidate.
  if (!lost || !found) {
    return true;
  }

  // Reject only when both known brands differ.
  return lost === found;
}

module.exports = { areBrandsCompatible };
