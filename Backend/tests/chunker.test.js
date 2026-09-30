import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, MAX_CHUNKS_PER_DOCUMENT } from "../utils/chunker.js";

test("empty/whitespace text -> no chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  "), []);
  assert.deepEqual(chunkText(undefined), []);
});

test("short text stays as a single chunk", () => {
  const chunks = chunkText("Just one short paragraph.", { chunkChars: 1200 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Just one short paragraph.");
});

test("never drops text: every input word appears somewhere in the output", () => {
  const paras = Array.from({ length: 20 }, (_, i) => `Paragraph number ${i} with some filler words about topic ${i}.`);
  const text = paras.join("\n\n");
  const chunks = chunkText(text, { chunkChars: 150, overlapChars: 20 });
  const combined = chunks.join(" ");
  for (const p of paras) {
    for (const word of p.split(" ")) assert.ok(combined.includes(word), `missing word: ${word}`);
  }
});

test("respects chunkChars (allowing small overlap slack)", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence ${i} here.`).join(" ");
  const chunks = chunkText(text, { chunkChars: 100, overlapChars: 15 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 130, `chunk too long: ${c.length}`);
});

test("consecutive chunks share an overlapping tail for context continuity", () => {
  const paras = Array.from({ length: 6 }, (_, i) => `This is paragraph ${i}, it has some unique content ${"x".repeat(40)}.`);
  const chunks = chunkText(paras.join("\n\n"), { chunkChars: 120, overlapChars: 30 });
  assert.ok(chunks.length >= 2);
  // Some prefix of chunk[i+1] should reappear from the tail of chunk[i].
  for (let i = 0; i < chunks.length - 1; i++) {
    const tail = chunks[i].slice(-20);
    assert.ok(chunks[i + 1].includes(tail.slice(-10)), `no overlap between chunk ${i} and ${i + 1}`);
  }
});

test("a single huge paragraph (no blank lines) still gets split", () => {
  const text = "word ".repeat(2000).trim(); // one giant paragraph, ~10000 chars
  const chunks = chunkText(text, { chunkChars: 500, overlapChars: 50 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 600);
});

test("caps total chunks per document", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i} content here.`).join("\n\n");
  const chunks = chunkText(text, { chunkChars: 50, overlapChars: 5 });
  assert.ok(chunks.length <= MAX_CHUNKS_PER_DOCUMENT);
});
