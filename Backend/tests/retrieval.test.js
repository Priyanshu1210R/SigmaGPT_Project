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

test("rankByCosine returns topK best chunks, best first, without raw embeddings", async () => {
  const { rankByCosine } = await import("../utils/retrieval.js");
  const out = rankByCosine(
    [
      { chunkIndex: 0, embedding: [0, 1] },
      { chunkIndex: 1, embedding: [1, 0] },
      { chunkIndex: 2, embedding: [0.9, 0.1] },
    ],
    [1, 0],
    2
  );
  assert.deepEqual(out.map((c) => c.chunkIndex), [1, 2]);
  assert.ok(!("embedding" in out[0]));
});

test("retrieveRelevantChunks falls back to local search when $vectorSearch returns zero rows", async () => {
  const { default: DocumentChunk } = await import("../models/DocumentChunk.js");
  const { retrieveRelevantChunks } = await import("../utils/retrieval.js");
  const origAggregate = DocumentChunk.aggregate;
  const origFind = DocumentChunk.find;
  try {
    DocumentChunk.aggregate = async () => []; // Atlas: index missing/building -> empty, no error
    DocumentChunk.find = () => ({
      lean: async () => [
        { chunkIndex: 0, text: "far", embedding: [0, 1] },
        { chunkIndex: 1, text: "near", embedding: [1, 0] },
      ],
    });
    const out = await retrieveRelevantChunks({ threadId: "t", userId: "507f1f77bcf86cd799439011", queryEmbedding: [1, 0], topK: 5 });
    assert.deepEqual(out.map((c) => c.text), ["near", "far"]);
  } finally {
    DocumentChunk.aggregate = origAggregate;
    DocumentChunk.find = origFind;
  }
});
