import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { setupApp, signToken, JWT_SECRET } from "./helpers/testApp.js";

let ctx;
let ip;
before(async () => {
  ctx = await setupApp();
});
beforeEach(() => {
  ctx.reset();
  ip = ctx.freshIp(); // per-test client IP: keeps the signup/login rate limiters out of the way
});

const signup = (body) => ctx.http().post("/api/auth/signup").set("X-Forwarded-For", ip).send(body);
const login = (body) => ctx.http().post("/api/auth/login").set("X-Forwarded-For", ip).send(body);

describe("POST /api/auth/signup", () => {
  it("creates a user, returns 201 + a valid 7-day JWT, and never exposes the password", async () => {
    const res = await signup({ username: "Ada", email: "Ada@Example.com", password: "secret123" });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, "ada@example.com"); // lower-cased
    assert.equal(res.body.user.username, "Ada");
    assert.equal(res.body.user.usageCount, 0);
    assert.equal(res.body.user.isPremium, false);
    assert.equal("password" in res.body.user, false);

    const payload = jwt.verify(res.body.token, JWT_SECRET);
    assert.equal(payload.userId, res.body.user.id);
    assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);

    const stored = ctx.db.User.rows[0];
    assert.notEqual(stored.password, "secret123", "password must be stored hashed");
  });

  it("400s when a field is missing", async () => {
    for (const body of [
      { email: "a@b.com", password: "secret123" },
      { username: "a", password: "secret123" },
      { username: "a", email: "a@b.com" },
      {},
    ]) {
      const res = await signup(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "All fields are required");
    }
    assert.equal(ctx.db.User.rows.length, 0);
  });

  it("400s (not 500) on non-string input", async () => {
    const res = await signup({ username: "a", email: { $ne: null }, password: "secret123" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Invalid input");
  });

  it("400s (not 500) when the password is shorter than 6 characters", async () => {
    const res = await signup({ username: "a", email: "a@b.com", password: "123" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /password/i);
    assert.equal(ctx.db.User.rows.length, 0);
  });

  it("409s on a duplicate email, case-insensitively", async () => {
    ctx.seedUser({ email: "taken@example.com" });
    const res = await signup({ username: "b", email: "TAKEN@example.com", password: "secret123" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "Email already exists");
    assert.equal(ctx.db.User.rows.length, 1);
  });
});

describe("POST /api/auth/login", () => {
  it("returns 200 and a valid token for correct credentials", async () => {
    const { user } = ctx.seedUser({ email: "me@example.com", password: "password123", usageCount: 7 });
    const res = await login({ email: "me@example.com", password: "password123" });

    assert.equal(res.status, 200);
    assert.equal(res.body.message, "Login successful");
    assert.equal(res.body.user.usageCount, 7);
    assert.equal(jwt.verify(res.body.token, JWT_SECRET).userId, String(user._id));
    assert.equal("password" in res.body.user, false);
  });

  it("matches the email case-insensitively", async () => {
    ctx.seedUser({ email: "me@example.com" });
    const res = await login({ email: "ME@Example.COM", password: "password123" });
    assert.equal(res.status, 200);
  });

  it("401s with the SAME message for a wrong password and an unknown email (no user enumeration)", async () => {
    ctx.seedUser({ email: "me@example.com" });
    const wrongPw = await login({ email: "me@example.com", password: "nope-nope" });
    const noUser = await login({ email: "ghost@example.com", password: "password123" });

    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.body.error, "Invalid email or password");
    assert.deepEqual(noUser.body, wrongPw.body);
    assert.equal("token" in wrongPw.body, false);
  });

  it("400s on missing fields and on non-string input", async () => {
    assert.equal((await login({ email: "a@b.com" })).status, 400);
    assert.equal((await login({ password: "x" })).status, 400);
    const injection = await login({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(injection.status, 400);
    assert.equal(injection.body.error, "Invalid input");
  });
});

describe("authMiddleware (via GET /api/auth/me)", () => {
  it("returns the current user without the password hash", async () => {
    const { auth, user } = ctx.seedUser({ email: "me@example.com" });
    const res = await ctx.http().get("/api/auth/me").set(auth);

    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "me@example.com");
    assert.equal(res.body.user._id, String(user._id));
    assert.equal("password" in res.body.user, false);
  });

  it("401s without a token, with a non-Bearer header, and with garbage", async () => {
    assert.equal((await ctx.http().get("/api/auth/me")).status, 401);
    const basic = await ctx.http().get("/api/auth/me").set("Authorization", "Basic abc");
    assert.equal(basic.status, 401);
    const junk = await ctx.http().get("/api/auth/me").set("Authorization", "Bearer not.a.jwt");
    assert.equal(junk.status, 401);
    assert.equal(junk.body.error, "Invalid token");
  });

  it("401s for an expired token and for one signed with a different secret", async () => {
    const { user } = ctx.seedUser();
    const expired = signToken(user, { expiresIn: -10 });
    const forged = signToken(user, { expiresIn: "7d" }, "some-other-secret");
    for (const token of [expired, forged]) {
      const res = await ctx.http().get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      assert.equal(res.status, 401);
    }
  });

  it("401s when the token is valid but the user no longer exists", async () => {
    const { auth } = ctx.seedUser();
    ctx.db.User.reset();
    const res = await ctx.http().get("/api/auth/me").set(auth);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "User not found");
  });
});

describe("PUT /api/auth/update-profile", () => {
  const update = (auth, body) => ctx.http().put("/api/auth/update-profile").set(auth).send(body);

  it("requires authentication", async () => {
    assert.equal((await ctx.http().put("/api/auth/update-profile").send({ username: "x" })).status, 401);
  });

  it("updates the username (trimmed) and returns a fresh token", async () => {
    const { auth, user } = ctx.seedUser();
    const res = await update(auth, { username: "  New Name  " });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, "New Name");
    assert.equal(jwt.verify(res.body.token, JWT_SECRET).userId, String(user._id));
    assert.equal(ctx.db.User.rows[0].username, "New Name");
  });

  it("changes the email (lower-cased) and issues a token carrying the new email", async () => {
    const { auth } = ctx.seedUser({ email: "old@example.com" });
    const res = await update(auth, { email: "New@Example.com" });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, "new@example.com");
    assert.equal(jwt.verify(res.body.token, JWT_SECRET).email, "new@example.com");
  });

  it("409s when the new email belongs to someone else, and changes nothing", async () => {
    ctx.seedUser({ email: "taken@example.com" });
    const { auth } = ctx.seedUser({ email: "mine@example.com" });
    const res = await update(auth, { email: "taken@example.com" });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, "Email already in use");
    assert.equal(ctx.db.User.rows.find((u) => u.email === "mine@example.com") !== undefined, true);
  });

  it("requires the current password to set a new one", async () => {
    const { auth } = ctx.seedUser();
    const res = await update(auth, { newPassword: "brand-new-pw" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /current password is required/i);
  });

  it("401s on a wrong current password and 400s on a too-short new password", async () => {
    const { auth } = ctx.seedUser({ password: "password123" });
    const wrong = await update(auth, { currentPassword: "WRONG", newPassword: "brand-new-pw" });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /incorrect/i);

    const short = await update(auth, { currentPassword: "password123", newPassword: "123" });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /at least 6/i);
  });

  it("changes the password: new one logs in, old one no longer does", async () => {
    const { auth } = ctx.seedUser({ email: "me@example.com", password: "password123" });
    const res = await update(auth, { currentPassword: "password123", newPassword: "brand-new-pw" });
    assert.equal(res.status, 200);

    assert.equal((await login({ email: "me@example.com", password: "brand-new-pw" })).status, 200);
    assert.equal((await login({ email: "me@example.com", password: "password123" })).status, 401);
  });
});

