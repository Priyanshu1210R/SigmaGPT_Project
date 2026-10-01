# RAG evaluation

A repeatable test of the document Q&A pipeline: **20 question / expected-answer pairs** against a fixed test
document, scored for **retrieval** (did the right chunk come back?) and **answer grounding** (is the answer correct,
and is every claim backed by the retrieved text?).

It exists so you can say *"Hit@5 was X% (95% CI a–b) on a 20-question set, vs Y% for a keyword baseline"* instead of
"it seems to work".

## Run it

From `Backend/` (needs `GEMINI_API_KEY` in `.env`, same as the app):

```bash
npm run eval              # full run: retrieval + answers + LLM-judged correctness & grounding
npm run eval:retrieval    # retrieval only — embeddings + search, no generation or judge calls (cheapest)
npm run eval:baseline     # offline BM25 keyword baseline — no API key, free, deterministic
npm test                  # includes offline tests of the harness itself (no API key needed)
```

A full run makes roughly 20 answer calls + 40 judge calls + ~34 embedding calls (14 chunks + 20 questions). Results are printed and saved to
`eval/results/<timestamp>-<retriever>.json` (git-ignored) with every retrieved chunk, answer, and judge reason, so any
score can be audited.

Useful flags: `--k 3` (chunks retrieved; the app uses 5), `--only F02,N01` or `--limit 5` (quick smoke test),
`--no-judge` (skip LLM grading), `--chunk-chars 600` (re-test with a different chunk size),
`--min-hit 0.8 --min-grounded 0.8` (exit code 1 if below — usable as a CI gate).

## What it exercises

| Stage | What runs | Same code as the app? |
|---|---|---|
| Chunking | `utils/chunker.js` with default settings | yes |
| Embedding | `embedChunks` / `embedQuery` (`gemini-embedding-001`, 768-d) | yes |
| Ranking | `rankByCosine` in `utils/retrieval.js` (the local-fallback ranking) | yes |
| Answering | `streamGeminiResponse` with the real system prompt and numbered "Retrieved context" block | yes |
| Grading | a separate Gemini call acting as judge | eval only |

## The data

