import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { setupApp } from "./helpers/testApp.js";

const { ObjectId } = mongoose.Types;

let ctx;
before(async () => {
  ctx = await setupApp();
});
beforeEach(() => ctx.reset());

const upload = (auth, threadId, { name = "notes.txt", type = "text/plain", content = "hello world", field = "file" } = {}) =>
  ctx.http().post(`/api/documents/${threadId}/upload`).set(auth).attach(field, Buffer.isBuffer(content) ? content : Buffer.from(content), { filename: name, contentType: type });

const docsFor = (user) => ctx.db.Document.rows.filter((d) => String(d.userId) === String(user._id));

// ---------------------------------------------------------------------------------------------
describe("authentication", () => {
  it("every document route 401s without a token", async () => {
    const id = new ObjectId();
    assert.equal((await ctx.http().get("/api/documents/t")).status, 401);
    assert.equal((await ctx.http().get(`/api/documents/t/${id}/status`)).status, 401);
    assert.equal((await ctx.http().post("/api/documents/t/upload").attach("file", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" })).status, 401);
    assert.equal((await ctx.http().delete(`/api/documents/t/${id}`)).status, 401);
  });
});

// ---------------------------------------------------------------------------------------------
describe("POST /api/documents/:threadId/upload", () => {
  it("accepts a file with 202, queues a job holding the bytes, and wakes the worker — without indexing inline", async () => {
    const { auth, user } = ctx.seedUser();
    const res = await upload(auth, "t1", { name: "notes.txt", content: "some study notes" });

    assert.equal(res.status, 202);
    assert.equal(res.body.fileName, "notes.txt");
    assert.equal(res.body.status, "queued");
    assert.equal(res.body.stage, "Queued");
    assert.equal(res.body.progress, 0);
    assert.equal(res.body.statusUrl, `/api/documents/t1/${res.body.id}/status`);

    const [doc] = docsFor(user);
    assert.equal(String(doc._id), res.body.id);
    assert.equal(doc.status, "queued");
    assert.equal(doc.sizeBytes, "some study notes".length);
    assert.equal(doc.threadId, "t1");

    const [job] = ctx.db.UploadJob.rows;
    assert.equal(String(job.documentId), res.body.id);
    assert.equal(String(job.userId), String(user._id));
    assert.equal(job.threadId, "t1");
    assert.equal(job.mimeType, "text/plain");
    assert.equal(job.fileData.toString(), "some study notes");

    assert.equal(ctx.wakeWorker.mock.callCount(), 1);
    assert.equal(ctx.db.DocumentChunk.rows.length, 0, "no chunks yet: indexing happens in the background");
  });

  it("accepts PDF and Markdown uploads too", async () => {
    const { auth } = ctx.seedUser();
    assert.equal((await upload(auth, "t", { name: "a.pdf", type: "application/pdf", content: "%PDF-1.4" })).status, 202);
    assert.equal((await upload(auth, "t", { name: "a.md", type: "text/markdown", content: "# hi" })).status, 202);
  });

  it("creates the thread as 'New Chat' if the user uploads before sending any message, but leaves an existing thread alone", async () => {
    const { auth, user } = ctx.seedUser();
    await upload(auth, "brand-new");
    const created = ctx.db.Thread.rows.find((t) => t.threadId === "brand-new");
    assert.equal(created.title, "New Chat");
    assert.equal(String(created.userId), String(user._id));

    ctx.db.Thread.seed({ threadId: "existing", userId: user._id, title: "Keep", messages: [{ role: "user", content: "x" }] });
    await upload(auth, "existing");
    const kept = ctx.db.Thread.rows.filter((t) => t.threadId === "existing");
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, "Keep");
    assert.equal(kept[0].messages.length, 1);
  });

  it("scopes threads per user: the same threadId from two users yields two separate threads", async () => {
    const a = ctx.seedUser();
    const b = ctx.seedUser();
    await upload(a.auth, "same-id");
    await upload(b.auth, "same-id");
    assert.equal(ctx.db.Thread.rows.filter((t) => t.threadId === "same-id").length, 2);
  });

  it("400s when no file is sent or the field name is wrong", async () => {
    const { auth } = ctx.seedUser();
    const none = await ctx.http().post("/api/documents/t/upload").set(auth);
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no file uploaded/i);

    const wrongField = await upload(auth, "t", { field: "document" });
    assert.equal(wrongField.status, 400);
  });

  it("400s on unsupported file types and queues nothing", async () => {
    const { auth, user } = ctx.seedUser();
    const res = await upload(auth, "t", { name: "pic.png", type: "image/png", content: "x" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unsupported file type/i);
    assert.equal(docsFor(user).length, 0);
    assert.equal(ctx.db.UploadJob.rows.length, 0);
    assert.equal(ctx.wakeWorker.mock.callCount(), 0);
  });

  it("400s on a file over 15MB, but accepts exactly 15MB", async () => {
    const { auth, user } = ctx.seedUser();
    const MB = 1024 * 1024;
    const tooBig = await upload(auth, "t", { content: Buffer.alloc(15 * MB + 1, "a") });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.error, /too large \(max 15MB\)/i);
    assert.equal(docsFor(user).length, 0);

    const exact = await upload(auth, "t", { content: Buffer.alloc(15 * MB, "a") });
    assert.equal(exact.status, 202);
  });

  it("400s once a thread already holds 20 documents, without affecting other threads", async () => {
    const { auth, user } = ctx.seedUser();
    for (let i = 0; i < 20; i++) ctx.db.Document.seed({ userId: user._id, threadId: "full", status: "ready" });

    const res = await upload(auth, "full");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /limit of 20 documents/i);
    assert.equal(docsFor(user).length, 20);

    assert.equal((await upload(auth, "other-thread")).status, 202);
  });

  it("429s when the user already has 5 queued/processing jobs; finished jobs and other users don't count", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    for (const status of ["queued", "queued", "processing", "processing", "queued"]) {
      ctx.db.UploadJob.seed({ userId: me.user._id, threadId: "x", status });
    }
    ctx.db.UploadJob.seed({ userId: other.user._id, threadId: "x", status: "queued" });

    const blocked = await upload(me.auth, "t");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "RATE_LIMITED");
    assert.equal(docsFor(me.user).length, 0);

    assert.equal((await upload(other.auth, "t")).status, 202);

    ctx.db.UploadJob.rows.find((j) => j.status === "queued" && String(j.userId) === String(me.user._id)).status = "done";
    assert.equal((await upload(me.auth, "t")).status, 202);
  });

  it("rate-limits to 20 uploads per hour per user (429 RATE_LIMITED), not affecting other users", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    for (let i = 0; i < 20; i++) {
      assert.equal((await upload(me.auth, `thread-${i}`)).status, 202, `upload ${i + 1}`);
      ctx.db.UploadJob.rows.forEach((j) => (j.status = "done")); // keep the separate 5-active-jobs cap out of the way
    }
    const limited = await upload(me.auth, "thread-21");
    assert.equal(limited.status, 429);
    assert.match(limited.body.message, /too many document uploads/i);

    assert.equal((await upload(other.auth, "thread-1")).status, 202);
  });

  it("rolls the Document back if the job can't be queued (no document stuck 'queued' forever)", async (t) => {
    const { auth, user } = ctx.seedUser();
    t.mock.method(ctx.db.UploadJob, "create", async () => { throw new Error("job insert failed"); });

    const res = await upload(auth, "t");
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Could not queue document for processing");
    assert.equal(docsFor(user).length, 0);
    assert.equal(ctx.wakeWorker.mock.callCount(), 0);
  });

  it("500s cleanly if the thread can't be prepared", async (t) => {
    const { auth } = ctx.seedUser();
    t.mock.method(ctx.db.Thread, "updateOne", () => { throw new Error("db down"); });
    const res = await upload(auth, "t");
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Could not prepare chat for upload");
  });
});