describe("POST /api/auth/upgrade", () => {
  const upgrade = (auth) => ctx.http().post("/api/auth/upgrade").set(auth);

  it("requires authentication", async () => {
    assert.equal((await ctx.http().post("/api/auth/upgrade")).status, 401);
  });

  it("is disabled (501) by default so nobody can grant themselves Premium", async () => {
    const { auth } = ctx.seedUser();
    const res = await upgrade(auth);
    assert.equal(res.status, 501);
    assert.equal(ctx.db.User.rows[0].isPremium, false);
  });

  it("works when ENABLE_DEMO_UPGRADE=true, then 400s if already premium", async () => {
    process.env.ENABLE_DEMO_UPGRADE = "true";
    const { auth } = ctx.seedUser();

    const ok = await upgrade(auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.isPremium, true);
    assert.equal(ctx.db.User.rows[0].isPremium, true);

    const again = await upgrade(auth);
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already/i);
  });

  it("stays disabled in production even if the flag is set", async () => {
    process.env.ENABLE_DEMO_UPGRADE = "true";
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { auth } = ctx.seedUser();
      assert.equal((await upgrade(auth)).status, 501);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("GET /api/auth/users-count", () => {
  it("requires authentication and returns the number of users", async () => {
    assert.equal((await ctx.http().get("/api/auth/users-count")).status, 401);
    const { auth } = ctx.seedUser();
    ctx.seedUser();
    const res = await ctx.http().get("/api/auth/users-count").set(auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { count: 2 });
  });
});
