// A tiny BM25 lexical retriever. It exists as a *baseline*: if the embedding retriever can't
// beat plain keyword matching on this question set, the embeddings aren't earning their cost.
// Runs fully offline (no API key), so it also lets you validate the harness for free.
import { normalize } from "./metrics.js";

const STOPWORDS = new Set(
  ("a an and are as at be by does do for from has have how in is it its of on or that the their this to " +
    "was were what when which who why will with can could would should about into than then there these those").split(" ")
);

export const tokenize = (text) => (normalize(text).match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w));

/**
 * @param {{chunkIndex: number, text: string}[]} chunks
 * @returns {{search: (query: string, topK: number) => {chunkIndex: number, text: string, score: number}[]}}
 */
export function createBm25(chunks, { k1 = 1.5, b = 0.75 } = {}) {
  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / (N || 1);

  const df = new Map();
  for (const d of docs) for (const term of new Set(d)) df.set(term, (df.get(term) || 0) + 1);
  const idf = (term) => Math.log(1 + (N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));

  const tfs = docs.map((d) => {
    const m = new Map();
    for (const t of d) m.set(t, (m.get(t) || 0) + 1);
    return m;
  });

  return {
    search(query, topK) {
      const terms = [...new Set(tokenize(query))];
      return chunks
        .map((c, i) => {
          let score = 0;
          for (const t of terms) {
            const tf = tfs[i].get(t) || 0;
            if (!tf) continue;
            score += idf(t) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docs[i].length) / avgLen)));
          }
          return { chunkIndex: c.chunkIndex, text: c.text, score };
        })
        .sort((a, b2) => b2.score - a.score || a.chunkIndex - b2.chunkIndex)
        .slice(0, topK);
    },
  };
}
