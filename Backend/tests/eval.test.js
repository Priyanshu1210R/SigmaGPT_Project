// Offline tests for the RAG evaluation harness (eval/). No network, no API key needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalize,
  containsFact,
  chunkHasEvidence,
  scoreRetrieval,
  chanceHitRate,
  scoreKeyFacts,
  extractCitations,
  scoreCitations,
  wilson,
  summarize,
} from "../eval/metrics.js";
import { buildChunks, runEval, validateDataset } from "../eval/evalCore.js";
import { createBm25 } from "../eval/bm25.js";
import { formatReport } from "../eval/report.js";
import { parseJudgeJson, createJudge } from "../eval/judge.js";
import { withRetry, mapPool, isRetryable } from "../eval/util.js";
import { rankByCosine } from "../utils/retrieval.js";

const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eval");
const DOC = fs.readFileSync(path.join(EVAL_DIR, "test-document.md"), "utf8");
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "questions.json"), "utf8")).questions;

// ---------- the dataset itself ----------

test("shipped dataset is valid: unique ids, evidence verbatim in doc AND reachable inside one chunk, keyFacts match expected", () => {
  const problems = validateDataset(DOC, QUESTIONS, buildChunks(DOC));
  assert.deepEqual(problems, []);
});

test("dataset has a healthy size and mix, including unanswerable questions", () => {
  assert.ok(QUESTIONS.length >= 20 && QUESTIONS.length <= 35, `got ${QUESTIONS.length}`);
  const cats = new Set(QUESTIONS.map((q) => q.category));
  for (const c of ["factual", "numeric", "paraphrase", "multi-chunk", "unanswerable"]) assert.ok(cats.has(c), `missing ${c}`);
});

test("validateDataset catches bad evidence, duplicate ids and unanswerable-with-evidence", () => {
  const chunks = buildChunks(DOC);
  const bad = [
    { id: "X1", category: "factual", question: "q", expected: "e", evidence: ["this sentence is not in the document"] },
    { id: "X1", category: "factual", question: "q", expected: "e", evidence: ["LabList exposes 42 methods."] },
    { id: "X2", category: "unanswerable", question: "q", expected: "e", evidence: ["LabList exposes 42 methods."] },
    { id: "X3", category: "numeric", question: "q", expected: "forty two", evidence: ["LabList exposes 42 methods."], keyFacts: [["42"]] },
  ];
  const problems = validateDataset(DOC, bad, chunks).join("\n");
  assert.match(problems, /X1: evidence not found verbatim/);
  assert.match(problems, /X1: duplicate id/);
  assert.match(problems, /X2: unanswerable questions must not have evidence/);
  assert.match(problems, /X3: keyFact/);
});

// ---------- text matching ----------

test("containsFact: whitespace-insensitive, standalone-token matching", () => {
  assert.ok(containsFact("The page size is 8KB.", "8 kb"));
  assert.ok(containsFact("It uses 1,024 pointers", "1024"));
  assert.ok(!containsFact("at most 128 processes", "12"), "must not match inside a longer number");
  assert.ok(!containsFact("two mutexes", "mutex"), "must not match inside a longer word");
  assert.ok(containsFact("uses the Clock algorithm", "clock"));
  assert.ok(!containsFact("anything", ""));
});

test("normalize unifies quotes, dashes, case and whitespace", () => {
  assert.equal(normalize("  It’s   A\nTEST—ok "), "it's a test-ok");
  assert.ok(chunkHasEvidence("foo   BAR\nbaz", "Bar baz"));
});

// ---------- retrieval metrics ----------

const chunk = (text) => ({ text });

test("scoreRetrieval: hit@k, rank, MRR, precision and recall", () => {
  const retrieved = [chunk("noise one"), chunk("contains GOLD-A here"), chunk("noise two"), chunk("and GOLD-B too"), chunk("noise three")];
  const s = scoreRetrieval(retrieved, ["gold-a", "gold-b"], [1, 3, 5]);
  assert.equal(s.firstRank, 2);
  assert.equal(s.rr, 0.5);
  assert.deepEqual([s.hit[1], s.hit[3], s.hit[5]], [false, true, true]);
  assert.deepEqual([s.recall[1], s.recall[3], s.recall[5]], [0, 0.5, 1]);
  assert.ok(Math.abs(s.precision[5] - 2 / 5) < 1e-9);
});

test("scoreRetrieval: total miss -> rr 0, nothing hit", () => {
  const s = scoreRetrieval([chunk("a"), chunk("b")], ["zzz"], [1, 3]);
  assert.equal(s.rr, 0);
  assert.equal(s.firstRank, 0);
  assert.equal(s.hit[3], false);
});

