// One-time setup script: creates the Atlas Vector Search index that
// utils/retrieval.js's $vectorSearch query needs.
//
// This can't be done through Mongoose — Atlas Search indexes are a separate
// thing from normal MongoDB indexes and are created via the driver's
// createSearchIndex() (or the Atlas UI / Admin API).
//
// Requirements: an Atlas cluster (M10+, or a Serverless/Flex instance — Vector
// Search is not available on the free shared M0 tier). Local `mongod` and
// non-Atlas MongoDB cannot run $vectorSearch at all; utils/retrieval.js falls
// back to an in-process cosine-similarity scan in that case, so the feature
// still works locally, just without this index.
//
// Usage:  node scripts/createVectorIndex.js
import "dotenv/config";
import { MongoClient } from "mongodb";
import { EMBEDDING_DIMENSIONS } from "../utils/embeddings.js";

const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME || "chunk_vector_index";

async function main() {
  if (!process.env.MONGODB_URL) {
    console.error("❌ MONGODB_URL is not set (check your .env)");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URL);
  await client.connect();

  try {
    const db = client.db();
    const collection = db.collection("documentchunks"); // Mongoose's default pluralized name for DocumentChunk

    const existing = await collection.listSearchIndexes(VECTOR_INDEX_NAME).toArray().catch(() => []);
    if (existing.length) {
      console.log(`✅ Index "${VECTOR_INDEX_NAME}" already exists on ${db.databaseName}.documentchunks — nothing to do.`);
      return;
    }

    console.log(`Creating vector index "${VECTOR_INDEX_NAME}" (dimensions=${EMBEDDING_DIMENSIONS}, similarity=cosine)...`);
    await collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
          // Filter fields let $vectorSearch's `filter` narrow to one thread/user without a post-filter scan.
          { type: "filter", path: "threadId" },
          { type: "filter", path: "userId" },
        ],
      },
    });

    console.log("✅ Index creation started. It can take a minute or two to finish building on Atlas.");
    console.log('   Check status in Atlas: Collections -> documentchunks -> "Search Indexes" tab.');
  } catch (err) {
    if (err?.codeName === "AtlasError" || /not supported|not enabled|only supported on Atlas/i.test(err?.message || "")) {
      console.error(
        "❌ This cluster doesn't support Atlas Search indexes.\n" +
          "   Vector Search needs an Atlas cluster (M10+ dedicated, Flex, or Serverless) — not local\n" +
          "   MongoDB and not the free shared M0 tier. The app still works without it (see utils/retrieval.js's\n" +
          "   local fallback), just without the index speedup."
      );
    } else {
      console.error("❌ Failed to create index:", err.message);
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
