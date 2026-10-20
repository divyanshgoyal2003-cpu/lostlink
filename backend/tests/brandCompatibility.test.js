
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  areBrandsCompatible,
} = require("../src/utils/brandCompatibility");

test("same brands are compatible", () => {
  assert.equal(areBrandsCompatible("Sony", "Sony"), true);
});

test("different known brands are incompatible", () => {
  assert.equal(areBrandsCompatible("Sony", "JBL"), false);
});

test("missing found brand remains eligible", () => {
  assert.equal(areBrandsCompatible("Sony", null), true);
});

test("missing lost brand remains eligible", () => {
  assert.equal(areBrandsCompatible(null, "JBL"), true);
});

test("both missing brands remain eligible", () => {
  assert.equal(areBrandsCompatible(null, null), true);
});

test("brand comparison ignores case and whitespace", () => {
  assert.equal(areBrandsCompatible(" Sony ", "SONY"), true);
});