test("chanceHitRate: random baseline matches simple counting", () => {
  const chunks = Array.from({ length: 15 }, (_, i) => chunk(i === 3 ? "needle" : `hay ${i}`));
  assert.ok(Math.abs(chanceHitRate(["needle"], chunks, 5) - 5 / 15) < 1e-9);
  assert.equal(chanceHitRate(["needle"], chunks, 15), 1);
  assert.equal(chanceHitRate(["absent"], chunks, 5), 0);
});

// ---------- answer checks ----------

test("scoreKeyFacts: alternatives count once, missing facts are reported", () => {
  const r = scoreKeyFacts("It uses the second chance algorithm with 8 KB pages", [["clock", "second chance"], ["8 kb"], ["lru"]]);
  assert.equal(r.found, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.missing, ["lru"]);
  assert.equal(r.allFound, false);
  assert.equal(scoreKeyFacts("x", []).allFound, true);
});

test("extractCitations handles [1], [2, 3] and [1][4]", () => {
  assert.deepEqual(extractCitations("A [1]. B [2, 3]. C [1][4]. Not a cite [x] or (5)."), [1, 2, 3, 4]);
  assert.deepEqual(extractCitations("no cites"), []);
});

test("scoreCitations flags made-up sources and checks the cited chunk holds the evidence", () => {
  const retrieved = [chunk("irrelevant"), chunk("has the GOLD fact")];
  const s = scoreCitations("Claim [2] and another [9] and [1].", retrieved, ["gold fact"]);
  assert.deepEqual(s.invalid, [9]);
  assert.deepEqual(s.valid, [1, 2]);
  assert.equal(s.citedRelevant, 1);
  assert.equal(s.hasCitation, true);
});

// ---------- statistics ----------

test("wilson interval matches known values and handles edges", () => {
  const w = wilson(27, 30);
  assert.ok(Math.abs(w.lo - 0.744) < 0.005 && Math.abs(w.hi - 0.965) < 0.005, JSON.stringify(w));
  const all = wilson(30, 30);
  assert.equal(all.hi, 1);
  assert.ok(all.lo > 0.85 && all.lo < 0.9);
  assert.ok(Number.isNaN(wilson(0, 0).p));
});

// ---------- helpers ----------

test("rankByCosine orders by similarity, trims to topK and strips embeddings", () => {
  const chunks = [
    { chunkIndex: 0, text: "far", embedding: [-1, 0] },
    { chunkIndex: 1, text: "near", embedding: [1, 0.1] },
    { chunkIndex: 2, text: "mid", embedding: [0.2, 1] },
  ];
  const out = rankByCosine(chunks, [1, 0], 2);
  assert.deepEqual(out.map((c) => c.chunkIndex), [1, 2]);
  assert.ok(!("embedding" in out[0]));
  assert.ok(out[0].score > out[1].score);
});

test("withRetry retries 429s then succeeds, but never retries a 400", async () => {
  let calls = 0;
  const sleeps = [];
  const ok = await withRetry(
    async () => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { status: 429 });
      return "done";
    },
    { sleepFn: async (ms) => sleeps.push(ms) }
  );
  assert.equal(ok, "done");
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], "backoff grows");

  let badCalls = 0;
  await assert.rejects(
    withRetry(async () => { badCalls++; throw Object.assign(new Error("bad request"), { status: 400 }); }, { sleepFn: async () => {} })
  );
  assert.equal(badCalls, 1);
  assert.ok(isRetryable({ status: 503 }) && !isRetryable({ status: 422 }));
});

test("mapPool preserves order and respects the concurrency cap", async () => {
  let active = 0, peak = 0;
  const out = await mapPool([5, 4, 3, 2, 1], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, n));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [10, 8, 6, 4, 2]);
  assert.ok(peak <= 2);
});

test("bm25 puts the lexically matching chunk first", () => {
  const chunks = buildChunks(DOC);
  const hit = createBm25(chunks).search("How many buckets does LabHashMap start with?", 3);
  assert.ok(hit.some((c) => /starts with 32 buckets/.test(c.text)));
});

// ---------- judge ----------

test("parseJudgeJson tolerates code fences and surrounding prose", () => {
  assert.deepEqual(parseJudgeJson('```json\n{"verdict":"CORRECT"}\n```'), { verdict: "CORRECT" });
  assert.deepEqual(parseJudgeJson('Sure! {"verdict":"PARTIAL","reason":"x"} hope that helps'), { verdict: "PARTIAL", reason: "x" });
  assert.equal(parseJudgeJson("not json"), null);
  assert.equal(parseJudgeJson(undefined), null);
});

