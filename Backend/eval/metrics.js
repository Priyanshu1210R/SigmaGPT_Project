// Pure scoring functions for the RAG evaluation. No I/O and no API calls in this file,
// so everything here is unit-tested offline (tests/eval.test.js).

// ---------- text matching ----------

/** Lowercase, unify quotes/dashes, drop thousands separators, collapse whitespace. */
export function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` contain `fact` as a standalone token sequence? Spaces in the fact match any
 * amount of whitespace ("8 kb" matches "8KB"), and the match can't sit inside a longer
 * word or number (so "12" does NOT match inside "128").
 */
export function containsFact(text, fact) {
  const f = normalize(fact);
  if (!f) return false;
  const pattern = escapeRegExp(f).replace(/ /g, "\\s*");
  return new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`).test(normalize(text));
}

/** Is the gold evidence span present (whitespace/case-insensitively) in this chunk text? */
export const chunkHasEvidence = (chunkText, evidence) => normalize(chunkText).includes(normalize(evidence));

// ---------- retrieval metrics ----------

/**
 * Score one query's ranked results against its gold evidence spans.
 *
 * A retrieved chunk is "relevant" if it contains at least one evidence span verbatim.
 *   hit@k       — at least one relevant chunk in the top k ("did it fetch the right chunk")
 *   recall@k    — fraction of evidence spans covered by the top k (matters for multi-chunk questions)
 *   precision@k — fraction of the top k that are relevant
 *   rr          — reciprocal rank of the first relevant chunk (0 if none in the list)
 *
 * @param {{text: string}[]} retrieved  ranked best-first
 * @param {string[]} evidence
 * @param {number[]} ks
 */
export function scoreRetrieval(retrieved, evidence, ks = [1, 3, 5]) {
  const relevantFlags = retrieved.map((c) => evidence.some((e) => chunkHasEvidence(c.text, e)));
  const firstRank = relevantFlags.indexOf(true) + 1; // 0 if none
  const out = { relevantFlags, firstRank, rr: firstRank ? 1 / firstRank : 0, hit: {}, recall: {}, precision: {} };

  for (const k of ks) {
    const top = retrieved.slice(0, k);
    out.hit[k] = relevantFlags.slice(0, k).some(Boolean);
    const covered = evidence.filter((e) => top.some((c) => chunkHasEvidence(c.text, e))).length;
    out.recall[k] = evidence.length ? covered / evidence.length : 0;
    out.precision[k] = top.length ? relevantFlags.slice(0, k).filter(Boolean).length / k : 0;
  }
  return out;
}

/** Expected hit@k if the retriever just picked k chunks at random (the floor to beat). */
export function chanceHitRate(evidence, chunks, k) {
  const relevant = chunks.filter((c) => evidence.some((e) => chunkHasEvidence(c.text, e))).length;
  const n = chunks.length;
  if (!n || !relevant) return 0;
  if (k >= n) return 1;
  // P(at least one relevant in k draws without replacement)
  let pNone = 1;
  for (let i = 0; i < k; i++) pNone *= Math.max(0, (n - relevant - i) / (n - i));
  return 1 - pNone;
}

// ---------- answer checks (deterministic) ----------

/**
 * keyFacts: array of required facts; each is a string or an array of accepted alternatives.
 * Returns how many are present in the answer.
 */
export function scoreKeyFacts(answer, keyFacts = []) {
  const missing = [];
  let found = 0;
  for (const fact of keyFacts) {
    const alts = Array.isArray(fact) ? fact : [fact];
    if (alts.some((a) => containsFact(answer, a))) found++;
    else missing.push(alts[0]);
  }
  return { found, total: keyFacts.length, missing, allFound: found === keyFacts.length };
}

