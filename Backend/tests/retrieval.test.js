import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity } from "../utils/retrieval.js";

test("identical vectors -> similarity 1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test("opposite vectors -> similarity -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
});

test("orthogonal vectors -> similarity 0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test("mismatched lengths / empty / zero vector -> -Infinity (never crashes, always sorts last)", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), -Infinity);
  assert.equal(cosineSimilarity([], []), -Infinity);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), -Infinity);
  assert.equal(cosineSimilarity(null, [1, 2]), -Infinity);
});

test("ranks a closer vector above a farther one", () => {
  const query = [1, 1, 0];
  const close = [1, 0.9, 0.1];
  const far = [-1, -1, 0];
  assert.ok(cosineSimilarity(query, close) > cosineSimilarity(query, far));
});