test("createJudge re-asks once on a bad verdict, then reports JUDGE_ERROR instead of guessing", async () => {
  const replies = ['{"verdict":"MAYBE"}', '{"verdict":"correct","reason":"matches"}'];
  const client = { models: { generateContent: async () => ({ text: replies.shift() }) } };
  const judge = createJudge({ client, model: "fake" });
  const good = await judge.judgeCorrectness({ question: "q", expected: "e", answer: "a" });
  assert.equal(good.verdict, "CORRECT");

  const alwaysBad = createJudge({ client: { models: { generateContent: async () => ({ text: "garbage" }) } }, model: "fake" });
  const bad = await alwaysBad.judgeGrounding({ question: "q", chunks: [], answer: "a" });
  assert.equal(bad.verdict, "JUDGE_ERROR");
});

// ---------- the whole pipeline, offline ----------

test("runEval end-to-end with stubbed generator and judge produces coherent metrics + a report", async () => {
  const bm25 = { engine: null, name: "stub-bm25", async index(c) { this.engine = createBm25(c); }, async search(q, k) { return this.engine.search(q, k); } };
  const subset = QUESTIONS.filter((q) => ["F02", "N01", "M02", "G01", "U01"].includes(q.id));
  assert.equal(subset.length, 5);

  // A "model" that answers with the expected text and cites [1]; abstains on unanswerable.
  const generate = async (question, retrieved) => {
    const q = QUESTIONS.find((x) => x.question === question);
    return q.category === "unanswerable" ? "That isn't in the provided material." : `${q.expected} [1] [99]`;
  };
  const judge = {
    model: "stub-judge",
    async judgeCorrectness() { return { verdict: "CORRECT", reason: "stub" }; },
    async judgeGrounding() { return { verdict: "FULLY_SUPPORTED", unsupported: [] }; },
  };

  const progress = [];
  const result = await runEval({ document: DOC, questions: subset, retriever: bm25, generate, judge, k: 5, concurrency: 2, onProgress: (r) => progress.push(r.id) });

  assert.equal(progress.length, 5);
  assert.equal(result.records.length, 5);
  assert.deepEqual(result.records.map((r) => r.id), subset.map((q) => q.id), "records keep question order");
  assert.equal(result.summary.counts.withEvidence, 4);
  assert.equal(result.summary.counts.errors, 0);
  assert.equal(result.summary.answers.correct.p, 1);
  assert.equal(result.summary.answers.keyFactsAll.p, 1, "expected answers contain their own keyFacts");
  assert.equal(result.summary.answers.citationValid.p, 0, "every answer cited the made-up [99]");
  assert.equal(result.summary.answers.abstained.n, 1);
  assert.ok(result.records.find((r) => r.id === "U01").retrieval === undefined);

  const text = formatReport(result);
  assert.match(text, /RETRIEVAL/);
  assert.match(text, /Hit@5/);
  assert.match(text, /cited non-existent source/);
});

test("runEval isolates a failing question instead of aborting the run", async () => {
  const flaky = { name: "flaky", async index() {}, async search(q) { if (q.includes("deep can recursion go")) throw new Error("boom"); return []; } };
  const qs = QUESTIONS.filter((q) => ["N01", "P03"].includes(q.id));
  const result = await runEval({ document: DOC, questions: qs, retriever: flaky });
  assert.equal(result.summary.counts.errors, 1);
  assert.equal(result.records.find((r) => r.id === "P03").error, "boom");
  assert.equal(result.summary.counts.withEvidence, 1);
});

test("an empty model answer is graded INCORRECT/UNSUPPORTED without calling the judge", async () => {
  let judgeCalls = 0;
  const judge = { model: "x", async judgeCorrectness() { judgeCalls++; return {}; }, async judgeGrounding() { judgeCalls++; return {}; } };
  const r = { name: "s", async index() {}, async search() { return []; } };
  const qs = QUESTIONS.filter((q) => q.id === "N01");
  const out = await runEval({ document: DOC, questions: qs, retriever: r, generate: async () => "", judge });
  assert.equal(judgeCalls, 0);
  assert.equal(out.records[0].correctness.verdict, "INCORRECT");
  assert.equal(out.records[0].grounding.verdict, "UNSUPPORTED");
});

test("summarize on zero records does not throw", () => {
  const s = summarize([], { k: 5, ks: [1, 3, 5] });
  assert.equal(s.retrieval, null);
  assert.equal(s.answers, null);
});
