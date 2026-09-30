import mongoose from "mongoose";
import DocumentChunk from "../models/DocumentChunk.js";

// Name of the Atlas Vector Search index (create it once — see scripts/createVectorIndex.js).
export const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME || "chunk_vector_index";

/** Cosine similarity between two equal-length vectors, in [-1, 1]. */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return -Infinity;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return -Infinity;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Local, in-process fallback for when Atlas Vector Search isn't available
 * (e.g. local MongoDB in dev, or the index hasn't been created yet). Pulls every
 * chunk for the thread and ranks it in JS. Fine up to a few thousand chunks;
 * not what you'd run at scale — that's exactly what $vectorSearch is for.
 */
async function localCosineSearch({ threadId, userId, queryEmbedding, topK }) {
  const chunks = await DocumentChunk.find(
    { threadId, userId },
    "documentId fileName chunkIndex text embedding"
  ).lean();

  return chunks
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ embedding, ...rest }) => rest);
}

/**
 * Top-K most relevant chunks for a query, scoped to one thread and one user
 * (so a user can never retrieve another user's or another thread's documents).
 *
 * Tries MongoDB Atlas Vector Search first ($vectorSearch requires an Atlas cluster
 * with the named index — see scripts/createVectorIndex.js); if that's unavailable
 * (local dev, index not yet built, wrong tier) it transparently falls back to
 * `localCosineSearch` so the feature still works, just without the index speedup.
 */
export async function retrieveRelevantChunks({ threadId, userId, queryEmbedding, topK = 5 }) {
  if (!queryEmbedding?.length) return [];

  try {
    const results = await DocumentChunk.aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: Math.max(100, topK * 20),
          limit: topK,
          filter: {
            threadId: { $eq: threadId },
            userId: { $eq: new mongoose.Types.ObjectId(userId) },
          },
        },
      },
      {
        $project: {
          _id: 0,
          documentId: 1,
          fileName: 1,
          chunkIndex: 1,
          text: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ]);
    return results;
  } catch (err) {
    // $vectorSearch fails outright (not Atlas / no index yet) rather than returning
    // zero rows, so this catch is the expected dev-mode path, not a bug being hidden.
    console.warn("[retrieval] $vectorSearch unavailable, using local fallback:", err.codeName || err.message);
    return localCosineSearch({ threadId, userId, queryEmbedding, topK });
  }
}
