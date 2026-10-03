import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { setupApp, postChat } from "./helpers/testApp.js";

const { ObjectId } = mongoose.Types;
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let ctx;
before(async () => {
  ctx = await setupApp();
});
beforeEach(() => ctx.reset());

const types = (res) => res.body.map((e) => e.type);
const userRow = (user) => ctx.db.User.rows.find((u) => String(u._id) === String(user._id));
const threadFor = (user, threadId) =>
  ctx.db.Thread.rows.find((t) => t.threadId === threadId && String(t.userId) === String(user._id));
const waitFor = async (predicate, ms = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---------------------------------------------------------------------------------------------
describe("thread endpoints", () => {
  it("require authentication", async () => {
    assert.equal((await ctx.http().get("/api/thread")).status, 401);
    assert.equal((await ctx.http().get("/api/thread/t1")).status, 401);
    assert.equal((await ctx.http().delete("/api/thread/t1")).status, 401);
  });

  it("GET /thread lists only my threads, newest first, without message bodies", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "old", userId: me.user._id, title: "Old", updatedAt: new Date("2026-01-01"), messages: [{ role: "user", content: "hi" }] });
    ctx.db.Thread.seed({ threadId: "new", userId: me.user._id, title: "New", updatedAt: new Date("2026-06-01") });
    ctx.db.Thread.seed({ threadId: "theirs", userId: other.user._id, title: "Secret" });

    const res = await ctx.http().get("/api/thread").set(me.auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((t) => t.threadId), ["new", "old"]);
    assert.equal(res.body.every((t) => !("messages" in t)), true);
  });

  it("GET /thread/:id returns my thread, but 404s for another user's", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "mine", userId: me.user._id, title: "Mine", messages: [{ role: "user", content: "hello" }] });
    ctx.db.Thread.seed({ threadId: "theirs", userId: other.user._id, title: "Secret" });

    const ok = await ctx.http().get("/api/thread/mine").set(me.auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.messages[0].content, "hello");

    const denied = await ctx.http().get("/api/thread/theirs").set(me.auth);
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error, "Thread not found");
  });

  it("DELETE /thread/:id deletes mine; 404s and leaves another user's thread alone", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "mine", userId: me.user._id });
    ctx.db.Thread.seed({ threadId: "theirs", userId: other.user._id });

    assert.equal((await ctx.http().delete("/api/thread/mine").set(me.auth)).status, 200);
    assert.equal(threadFor(me.user, "mine"), undefined);

    assert.equal((await ctx.http().delete("/api/thread/theirs").set(me.auth)).status, 404);
    assert.notEqual(threadFor(other.user, "theirs"), undefined);
  });

  it("return 500 (not a crash) when the database fails", async (t) => {
    const me = ctx.seedUser();
    t.mock.method(ctx.db.Thread, "find", () => { throw new Error("db down"); });
    const res = await ctx.http().get("/api/thread").set(me.auth);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Failed to fetch threads");
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/chat — validation (all plain JSON errors, no quota used)", () => {
  it("401s without a token", async () => {
    const res = await ctx.http().post("/api/chat").send({ threadId: "t", message: "hi" });
    assert.equal(res.status, 401);
  });

  it("400s on a missing, non-string or oversized threadId", async () => {
    const { auth } = ctx.seedUser();
    for (const threadId of [undefined, "", 123, "x".repeat(101)]) {
      const res = await postChat(ctx, auth, { threadId, message: "hi" });
      assert.equal(res.status, 400, `threadId=${String(threadId).slice(0, 10)}`);
      assert.equal(res.body.error, "Invalid threadId");
    }
  });

  it("400s on a non-string message or image", async () => {
    const { auth } = ctx.seedUser();
    assert.equal((await postChat(ctx, auth, { threadId: "t", message: { a: 1 } })).body.error, "Invalid message");
    assert.equal((await postChat(ctx, auth, { threadId: "t", message: "hi", image: 5 })).body.error, "Invalid image");
  });

  it("400s when there is neither text nor an image (whitespace counts as empty)", async () => {
    const { auth } = ctx.seedUser();
    const res = await postChat(ctx, auth, { threadId: "t", message: "   " });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Missing fields");
  });

  it("400s on a message over 8000 characters but accepts exactly 8000", async () => {
    const { auth } = ctx.seedUser();
    const tooLong = await postChat(ctx, auth, { threadId: "t", message: "a".repeat(8001) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /too long/i);

    const exact = await postChat(ctx, auth, { threadId: "t2", message: "a".repeat(8000) });
    assert.equal(exact.status, 200);
  });

  it("400s on malformed, unsupported and oversized images", async () => {
    const { auth } = ctx.seedUser();
    const malformed = await postChat(ctx, auth, { threadId: "t", message: "x", image: "not-a-data-url" });
    assert.equal(malformed.body.error, "Invalid image format");

    const gif = await postChat(ctx, auth, { threadId: "t", message: "x", image: "data:image/gif;base64,R0lGODlh" });
    assert.equal(gif.status, 400);
    assert.match(gif.body.error, /unsupported image type/i);

    const huge = await postChat(ctx, auth, { threadId: "t", message: "x", image: `data:image/png;base64,${"A".repeat(10_000_000)}` });
    assert.equal(huge.status, 400);
    assert.match(huge.body.error, /too large/i);
  });

  it("never touches quota or Gemini when validation fails", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 3 });
    await postChat(ctx, auth, { threadId: "t", message: "" });
    await postChat(ctx, auth, { threadId: 5, message: "hi" });
    assert.equal(userRow(user).usageCount, 3);
    assert.equal(ctx.streamGemini.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/chat — quota", () => {
  it("lets a free user send their 20th message, then blocks the 21st with 403 FREE_LIMIT_REACHED", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 19 });

    const last = await postChat(ctx, auth, { threadId: "t", message: "message 20" });
    assert.equal(last.status, 200);
    assert.deepEqual(last.body.at(-1), { type: "done", usageCount: 20, isPremium: false });

    const blocked = await postChat(ctx, auth, { threadId: "t", message: "message 21" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, "FREE_LIMIT_REACHED");
    assert.equal(blocked.body.usageCount, 20);
    assert.equal(blocked.body.isPremium, false);
    assert.equal(ctx.streamGemini.mock.callCount(), 1, "Gemini must not be called once over quota");
    assert.equal(userRow(user).usageCount, 20);
    assert.equal(threadFor(user, "t").messages.length, 2, "blocked message must not be saved");
  });

  it("never blocks a premium user and keeps counting", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 500, isPremium: true });
    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.at(-1), { type: "done", usageCount: 501, isPremium: true });
    assert.equal(userRow(user).usageCount, 501);
  });

  it("is race-safe: three simultaneous requests at 19/20 let exactly one through", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 19 });
    const results = await Promise.all(
      [1, 2, 3].map((n) => postChat(ctx, auth, { threadId: `t${n}`, message: `m${n}` }))
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403, 403]);
    assert.equal(userRow(user).usageCount, 20);
    assert.equal(ctx.streamGemini.mock.callCount(), 1);
  });

  it("rate-limits a user to 10 requests/minute (429 RATE_LIMITED) without affecting other users", async () => {
    const heavy = ctx.seedUser();
    const other = ctx.seedUser();
    for (let i = 0; i < 10; i++) {
      assert.equal((await postChat(ctx, heavy.auth, { threadId: "t", message: "" })).status, 400);
    }
    const limited = await postChat(ctx, heavy.auth, { threadId: "t", message: "" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "RATE_LIMITED");

    assert.equal((await postChat(ctx, other.auth, { threadId: "t", message: "" })).status, 400);
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/chat — streaming and persistence", () => {
  it("streams token events then a done event as text/event-stream", async () => {
    const { auth } = ctx.seedUser();
    const res = await postChat(ctx, auth, { threadId: "t", message: "hello" });

    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/event-stream/);
    assert.equal(res.headers["cache-control"], "no-cache, no-transform");
    assert.equal(res.headers["x-accel-buffering"], "no");
    assert.deepEqual(res.body, [
      { type: "token", text: "Hello" },
      { type: "token", text: " world" },
      { type: "done", usageCount: 1, isPremium: false },
    ]);
  });

  it("saves the user + model messages, creates the thread titled from the message, and bumps usage", async () => {
    const { auth, user } = ctx.seedUser();
    await postChat(ctx, auth, { threadId: "t", message: "  What is a heap?  " });

    const thread = threadFor(user, "t");
    assert.equal(thread.title, "What is a heap?");
    assert.deepEqual(thread.messages.map((m) => [m.role, m.content]), [
      ["user", "What is a heap?"],
      ["model", "Hello world"],
    ]);
    assert.equal(userRow(user).usageCount, 1);
  });

  it("truncates long titles to 50 characters", async () => {
    const { auth, user } = ctx.seedUser();
    await postChat(ctx, auth, { threadId: "t", message: "q".repeat(120) });
    assert.equal(threadFor(user, "t").title.length, 50);
  });

  it("appends to an existing thread without changing its title", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "t", userId: user._id, title: "Keep me", messages: [
      { role: "user", content: "earlier question" },
      { role: "model", content: "earlier answer" },
    ] });

    await postChat(ctx, auth, { threadId: "t", message: "follow-up" });
    const thread = threadFor(user, "t");
    assert.equal(thread.title, "Keep me");
    assert.equal(thread.messages.length, 4);
    assert.equal(ctx.db.Thread.rows.length, 1);
  });

  it("retitles a placeholder 'New Chat' thread (as created by a document upload)", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "t", userId: user._id, title: "New Chat" });
    await postChat(ctx, auth, { threadId: "t", message: "Explain recursion" });
    assert.equal(threadFor(user, "t").title, "Explain recursion");
  });

  it("does not let one user write into another user's thread with the same id", async () => {
    const a = ctx.seedUser();
    const b = ctx.seedUser();
    ctx.db.Thread.seed({ threadId: "shared-id", userId: a.user._id, title: "A's", messages: [{ role: "user", content: "a-secret" }] });

    await postChat(ctx, b.auth, { threadId: "shared-id", message: "from b" });

    assert.equal(threadFor(a.user, "shared-id").messages.length, 1);
    assert.equal(threadFor(b.user, "shared-id").messages.length, 2);
    // and B's model call must not see A's history
    assert.deepEqual(ctx.streamGemini.mock.calls[0].arguments[2], []);
  });

  it("sends only the last 60 messages as {role, content} history", async () => {
    const { auth, user } = ctx.seedUser();
    const messages = Array.from({ length: 70 }, (_, i) => ({
      role: i % 2 ? "model" : "user",
      content: `m${i}`,
      image: "data:image/png;base64,AAAA",
    }));
    ctx.db.Thread.seed({ threadId: "t", userId: user._id, messages });

    await postChat(ctx, auth, { threadId: "t", message: "next" });
    const [message, image, history] = ctx.streamGemini.mock.calls[0].arguments;

    assert.equal(message, "next");
    assert.equal(image, null);
    assert.equal(history.length, 60);
    assert.equal(history[0].content, "m10");
    assert.deepEqual(Object.keys(history[0]).sort(), ["content", "role"], "old base64 images must not be resent");
  });

  it("handles an image-only message: passes the parsed image to Gemini, titles it 'Image scan'", async () => {
    const { auth, user } = ctx.seedUser();
    const res = await postChat(ctx, auth, { threadId: "t", message: "", image: TINY_PNG });

    assert.equal(res.status, 200);
    const [message, image] = ctx.streamGemini.mock.calls[0].arguments;
    assert.equal(message, "");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, TINY_PNG.split(",")[1]);

    const thread = threadFor(user, "t");
    assert.equal(thread.title, "Image scan");
    assert.equal(thread.messages[0].image, TINY_PNG);
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/chat — failure handling", () => {
  it("refunds the quota and saves nothing when Gemini fails before any token", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 5 });
    ctx.streamGemini.mock.mockImplementation(async function* () {
      throw new ctx.GeminiError("The AI service is busy. Try again shortly.", 429);
    });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.status, 200); // already streaming by then; the error is an SSE event
    assert.deepEqual(res.body, [
      { type: "error", message: "The AI service is busy. Try again shortly.", usageCount: 5, isPremium: false },
    ]);
    assert.equal(userRow(user).usageCount, 5, "quota refunded");
    assert.equal(threadFor(user, "t"), undefined, "no empty turn saved");
  });

  it("hides unexpected error details behind a generic message (and still refunds)", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 2 });
    ctx.streamGemini.mock.mockImplementation(async function* () {
      throw new Error("secret internal stack detail");
    });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.body[0].type, "error");
    assert.equal(res.body[0].message, "Something went wrong");
    assert.equal(JSON.stringify(res.body).includes("secret"), false);
    assert.equal(userRow(user).usageCount, 2);
  });

  it("treats an empty model response as an error and refunds", async () => {
    const { auth, user } = ctx.seedUser({ usageCount: 1 });
    ctx.streamGemini.mock.mockImplementation(async function* () {});

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.body[0].type, "error");
    assert.match(res.body[0].message, /no response/i);
    assert.equal(userRow(user).usageCount, 1);
    assert.equal(threadFor(user, "t"), undefined);
  });

  it("keeps a partial reply when the stream breaks mid-way: saves it, flags partial, keeps the quota charge", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.streamGemini.mock.mockImplementation(async function* () {
      yield "Half an ";
      yield "answer";
      throw new ctx.GeminiError("The AI service was interrupted.", 502);
    });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.deepEqual(types(res), ["token", "token", "error"]);
    assert.equal(res.body.at(-1).partial, true);
    assert.equal(res.body.at(-1).usageCount, 1);
    assert.equal(threadFor(user, "t").messages[1].content, "Half an answer");
    assert.equal(userRow(user).usageCount, 1);
  });

  it("reports an error event if the reply can't be saved", async (t) => {
    const { auth, user } = ctx.seedUser();
    t.mock.method(ctx.db.Thread, "updateOne", () => { throw new Error("write failed"); });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.deepEqual(types(res), ["token", "token", "error"]);
    assert.match(res.body.at(-1).message, /could not be saved/i);
    assert.equal(userRow(user).usageCount, 1);
  });

  it("returns a plain 500 and refunds when the history can't be loaded", async (t) => {
    const { auth, user } = ctx.seedUser({ usageCount: 4 });
    t.mock.method(ctx.db.Thread, "aggregate", () => { throw new Error("db down"); });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Something went wrong");
    assert.equal(userRow(user).usageCount, 4);
    assert.equal(ctx.streamGemini.mock.callCount(), 0);
  });

  it("aborts the Gemini call and saves nothing when the client disconnects mid-stream", async () => {
    const { auth, user } = ctx.seedUser();
    let aborted = false;
    ctx.streamGemini.mock.mockImplementation(async function* (_m, _i, _h, signal) {
      yield "first token";
      await new Promise((resolve) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        })
      );
    });

    const server = ctx.app.listen(0);
    try {
      const req = http.request(
        { port: server.address().port, method: "POST", path: "/api/chat", headers: { ...auth, "Content-Type": "application/json" } },
        (res) => res.once("data", () => req.destroy())
      );
      req.on("error", () => {});
      req.end(JSON.stringify({ threadId: "t", message: "hi" }));

      await waitFor(() => aborted);
      assert.equal(aborted, true);
      assert.equal(threadFor(user, "t"), undefined, "an abandoned reply is not saved");
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/chat — RAG over attached documents", () => {
  const chunk = (over = {}) => ({
    documentId: new ObjectId(),
    fileName: "notes.md",
    chunkIndex: 0,
    text: "A PriorityQueue is a binary min-heap.",
    score: 0.9,
    ...over,
  });

  it("without any ready document: no embedding call, no retrieval, no citations", async () => {
    const { auth } = ctx.seedUser();
    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(ctx.embedQuery.mock.callCount(), 0);
    assert.equal(ctx.retrieve.mock.callCount(), 0);
    assert.equal(types(res).includes("citations"), false);
  });

  it("ignores documents that are still processing, failed, or owned by someone else", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    ctx.db.Document.seed({ userId: me.user._id, threadId: "t", status: "processing" });
    ctx.db.Document.seed({ userId: me.user._id, threadId: "t", status: "failed" });
    ctx.db.Document.seed({ userId: other.user._id, threadId: "t", status: "ready" });
    ctx.db.Document.seed({ userId: me.user._id, threadId: "another-thread", status: "ready" });

    await postChat(ctx, me.auth, { threadId: "t", message: "hi" });
    assert.equal(ctx.retrieve.mock.callCount(), 0);
  });

  it("retrieves top-5 chunks scoped to this user+thread, streams citations first, passes chunks to Gemini, and persists them", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.db.Document.seed({ userId: user._id, threadId: "t", status: "ready" });
    const chunks = [chunk(), chunk({ chunkIndex: 1, text: "offer and poll are O(log n)." })];
    ctx.retrieve.mock.mockImplementation(async () => chunks);

    const res = await postChat(ctx, auth, { threadId: "t", message: "How does PriorityQueue work?" });

    assert.equal(ctx.embedQuery.mock.calls[0].arguments[0], "How does PriorityQueue work?");
    const args = ctx.retrieve.mock.calls[0].arguments[0];
    assert.equal(args.threadId, "t");
    assert.equal(String(args.userId), String(user._id));
    assert.equal(args.topK, 5);
    assert.deepEqual(args.queryEmbedding, [0.1, 0.2, 0.3]);

    assert.deepEqual(types(res), ["citations", "token", "token", "done"], "citations arrive before the first token");
    assert.deepEqual(res.body[0].citations.map((c) => c.chunkIndex), [0, 1]);
    assert.deepEqual(Object.keys(res.body[0].citations[0]).sort(), ["chunkIndex", "documentId", "fileName", "text"], "score is not leaked");

    assert.equal(ctx.streamGemini.mock.calls[0].arguments[4], chunks);
    const saved = threadFor(user, "t").messages[1];
    assert.equal(saved.citations.length, 2, "citations survive a reload");
  });

  it("falls back to a normal answer when retrieval throws", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.db.Document.seed({ userId: user._id, threadId: "t", status: "ready" });
    ctx.embedQuery.mock.mockImplementation(async () => { throw new Error("embedding API down"); });

    const res = await postChat(ctx, auth, { threadId: "t", message: "hi" });
    assert.equal(res.status, 200);
    assert.deepEqual(types(res), ["token", "token", "done"]);
    assert.deepEqual(ctx.streamGemini.mock.calls[0].arguments[4], []);
  });

  it("skips retrieval for image-only messages (nothing to embed)", async () => {
    const { auth, user } = ctx.seedUser();
    ctx.db.Document.seed({ userId: user._id, threadId: "t", status: "ready" });
    await postChat(ctx, auth, { threadId: "t", message: "", image: TINY_PNG });
    assert.equal(ctx.embedQuery.mock.callCount(), 0);
  });
});