- `test-document.md` — the **CS-210 Java Lab Handbook**, a course handbook covering core Java (JVM memory, strings,
  OOP, exceptions, generics, concurrency, Java 17 features) and DSA in Java (lists, hash maps, linked lists, heaps,
  trees, graphs, sorting/searching, recursion, DP, complexity). ~10k characters → 14 chunks.
  It is a *fictional course* on purpose: it mixes true Java facts with **house rules and values the model can't know**
  (`LabHashMap` starts with 32 buckets and resizes at load factor 0.6, `-Xss512k`, a 4-thread pool, merge sort
  cut-off of 16). Real Java facts alone (e.g. HashMap's default of 16 buckets) could be answered from Gemini's memory
  and would not prove retrieval worked; the course-specific values do.
  A "Version History" section holds *old* conflicting values (v2.4: 1.5x growth, 16 buckets, `-Xss1m`, 8 threads) as a
  realistic retrieval trap.
- `questions.json` — 20 questions in 7 categories:

| Category | n | Tests |
|---|---|---|
| factual | 3 | direct lookups (custom exception, PriorityQueue, Bellman-Ford) |
| numeric | 4 | exact figures (stack flag, bucket count/load factor, merge-sort cut-off, pool size) |
| paraphrase | 5 | question shares few words with the source sentence (where embeddings should beat keywords) |
| distractor | 2 | answer is a current value, with an old conflicting value in the version-history section (or vice versa) |
| multi-chunk | 2 | needs evidence from two distant sections |
| negative | 1 | "Can students use X?" where the answer is *no* |
| unanswerable | 3 | not in the document — the model should say so, not invent an answer |

Each answerable question's gold label is a **verbatim evidence span**, not a chunk number, so labels stay valid if you
change the chunk size. A chunk counts as relevant if it contains the span. `npm test` verifies every span exists in the
document *and* sits wholly inside at least one chunk, so no question is silently impossible.

## The metrics

**Retrieval** (the 17 questions that have evidence):

- **Hit@k** — a relevant chunk appears in the top k. This is "did it fetch the right chunk". Reported at k = 1, 3, 5.
- **MRR** — mean reciprocal rank of the first relevant chunk (1.0 = always first).
- **Recall@k** — share of a question's evidence spans covered by the top k (matters for multi-chunk questions).
- **Precision@k** — share of the k retrieved chunks that are relevant. It is naturally low here because only one or
  two chunks contain the answer; use Hit@k and MRR as the headline.
- **Chance level** — the Hit@k a random retriever would get. If you aren't well above it, nothing is working.

**Answers** (all 20):

- **Key facts present** — deterministic string check for required facts (e.g. "8 KB"). Brittle to rephrasing, so it
  is a cheap sanity signal, not the headline.
- **Correct (LLM judge)** — the judge compares the answer to the reference: CORRECT / PARTIAL / INCORRECT.
- **Grounded** — the judge sees *only the retrieved excerpts* and checks every factual claim is supported:
  FULLY_SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED. This is the hallucination measure. Because the document is
  fictional, a wrong-chunk retrieval shows up here as unsupported claims.
- **Abstains when answer isn't in doc** — correct behavior on the 3 unanswerable questions.
- **Citation checks** — deterministic: no made-up `[n]`, answer cites at least one chunk, and the cited chunk really
  holds the gold evidence.

Every rate is printed with a **95% Wilson interval** and raw counts. With 20 questions the interval is wide (18/20 is
"90%, plausibly 70–97%"). Quote the interval, and don't over-read a 1–2 point change between runs.

## Baseline (offline, reproducible)

Plain BM25 keyword search over the same chunks, k = 5 (`npm run eval:baseline`):

| | Hit@1 | Hit@3 | Hit@5 | MRR |
|---|---|---|---|---|
| Random chance | 9% | 26% | 41% | — |
| **BM25 keyword baseline** | 65% [41–83] | 88% [66–97] | 94% [73–99] | 0.77 |
| **Gemini embeddings (yours — run `npm run eval`)** | | | | |

Its one miss at k = 5 is a paraphrase question. Embeddings should beat this; if they don't, that is worth knowing.
(The paraphrase questions were deliberately reworded to avoid the document's vocabulary — a first draft scored 100%
for BM25, which proves nothing.)

## Quoting a result honestly

A defensible sentence: *"On a 20-question internal eval over a single 14-chunk document, retrieval Hit@5 was X%
(95% CI a–b) versus 94% for a BM25 baseline, and Y% of answers were fully grounded in the retrieved text."*

Know the limits before someone else points them out:

- **Small, single, synthetic document.** It shows the pipeline works and catches regressions; it does not predict
  accuracy on messy real PDFs. Add a real document of your own to the set for a stronger claim.
- **LLM judge bias.** By default the judge is the same model that wrote the answers, which tends to be lenient. Set
  `EVAL_JUDGE_MODEL` to a different/stronger model, and read a handful of judge reasons in the results JSON.
- **Not tested here:** MongoDB Atlas `$vectorSearch` (approximate search) and per-user thread scoping. The eval ranks
  in memory with the same cosine code as the local fallback, so it measures chunking + embeddings + prompt, not the
  index.
- **Nondeterminism.** Generation and judging vary slightly run to run. Compare against the interval, not a point.

## Adding questions

Add an object to `questions.json` with `id`, `category`, `question`, `expected`, an `evidence` span copied *verbatim*
from `test-document.md` (omit for `unanswerable`), and optional `keyFacts` (strings or arrays of accepted
alternatives, each of which must appear in `expected`). Run `npm test` — the dataset check will tell you if the span
is missing or straddles a chunk boundary.
