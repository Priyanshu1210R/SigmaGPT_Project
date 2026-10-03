// Shared harness for the route (integration) tests.
//
// Real: Express app, routing, middleware, auth/JWT, rate limiters, multer, request validation, SSE.
// Faked: the Mongoose models (tests/helpers/fakeDb.js) and every external boundary — Gemini,
// embeddings, vector retrieval and the background worker. So no MongoDB, API key or network needed.
//
// Run via `npm test` (needs --experimental-test-module-mocks, already in the script).
import { mock } from "node:test";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createFakeDb } from "./fakeDb.js";

export const JWT_SECRET = "test-secret";
process.env.JWT_SECRET = JWT_SECRET;
process.env.GEMINI_API_KEY ||= "test-key";
delete process.env.ENABLE_DEMO_UPGRADE;

const href = (rel) => new URL(rel, import.meta.url).href;

class FakeGeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

// Default model reply: two tokens.
const defaultReply = async function* () {
  yield "Hello";
  yield " world";
};

/** Call once per test file, before anything imports the app. */
export async function setupApp() {
  const db = createFakeDb();

  const ctx = {
    db,
    // Replaceable behaviour for the external services (reset between tests).
    streamGemini: mock.fn(defaultReply),
    embedQuery: mock.fn(async () => [0.1, 0.2, 0.3]),
    retrieve: mock.fn(async () => []),
    wakeWorker: mock.fn(() => {}),
  };

  const models = { User: db.User, Thread: db.Thread, Document: db.Document, DocumentChunk: db.DocumentChunk, UploadJob: db.UploadJob };
  for (const [name, model] of Object.entries(models)) {
    mock.module(href(`../../models/${name}.js`), { defaultExport: model });
  }
  mock.module(href("../../utils/gemini.js"), {
    namedExports: {
      GeminiError: FakeGeminiError,
      streamGeminiResponse: (...args) => ctx.streamGemini(...args),
      trimHistory: (h) => h,
      buildContextBlock: () => "",
      HISTORY_TOKEN_BUDGET: 24000,
    },
  });
  mock.module(href("../../utils/embeddings.js"), {
    namedExports: {
      embedQuery: (...args) => ctx.embedQuery(...args),
      embedChunks: async () => [],
      EMBEDDING_DIMENSIONS: 768,
    },
  });
  mock.module(href("../../utils/retrieval.js"), {
    namedExports: {
      retrieveRelevantChunks: (...args) => ctx.retrieve(...args),
      VECTOR_INDEX_NAME: "test",
    },
  });
  mock.module(href("../../workers/documentWorker.js"), {
    namedExports: {
      wakeWorker: () => ctx.wakeWorker(),
      startDocumentWorker: () => null,
    },
  });

  const { default: app } = await import("../../app.js");
  ctx.app = app;
  ctx.GeminiError = FakeGeminiError;

  // Quiet the routes' console.error/log noise unless debugging: TEST_LOGS=1 npm test
  if (!process.env.TEST_LOGS) {
    for (const m of ["log", "warn", "error"]) mock.method(console, m, () => {});
  }

  ctx.reset = () => {
    db.reset();
    ctx.streamGemini.mock.resetCalls();
    ctx.streamGemini.mock.mockImplementation(defaultReply);
    ctx.embedQuery.mock.resetCalls();
    ctx.embedQuery.mock.mockImplementation(async () => [0.1, 0.2, 0.3]);
    ctx.retrieve.mock.resetCalls();
    ctx.retrieve.mock.mockImplementation(async () => []);
    ctx.wakeWorker.mock.resetCalls();
    delete process.env.ENABLE_DEMO_UPGRADE;
  };

  /** Insert a user (password hashed) and return { user, token, auth } ready for requests. */
  ctx.seedUser = ({ email, password = "password123", usageCount = 0, isPremium = false, username = "tester" } = {}) => {
    const n = db.User.rows.length + 1;
    const user = db.User.seed({
      username,
      email: email ?? `user${n}@example.com`,
      password: db.hashPassword(password),
      usageCount,
      isPremium,
    });
    const token = signToken(user);
    return { user, password, token, auth: { Authorization: `Bearer ${token}` } };
  };

  ctx.http = () => request(app);

  // The app trusts one proxy hop, so X-Forwarded-For sets the client IP the per-IP limiters see.
  // Give each test its own IP so signup (5/hour) and login (10 failures/15min) limits don't leak
  // between tests; the rate-limit tests deliberately reuse one.
  let ipCounter = 0;
  ctx.freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  return ctx;
}

export const signToken = (user, opts = { expiresIn: "7d" }, secret = JWT_SECRET) =>
  jwt.sign({ userId: String(user._id), email: user.email }, secret, opts);

// ---- SSE helpers -----------------------------------------------------------------------------

// superagent only buffers known content types; this parser collects the raw body for ANY type and
// turns `text/event-stream` into an array of parsed events, JSON into an object.
const bodyParser = (res, cb) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const type = res.headers["content-type"] || "";
    try {
      if (type.includes("text/event-stream")) cb(null, parseSSE(data));
      else if (type.includes("json")) cb(null, JSON.parse(data));
      else cb(null, data);
    } catch (err) {
      cb(err);
    }
  });
};

export const parseSSE = (raw) =>
  raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => JSON.parse(block.replace(/^data: /, "")));

/** POST /api/chat and return the response; for streams, `res.body` is the array of SSE events. */
export const postChat = (ctx, auth, body) =>
  ctx.http().post("/api/chat").set(auth).send(body).buffer(true).parse(bodyParser);
