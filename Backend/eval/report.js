// Turns a runEval() result into a readable plain-text report (console and README-pasteable).

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "n/a");

/** "93% [77-98]  (27/29)" — the point estimate, its 95% Wilson interval, and the raw counts. */
export function fmtRate(r) {
  if (!r || !r.n) return "n/a";
  const hits = Math.round(r.p * r.n);
  return `${pct(r.p)} [${pct(r.lo).replace("%", "")}-${pct(r.hi)}]  (${hits}/${r.n})`;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

export function formatReport({ meta, summary, records }) {
  const L = [];
  const { retrieval: ret, answers: ans } = summary;
  const k = meta.k;

  L.push(`RAG evaluation — ${meta.retriever}`);
  L.push(
    `${meta.chunkCount} chunks | top-k = ${k} | ${meta.questionCount} questions` +
      (summary.counts.errors ? ` | ${summary.counts.errors} ERRORED (excluded below)` : "")
  );
  L.push("(Intervals are 95% Wilson; with ~20 questions they are wide — quote the range, not just the point.)");
  L.push("");

  if (ret) {
    L.push(`RETRIEVAL — did the right chunk come back?  (${summary.counts.withEvidence} questions with gold evidence)`);
    for (const x of meta.ks) L.push(`  Hit@${pad(x, 2)} ${fmtRate(ret.hit[x])}   chance level: ${pct(ret.chance[x])}`);
    L.push(`  MRR     ${num(ret.mrr)}`);
    L.push(`  Recall@${k}    ${pct(ret.recall[k])}   (share of evidence spans covered; matters for multi-chunk questions)`);
    L.push(`  Precision@${k} ${pct(ret.precision[k])}   (share of the ${k} retrieved chunks that were relevant)`);
    L.push("");
  }

  if (ans) {
    L.push(`ANSWERS — ${summary.counts.generated} generated through the app's real prompt`);
    L.push(`  Key facts all present (string check)   ${fmtRate(ans.keyFactsAll)}`);
    if (ans.correct) {
      L.push(`  Correct (LLM judge)                    ${fmtRate(ans.correct)}`);
      L.push(`  Correct or partial                     ${fmtRate(ans.correctOrPartial)}`);
    }
    if (ans.grounded) L.push(`  Grounded: every claim supported        ${fmtRate(ans.grounded)}`);
    if (ans.abstained) L.push(`  Abstains when answer isn't in doc      ${fmtRate(ans.abstained)}`);
    L.push(`  Citations valid (no made-up [n])       ${fmtRate(ans.citationValid)}`);
    L.push(`  Answers that cite at least one chunk   ${fmtRate(ans.citationPresent)}`);
    L.push(`  Cited chunk holds the gold evidence    ${fmtRate(ans.citedRelevant)}`);
    L.push("");
  }

  L.push(`BY CATEGORY (Hit@${k}${ans?.correct ? " / judged correct" : ""})`);
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    const hit = c.hitK ? `${pct(c.hitK.p)} (${Math.round(c.hitK.p * c.hitK.n)}/${c.hitK.n})` : "—";
    const cor = c.correct ? `${pct(c.correct.p)} (${Math.round(c.correct.p * c.correct.n)}/${c.correct.n})` : "—";
    L.push(`  ${pad(cat, 13)} n=${pad(c.n, 3)} hit ${pad(hit, 11)}${ans?.correct ? ` correct ${cor}` : ""}`);
  }
  L.push("");

  // Failures: the part you actually use to improve the system.
  const fails = [];
  for (const r of records) {
    if (r.error) {
      fails.push(`  ${r.id}  ERROR: ${r.error}`);
      continue;
    }
    const why = [];
    if (r.retrieval && !r.retrieval.hit[k]) why.push(`retrieval missed (gold in none of top ${k})`);
    else if (r.retrieval && r.retrieval.recall[k] < 1) why.push(`partial recall (${pct(r.retrieval.recall[k])} of evidence)`);
    if (r.correctness && r.correctness.verdict !== "CORRECT") why.push(`${r.correctness.verdict}: ${r.correctness.reason}`);
    if (r.grounding && r.grounding.verdict !== "FULLY_SUPPORTED")
      why.push(`${r.grounding.verdict}${r.grounding.unsupported?.length ? `: ${r.grounding.unsupported.join("; ")}` : ""}`);
    if (r.citations?.invalid.length) why.push(`cited non-existent source(s) [${r.citations.invalid.join(", ")}]`);
    if (why.length) fails.push(`  ${r.id} (${r.category}) ${r.question}\n      -> ${why.join("\n      -> ")}`);
  }
  L.push(fails.length ? `ISSUES (${fails.length})\n${fails.join("\n")}` : "ISSUES: none");

  return L.join("\n");
}
