import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { GeminiError } from "./gemini.js";

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
// gemini-embedding-001 defaults to 3072-dim vectors; 768 keeps storage/index cost down
// while staying well within Matryoshka-truncation's accuracy-preserving range.
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 768;

// Gemini's embedContent batches multiple strings in one call; keep batches modest
// so one call can't time out or blow past request-size limits on a big document.
const BATCH_SIZE = 32;

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

const chunkArray = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function embedBatch(texts, taskType) {
  try {
    const response = await getClient().models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: { taskType, outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    return response.embeddings.map((e) => e.values);
  } catch (err) {
    console.error("Embedding error:", err?.message || err);
    const status = err?.status === 429 ? 429 : 502;
    throw new GeminiError(
      status === 429 ? "The embedding service is busy. Try again shortly." : "Failed to generate embeddings.",
      status
    );
  }
}

/**
 * Embed multiple document chunks (indexing time).
 * @param {string[]} texts
 * @param {{ onProgress?: (done: number, total: number) => (void|Promise<void>) }} [opts]
 *   onProgress fires after each batch — the background worker uses it to report
 *   progress and to renew its job lease while a big document is still embedding.
 * @returns {Promise<number[][]>} one embedding vector per input text, same order
 */
export async function embedChunks(texts, { onProgress } = {}) {
  const batches = chunkArray(texts, BATCH_SIZE);
  const results = [];
  for (const batch of batches) {
    results.push(...(await embedBatch(batch, "RETRIEVAL_DOCUMENT")));
    if (onProgress) await onProgress(results.length, texts.length);
  }
  return results;
}

/**
 * Embed a single user query (retrieval time). Gemini's embedding model uses a
 * different task type for queries vs. documents, which measurably improves
 * retrieval quality over embedding both the same way.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedQuery(text) {
  const [vector] = await embedBatch([text], "RETRIEVAL_QUERY");
  return vector;
}