/** Pull citation numbers out of "[1]", "[2, 3]", "[1][4]" style markers. */
export function extractCitations(answer = "") {
  const nums = new Set();
  for (const m of String(answer).matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) {
    for (const n of m[1].split(/[,;]/)) nums.add(Number(n.trim()));
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Check the model's inline [n] citations against what it was actually given.
 *   invalid       — cites [n] where n is outside 1..retrieved.length (made-up source)
 *   citedRelevant — of the valid citations, how many point at a chunk containing gold evidence
 */
export function scoreCitations(answer, retrieved, evidence = []) {
  const cited = extractCitations(answer);
  const valid = cited.filter((n) => n >= 1 && n <= retrieved.length);
  const invalid = cited.filter((n) => !(n >= 1 && n <= retrieved.length));
  const citedRelevant = valid.filter((n) => evidence.some((e) => chunkHasEvidence(retrieved[n - 1].text, e))).length;
  return { cited, valid, invalid, citedRelevant, hasCitation: valid.length > 0 };
}

// ---------- statistics ----------

/**
 * Wilson score interval for a proportion. With ~20 questions a bare "93%" hides a lot of
 * uncertainty; this gives the honest range (default 95%).
 */
export function wilson(successes, n, z = 1.96) {
  if (!n) return { p: NaN, lo: NaN, hi: NaN, n: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), n };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** A proportion over a list of booleans, with its Wilson interval. */
const rate = (flags) => wilson(flags.filter(Boolean).length, flags.length);

// ---------- aggregation ----------

/**
 * Roll per-question records up into the headline numbers.
 * Records come from evalCore.runEval(); retrieval metrics only count questions that have gold
 * evidence, answer metrics only count questions that were actually generated/judged.
 */
export function summarize(records, { k = 5, ks = [1, 3, 5] } = {}) {
  const ok = records.filter((r) => !r.error);
  const withEvidence = ok.filter((r) => r.retrieval);
  const generated = ok.filter((r) => r.answer != null);
  const answerable = generated.filter((r) => r.category !== "unanswerable");
  const unanswerable = generated.filter((r) => r.category === "unanswerable");
  const judged = generated.filter((r) => r.correctness && r.correctness.verdict !== "JUDGE_ERROR");
  const grounded = generated.filter((r) => r.grounding && r.grounding.verdict !== "JUDGE_ERROR");

  const summary = {
    counts: { total: records.length, errors: records.length - ok.length, withEvidence: withEvidence.length, generated: generated.length },
    retrieval: null,
    answers: null,
  };

  if (withEvidence.length) {
    summary.retrieval = {
      hit: Object.fromEntries(ks.map((x) => [x, rate(withEvidence.map((r) => r.retrieval.hit[x]))])),
      recall: Object.fromEntries(ks.map((x) => [x, mean(withEvidence.map((r) => r.retrieval.recall[x]))])),
      precision: Object.fromEntries(ks.map((x) => [x, mean(withEvidence.map((r) => r.retrieval.precision[x]))])),
      mrr: mean(withEvidence.map((r) => r.retrieval.rr)),
      chance: Object.fromEntries(ks.map((x) => [x, mean(withEvidence.map((r) => r.chance[x]))])),
    };
  }

  if (generated.length) {
    summary.answers = {
      keyFactsAll: rate(answerable.filter((r) => r.keyFacts && r.keyFacts.total > 0).map((r) => r.keyFacts.allFound)),
      correct: judged.length ? rate(judged.map((r) => r.correctness.verdict === "CORRECT")) : null,
      correctOrPartial: judged.length ? rate(judged.map((r) => r.correctness.verdict !== "INCORRECT")) : null,
      grounded: grounded.length ? rate(grounded.map((r) => r.grounding.verdict === "FULLY_SUPPORTED")) : null,
      abstained: judged.filter((r) => r.category === "unanswerable").length
        ? rate(judged.filter((r) => r.category === "unanswerable").map((r) => r.correctness.verdict === "CORRECT"))
        : null,
      unanswerableCount: unanswerable.length,
      citationValid: rate(answerable.filter((r) => r.citations).map((r) => r.citations.invalid.length === 0)),
      citationPresent: rate(answerable.filter((r) => r.citations).map((r) => r.citations.hasCitation)),
      citedRelevant: rate(
        answerable.filter((r) => r.citations && r.citations.valid.length).map((r) => r.citations.citedRelevant > 0)
      ),
    };
  }

  // Per-category breakdown (hit@k + judged-correct), so a weak spot isn't averaged away.
  const cats = [...new Set(records.map((r) => r.category))];
  summary.byCategory = Object.fromEntries(
    cats.map((cat) => {
      const rs = ok.filter((r) => r.category === cat);
      const ev = rs.filter((r) => r.retrieval);
      const jd = rs.filter((r) => r.correctness && r.correctness.verdict !== "JUDGE_ERROR");
      return [
        cat,
        {
          n: rs.length,
          hitK: ev.length ? rate(ev.map((r) => r.retrieval.hit[k])) : null,
          correct: jd.length ? rate(jd.map((r) => r.correctness.verdict === "CORRECT")) : null,
        },
      ];
    })
  );

  return summary;
}
