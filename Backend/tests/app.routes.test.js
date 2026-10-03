import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupApp } from "./helpers/testApp.js";

let ctx;
before(async () => {
  ctx = await setupApp();
});
beforeEach(() => ctx.reset());

describe("app-level behaviour", () => {
  it("GET / is a health check", async () => {
    const res = await ctx.http().get("/");
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  it("unknown routes get a JSON 404 (unknown /api paths need a token first, as the routers sit behind auth)", async () => {
    const res = await ctx.http().get("/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: "Route not found" });

    const { auth } = ctx.seedUser();
    assert.equal((await ctx.http().get("/api/does-not-exist").set(auth)).status, 404);
    assert.equal((await ctx.http().get("/api/does-not-exist")).status, 401);
  });

  it("malformed JSON gets a 400 from the error handler, not a stack trace", async () => {
    const res = await ctx.http().post("/api/auth/login").set("Content-Type", "application/json").send("{not json");
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(JSON.stringify(res.body).includes("node_modules"), false);
  });

  it("rejects JSON bodies over 100kb on normal routes (413)", async () => {
    const res = await ctx.http().post("/api/auth/login").send({ email: "a@b.com", password: "x".repeat(150_000) });
    assert.equal(res.status, 413);
  });

  it("allows configured CORS origins and withholds the header for others", async () => {
    const allowed = await ctx.http().get("/").set("Origin", "http://localhost:5173");
    assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:5173");

    const denied = await ctx.http().get("/").set("Origin", "https://evil.example");
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  });
});

describe("auth rate limits", () => {
  it("locks out login after 10 failed attempts from one IP (429 RATE_LIMITED), but other IPs are unaffected", async () => {
    const ip = ctx.freshIp();
    const attempt = (from) => ctx.http().post("/api/auth/login").set("X-Forwarded-For", from).send({ email: "x@example.com", password: "wrong-pass" });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(ip)).status, 401);

    const limited = await attempt(ip);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "RATE_LIMITED");
    assert.equal((await attempt(ctx.freshIp())).status, 401);
  });

  it("successful logins don't count towards the lockout", async () => {
    ctx.seedUser({ email: "ok@example.com", password: "password123" });
    const ip = ctx.freshIp();
    for (let i = 0; i < 12; i++) {
      const res = await ctx.http().post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "ok@example.com", password: "password123" });
      assert.equal(res.status, 200);
    }
  });

  it("limits signups to 5 per hour per IP", async () => {
    const ip = ctx.freshIp();
    const signup = (n) =>
      ctx.http().post("/api/auth/signup").set("X-Forwarded-For", ip).send({ username: `u${n}`, email: `u${n}@example.com`, password: "password123" });
    for (let i = 0; i < 5; i++) assert.equal((await signup(i)).status, 201);
    const limited = await signup(6);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "RATE_LIMITED");
  });
});