// ---------------------------------------------------------------------------------------------
describe("GET /api/documents/:threadId (list)", () => {
  it("lists only my documents for that thread, newest first, with safe fields only", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    ctx.db.Document.seed({ userId: me.user._id, threadId: "t", fileName: "old.txt", mimeType: "text/plain", sizeBytes: 1, createdAt: new Date("2026-01-01") });
    ctx.db.Document.seed({ userId: me.user._id, threadId: "t", fileName: "new.txt", mimeType: "text/plain", sizeBytes: 2, status: "ready", chunkCount: 4, createdAt: new Date("2026-06-01") });
    ctx.db.Document.seed({ userId: me.user._id, threadId: "elsewhere", fileName: "wrong-thread.txt", mimeType: "text/plain", sizeBytes: 3 });
    ctx.db.Document.seed({ userId: other.user._id, threadId: "t", fileName: "theirs.txt", mimeType: "text/plain", sizeBytes: 4 });

    const res = await ctx.http().get("/api/documents/t").set(me.auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((d) => d.fileName), ["new.txt", "old.txt"]);
    assert.equal(res.body[0].chunkCount, 4);
    assert.equal(res.body.every((d) => !("userId" in d)), true);
  });

  it("returns [] for a thread with no documents", async () => {
    const { auth } = ctx.seedUser();
    const res = await ctx.http().get("/api/documents/nothing-here").set(auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });
});

