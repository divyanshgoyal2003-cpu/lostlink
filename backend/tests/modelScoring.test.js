
const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateModelScore } = require("../src/utils/modelScoring");

test("identical models score 100", () => {
  assert.equal(calculateModelScore("iPhone 15", "iPhone 15"), 100);
});

test("different models score 0", () => {
  assert.equal(calculateModelScore("iPhone 15", "Samsung S24"), 0);
});

test("missing found model scores 50", () => {
  assert.equal(calculateModelScore("iPhone 15", null), 50);
});

test("missing lost model scores 50", () => {
  assert.equal(calculateModelScore(null, "iPhone 15"), 50);
});

test("both missing models score 50", () => {
  assert.equal(calculateModelScore(null, null), 50);
});

test("model comparison ignores case and surrounding whitespace", () => {
  assert.equal(calculateModelScore(" iPhone 15 ", "IPHONE 15"), 100);
});
