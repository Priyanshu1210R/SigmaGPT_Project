// RAG quality evaluation — CLI.
//
//   npm run eval                      full run: retrieval + answers + LLM-judged grounding
//   npm run eval:retrieval            retrieval only (embeddings + search; no generation or judge calls)
//   npm run eval:baseline             offline BM25 keyword baseline (no API key needed)
//
// See eval/README.md for what each number means and how to quote it.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildChunks, runEval, validateDataset } from "./evalCore.js";
import { createBm25 } from "./bm25.js";
import { formatReport } from "./report.js";
import { withRetry } from "./util.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.join(HERE, "test-document.md");
const QUESTIONS_PATH = path.join(HERE, "questions.json");
const RESULTS_DIR = path.join(HERE, "results");
const DOC_NAME = "test-document.md";

const { values: args } = parseArgs({
  options: {
    retriever: { type: "string", default: "embedding" }, // embedding | bm25
    k: { type: "string", default: "5" }, // the chat route retrieves 5 (RAG_TOP_K)
    "retrieval-only": { type: "boolean", default: false },
    "no-judge": { type: "boolean", default: false },
    only: { type: "string" }, // comma-separated question ids
    limit: { type: "string" },
    concurrency: { type: "string", default: "2" },
    "chunk-chars": { type: "string" },
    "overlap-chars": { type: "string" },
    "min-hit": { type: "string" }, // fail (exit 1) if Hit@k is below this, e.g. 0.8
    "min-grounded": { type: "string" }, // fail if grounded rate is below this
    "no-save": { type: "boolean", default: false },
  },
});

const fail = (msg, code = 2) => {
  console.error(`\n❌ ${msg}`);
  process.exit(code);
};

const k = Number(args.k);
if (!Number.isInteger(k) || k < 1) fail("--k must be a positive integer.");
if (!["embedding", "bm25"].includes(args.retriever)) fail('--retriever must be "embedding" or "bm25".');

const needsGemini = args.retriever === "embedding" || !args["retrieval-only"];
if (needsGemini && !process.env.GEMINI_API_KEY)
  fail(
    "GEMINI_API_KEY is not set (check Backend/.env).\n" +
      "   Tip: `npm run eval:baseline -- --retrieval-only` runs the offline BM25 baseline without a key."
  );

const document = fs.readFileSync(DOC_PATH, "utf8");
let questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf8")).questions;
if (args.only) {
  const ids = new Set(args.only.split(",").map((s) => s.trim()));
  questions = questions.filter((q) => ids.has(q.id));
}
if (args.limit) questions = questions.slice(0, Number(args.limit));
if (!questions.length) fail("No questions selected.");

const chunkOpts = {};
if (args["chunk-chars"]) chunkOpts.chunkChars = Number(args["chunk-chars"]);
if (args["overlap-chars"]) chunkOpts.overlapChars = Number(args["overlap-chars"]);

// Fail fast on a broken dataset before spending any API calls.
const problems = validateDataset(document, questions, buildChunks(document, chunkOpts));
if (problems.length) fail(`Dataset problems:\n   - ${problems.join("\n   - ")}`);

// ---------- retriever ----------
async function makeRetriever() {
  if (args.retriever === "bm25") {
    let engine;
    return {
      name: "BM25 keyword baseline (offline)",
      async index(chunks) {
        engine = createBm25(chunks);
      },
      async search(query, topK) {
        return engine.search(query, topK);
      },
    };
  }

  // The app's own embedding + ranking code: embedChunks/embedQuery from utils/embeddings.js
  // and rankByCosine from utils/retrieval.js (the same function the local fallback uses).
  const { embedChunks, embedQuery, EMBEDDING_DIMENSIONS } = await import("../utils/embeddings.js");
  const { rankByCosine } = await import("../utils/retrieval.js");
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
  let indexed = [];
  return {
    name: `${model} (${EMBEDDING_DIMENSIONS}d) + cosine`,
    async index(chunks) {
      const vectors = await withRetry(() => embedChunks(chunks.map((c) => c.text)));
      indexed = chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
    },
    async search(query, topK) {
      const vector = await withRetry(() => embedQuery(query));
      return rankByCosine(indexed, vector, topK);
    },
  };
}

// ---------- generator: the app's real prompt path ----------
async function makeGenerator() {
  const { streamGeminiResponse } = await import("../utils/gemini.js");
  return (question, retrieved) =>
    withRetry(async () => {
      // Same shape chat.js hands to streamGeminiResponse, so the system instruction and the
      // numbered "Retrieved context" block are exactly what a real user turn would get.
      const chunks = retrieved.map((c) => ({ documentId: "eval-doc", fileName: DOC_NAME, chunkIndex: c.chunkIndex, text: c.text }));
      let out = "";
      for await (const token of streamGeminiResponse(question, null, [], undefined, chunks)) out += token;
      return out;
    });
}

// ---------- run ----------
const retriever = await makeRetriever();
const generate = args["retrieval-only"] ? null : await makeGenerator();
let judge = null;
if (generate && !args["no-judge"]) {
  const { createJudge } = await import("./judge.js");
  judge = createJudge();
}

const calls = args["retrieval-only"]
  ? "retrieval only"
  : `${questions.length} answers${judge ? ` + ${questions.length * 2} judge calls (${judge.model})` : ""}`;
console.log(`Running ${questions.length} questions | retriever: ${args.retriever} | k=${k} | ${calls}\n`);

let result;
try {
  result = await runEval({
    document,
    questions,
    chunkOpts: Object.keys(chunkOpts).length ? chunkOpts : undefined,
    k,
    retriever,
    generate,
    judge,
    concurrency: Number(args.concurrency) || 2,
    onProgress: (rec, done, total) => {
      const flag = rec.error ? "ERR " : rec.retrieval ? (rec.retrieval.hit[k] ? "hit " : "MISS") : "    ";
      console.log(`  [${String(done).padStart(2)}/${total}] ${rec.id} ${flag} ${rec.error ? rec.error : ""}`);
    },
  });
} catch (err) {
  // Only setup failures land here (e.g. embedding the document chunks): per-question errors are
  // captured on their own record. Usually a bad/missing key, quota, or no network.
  fail(
    `Evaluation could not start: ${err?.message || err}\n` +
      "   Check GEMINI_API_KEY, your network, and Gemini quota. (`--retriever bm25 --retrieval-only` works offline.)"
  );
}

console.log(`\n${formatReport(result)}\n`);

if (!args["no-save"]) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = result.meta.startedAt.replace(/[:.]/g, "-");
  const file = path.join(RESULTS_DIR, `${stamp}-${args.retriever}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`Saved full per-question results → ${path.relative(process.cwd(), file)}`);
}

// Optional quality gates, so this can run in CI and fail a PR that regresses RAG quality.
let exitCode = 0;
const { retrieval, answers } = result.summary;
if (args["min-hit"] && retrieval && retrieval.hit[k].p < Number(args["min-hit"])) {
  console.error(`❌ Hit@${k} ${retrieval.hit[k].p.toFixed(2)} is below --min-hit ${args["min-hit"]}`);
  exitCode = 1;
}
if (args["min-grounded"] && answers?.grounded && answers.grounded.p < Number(args["min-grounded"])) {
  console.error(`❌ Grounded rate ${answers.grounded.p.toFixed(2)} is below --min-grounded ${args["min-grounded"]}`);
  exitCode = 1;
}
if (result.summary.counts.errors) exitCode ||= 1;
process.exit(exitCode);