// ---------------------------------------------------------------------------------------------
describe("GET /api/documents/:threadId/:documentId/status (polling)", () => {
  const status = (auth, threadId, id) => ctx.http().get(`/api/documents/${threadId}/${id}/status`).set(auth);

  it("reports a queued/processing document as not done, uncached", async () => {
    const { auth, user } = ctx.seedUser();
    const doc = ctx.db.Document.seed({ userId: user._id, threadId: "t", fileName: "a.txt", status: "processing", stage: "Embedding", progress: 40 });

    const res = await status(auth, "t", doc._id);
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, {
      id: String(doc._id), fileName: "a.txt", status: "processing", stage: "Embedding", progress: 40, chunkCount: 0, error: null, done: false,
    });
  });

  it("reports ready and failed documents as done, including the failure reason", async () => {
    const { auth, user } = ctx.seedUser();
    const ready = ctx.db.Document.seed({ userId: user._id, threadId: "t", status: "ready", chunkCount: 7 });
    const failed = ctx.db.Document.seed({ userId: user._id, threadId: "t", status: "failed", error: "Could not read this PDF" });

    const r = await status(auth, "t", ready._id);
    assert.equal(r.body.done, true);
    assert.equal(r.body.chunkCount, 7);

    const f = await status(auth, "t", failed._id);
    assert.equal(f.body.done, true);
    assert.equal(f.body.error, "Could not read this PDF");
  });

  it("400s on an invalid id and 404s for unknown ids, the wrong thread, or another user's document", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    const mine = ctx.db.Document.seed({ userId: me.user._id, threadId: "t" });
    const theirs = ctx.db.Document.seed({ userId: other.user._id, threadId: "t" });

    assert.equal((await status(me.auth, "t", "not-an-object-id")).status, 400);
    assert.equal((await status(me.auth, "t", new ObjectId())).status, 404);
    assert.equal((await status(me.auth, "wrong-thread", mine._id)).status, 404);
    assert.equal((await status(me.auth, "t", theirs._id)).status, 404);
  });

  it("500s cleanly on a database error", async (t) => {
    const { auth } = ctx.seedUser();
    t.mock.method(ctx.db.Document, "findOne", () => { throw new Error("db down"); });
    const res = await status(auth, "t", new ObjectId());
    assert.equal(res.status, 500);
  });
});

// ---------------------------------------------------------------------------------------------
describe("DELETE /api/documents/:threadId/:documentId", () => {
  const del = (auth, threadId, id) => ctx.http().delete(`/api/documents/${threadId}/${id}`).set(auth);

  it("deletes the document and cascades to its chunks and pending job, leaving other documents alone", async () => {
    const { auth, user } = ctx.seedUser();
    const doc = ctx.db.Document.seed({ userId: user._id, threadId: "t" });
    const keep = ctx.db.Document.seed({ userId: user._id, threadId: "t" });
    ctx.db.DocumentChunk.seed({ documentId: doc._id, userId: user._id, threadId: "t" });
    ctx.db.DocumentChunk.seed({ documentId: doc._id, userId: user._id, threadId: "t" });
    ctx.db.DocumentChunk.seed({ documentId: keep._id, userId: user._id, threadId: "t" });
    ctx.db.UploadJob.seed({ documentId: doc._id, userId: user._id, threadId: "t" });
    ctx.db.UploadJob.seed({ documentId: keep._id, userId: user._id, threadId: "t" });

    const res = await del(auth, "t", doc._id);
    assert.equal(res.status, 200);

    assert.deepEqual(ctx.db.Document.rows.map((d) => String(d._id)), [String(keep._id)]);
    assert.equal(ctx.db.DocumentChunk.rows.length, 1);
    assert.equal(String(ctx.db.DocumentChunk.rows[0].documentId), String(keep._id));
    assert.equal(ctx.db.UploadJob.rows.length, 1);
    assert.equal(String(ctx.db.UploadJob.rows[0].documentId), String(keep._id));
  });

  it("404s for another user's document and deletes nothing (document or chunks)", async () => {
    const me = ctx.seedUser();
    const other = ctx.seedUser();
    const theirs = ctx.db.Document.seed({ userId: other.user._id, threadId: "t" });
    ctx.db.DocumentChunk.seed({ documentId: theirs._id, userId: other.user._id, threadId: "t" });

    const res = await del(me.auth, "t", theirs._id);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Document not found");
    assert.equal(ctx.db.Document.rows.length, 1);
    assert.equal(ctx.db.DocumentChunk.rows.length, 1);
  });

  it("404s for the wrong thread, 400s for an invalid id, and is not repeatable", async () => {
    const { auth, user } = ctx.seedUser();
    const doc = ctx.db.Document.seed({ userId: user._id, threadId: "t" });

    assert.equal((await del(auth, "other-thread", doc._id)).status, 404);
    assert.equal((await del(auth, "t", "garbage")).status, 400);
    assert.equal((await del(auth, "t", doc._id)).status, 200);
    assert.equal((await del(auth, "t", doc._id)).status, 404);
  });

  it("500s cleanly on a database error", async (t) => {
    const { auth, user } = ctx.seedUser();
    const doc = ctx.db.Document.seed({ userId: user._id, threadId: "t" });
    t.mock.method(ctx.db.Document, "findOneAndDelete", () => { throw new Error("db down"); });
    const res = await del(auth, "t", doc._id);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Failed to delete document");
  });
});
