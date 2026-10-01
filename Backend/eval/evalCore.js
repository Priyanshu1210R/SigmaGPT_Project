// Orchestrates one evaluation run. Everything that touches the network (retriever, generator,
// judge) is injected, so the whole pipeline can be exercised offline with stubs
// (tests/eval.test.js) and the CLI (run.js) just wires in the real Gemini-backed versions.
import { chunkText } from "../utils/chunker.js";
import {
  chunkHasEvidence,
  chanceHitRate,
  scoreRetrieval,
  scoreKeyFacts,
  scoreCitations,
  containsFact,
  summarize,
} from "./metrics.js";
import { mapPool } from "./util.js";

/** Chunk the test document exactly the way the app does (same chunker, same defaults). */
export const buildChunks = (document, chunkOpts) =>
  chunkText(document, chunkOpts).map((text, chunkIndex) => ({ chunkIndex, text }));

/**
 * Sanity-check the dataset BEFORE spending API calls. Returns a list of problems (empty = good).
 * The important one: every evidence span must sit wholly inside at least one chunk, otherwise
 * the question is impossible for retrieval and would silently drag the score down.
 */
export function validateDataset(document, questions, chunks) {
  const problems = [];
  const seen = new Set();
  for (const q of questions) {
    const tag = q.id || "(no id)";
    if (!q.id) problems.push("A question is missing an id.");
    else if (seen.has(q.id)) problems.push(`${tag}: duplicate id.`);
    seen.add(q.id);
    if (!q.question) problems.push(`${tag}: missing question text.`);
    if (!q.expected) problems.push(`${tag}: missing expected answer.`);
    if (!q.category) problems.push(`${tag}: missing category.`);

    if (q.category === "unanswerable" && q.evidence?.length)
      problems.push(`${tag}: unanswerable questions must not have evidence.`);
    if (q.category !== "unanswerable" && !q.evidence?.length)
      problems.push(`${tag}: answerable question has no evidence spans.`);

    for (const e of q.evidence || []) {
      if (!chunkHasEvidence(document, e)) problems.push(`${tag}: evidence not found verbatim in the document: "${e}"`);
      else if (!chunks.some((c) => chunkHasEvidence(c.text, e)))
        problems.push(`${tag}: evidence is split across chunk boundaries (unreachable): "${e}"`);
    }

    // Every keyFact should appear in the reference answer, which catches typos in either.
    for (const fact of q.keyFacts || []) {
      const alts = Array.isArray(fact) ? fact : [fact];
      if (!alts.some((a) => containsFact(q.expected || "", a)))
        problems.push(`${tag}: keyFact [${alts.join(" | ")}] does not appear in the expected answer.`);
    }
  }
  return problems;
}

/**
 * @param {object} o
 * @param {string} o.document
 * @param {object[]} o.questions
 * @param {{chunkChars?: number, overlapChars?: number}} [o.chunkOpts]
 * @param {number} [o.k]                         how many chunks to retrieve (the app uses 5)
 * @param {{name: string, index: Function, search: Function}} o.retriever
 * @param {((question: string, retrieved: object[]) => Promise<string>) | null} [o.generate]  null = retrieval-only
 * @param {{judgeCorrectness: Function, judgeGrounding: Function} | null} [o.judge]
 * @param {number} [o.concurrency]
 * @param {(rec: object, done: number, total: number) => void} [o.onProgress]
 */
export async function runEval({
  document,
  questions,
  chunkOpts,
  k = 5,
  retriever,
  generate = null,
  judge = null,
  concurrency = 2,
  onProgress = () => {},
}) {
  const chunks = buildChunks(document, chunkOpts);
  const ks = [...new Set([1, 3, k].filter((x) => x <= k))].sort((a, b) => a - b);
  const startedAt = new Date();

  await retriever.index(chunks);

  let done = 0;
  const records = await mapPool(questions, concurrency, async (q) => {
    const rec = { id: q.id, category: q.category, question: q.question, expected: q.expected, evidence: q.evidence || [] };
    try {
      const retrieved = await retriever.search(q.question, k);

      if (q.evidence?.length) {
        rec.retrieval = scoreRetrieval(retrieved, q.evidence, ks);
        rec.chance = Object.fromEntries(ks.map((x) => [x, chanceHitRate(q.evidence, chunks, x)]));
      }
      rec.retrieved = retrieved.map((c, i) => ({
        rank: i + 1,
        chunkIndex: c.chunkIndex,
        score: Number.isFinite(c.score) ? Number(c.score.toFixed(4)) : null,
        relevant: rec.retrieval ? rec.retrieval.relevantFlags[i] : null,
      }));

      if (generate) {
        rec.answer = (await generate(q.question, retrieved)) ?? "";
        rec.keyFacts = q.keyFacts?.length ? scoreKeyFacts(rec.answer, q.keyFacts) : null;
        rec.citations = scoreCitations(rec.answer, retrieved, q.evidence || []);

        if (judge) {
          if (!rec.answer.trim()) {
            // Nothing to grade: an empty answer is wrong by definition, no API call needed.
            rec.correctness = { verdict: "INCORRECT", reason: "Empty answer." };
            rec.grounding = { verdict: "UNSUPPORTED", unsupported: [], reason: "Empty answer." };
          } else {
            rec.correctness = await judge
              .judgeCorrectness({ question: q.question, expected: q.expected, answer: rec.answer })
              .catch((err) => ({ verdict: "JUDGE_ERROR", reason: err.message }));
            rec.grounding = await judge
              .judgeGrounding({ question: q.question, chunks: retrieved, answer: rec.answer })
              .catch((err) => ({ verdict: "JUDGE_ERROR", unsupported: [], reason: err.message }));
          }
        }
      }
    } catch (err) {
      rec.error = err?.message || String(err);
    }
    onProgress(rec, ++done, questions.length);
    return rec;
  });

  return {
    meta: {
      startedAt: startedAt.toISOString(),
      retriever: retriever.name,
      k,
      ks,
      chunkOpts: chunkOpts || "defaults",
      chunkCount: chunks.length,
      questionCount: questions.length,
      generated: Boolean(generate),
      judged: Boolean(judge),
      judgeModel: judge?.model ?? null,
    },
    summary: summarize(records, { k, ks }),
    records,
  };
}
