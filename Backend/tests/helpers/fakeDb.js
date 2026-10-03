// A tiny in-memory stand-in for the Mongoose models, so route tests run with no MongoDB.
//
// It implements only the operations the routes use (find/findOne/exists/countDocuments/create/
// updateOne/findOneAndUpdate/findOneAndDelete/deleteOne/deleteMany + the chat history aggregate),
// and honours the FILTERS the routes pass — so "user A can't read user B's thread" is a real check
// on the route's query, not on the fake. Every operation yields to the event loop first, so two
// concurrent requests genuinely interleave (a read-then-write quota check would race here).
//
// What it does NOT prove: MongoDB's own behaviour (index uniqueness, true atomicity, $vectorSearch).
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { ObjectId } = mongoose.Types;
const same = (a, b) => String(a) === String(b);
const isScalar = (c) => c === null || typeof c !== "object" || c._bsontype || c instanceof Date || Array.isArray(c);
const tick = () => new Promise((resolve) => setImmediate(resolve));

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((f) => matches(doc, f));
    const value = doc[key];
    if (isScalar(cond)) return same(value, cond);
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case "$lt": return value < arg;
        case "$ne": return !same(value, arg);
        case "$eq": return same(value, arg);
        case "$in": return arg.some((x) => same(x, value));
        default: throw new Error(`fakeDb: unsupported operator ${op}`);
      }
    });
  });
}

function project(row, spec) {
  if (!spec) return row;
  const fields = String(spec).split(/\s+/).filter(Boolean);
  if (fields.every((f) => f.startsWith("-"))) {
    const out = { ...row };
    for (const f of fields) delete out[f.slice(1)];
    return out;
  }
  const out = { _id: row._id };
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}

// Thenable, chainable like a Mongoose Query: .select().sort().limit().lean() then await.
class Query {
  constructor(exec, opts = {}) {
    this.exec = exec;
    this.opts = opts;
  }
  select(spec) { this.opts.select = spec; return this; }
  sort(spec) { this.opts.sort = spec; return this; }
  limit(n) { this.opts.limit = n; return this; }
  lean() { this.opts.lean = true; return this; }
  async run() { await tick(); return this.exec(this.opts); }
  then(resolve, reject) { return this.run().then(resolve, reject); }
  catch(reject) { return this.run().catch(reject); }
}

class Collection {
  constructor({ defaults = () => ({}), wrap = null, validate = null } = {}) {
    this.rows = [];
    this.defaults = defaults;
    this.wrap = wrap ? (row) => wrap(this, row) : null;
    this.validate = validate;
  }

  reset() { this.rows = []; }
  // Test helper: insert a row directly (bypasses hashing/validation).
  seed(data) {
    const row = { _id: new ObjectId(), ...this.defaults(), ...data };
    this.rows.push(row);
    return row;
  }

  _out(row, opts) {
    if (!row) return null;
    const out = project({ ...row }, opts.select ?? opts.projection);
    return opts.lean || !this.wrap ? out : this.wrap(out);
  }

  _sortRows(rows, sort) {
    if (!sort) return rows;
    const keys = Object.entries(sort);
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        if (a[k] < b[k]) return -dir;
        if (a[k] > b[k]) return dir;
      }
      return 0;
    });
  }

  find(filter, projection) {
    return new Query((opts) => {
      let rows = this._sortRows(this.rows.filter((r) => matches(r, filter)), opts.sort);
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return rows.map((r) => this._out(r, opts));
    }, { projection });
  }
  findOne(filter, projection) {
    return new Query((opts) => this._out(this.rows.find((r) => matches(r, filter)), opts), { projection });
  }
  findById(id) { return this.findOne({ _id: id }); }
  exists(filter) {
    return new Query(() => {
      const row = this.rows.find((r) => matches(r, filter));
      return row ? { _id: row._id } : null;
    });
  }
  countDocuments(filter = {}) { return new Query(() => this.rows.filter((r) => matches(r, filter)).length); }

  async create(data) {
    await tick();
    const row = { _id: new ObjectId(), ...this.defaults(), ...data };
    this.validate?.(row, this);
    this.rows.push(row);
    return this.wrap ? this.wrap({ ...row }) : { ...row };
  }

  deleteOne(filter) {
    return new Query(() => {
      const i = this.rows.findIndex((r) => matches(r, filter));
      if (i >= 0) this.rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    });
  }
  deleteMany(filter) {
    return new Query(() => {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !matches(r, filter));
      return { deletedCount: before - this.rows.length };
    });
  }
  findOneAndDelete(filter) {
    return new Query((opts) => {
      const i = this.rows.findIndex((r) => matches(r, filter));
      if (i < 0) return null;
      const [row] = this.rows.splice(i, 1);
      return this._out(row, opts);
    });
  }

  _apply(row, update, inserting) {
    for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] ?? 0) + v;
    Object.assign(row, update.$set || {});
    if (inserting) Object.assign(row, update.$setOnInsert || {});
    for (const [k, v] of Object.entries(update.$push || {})) {
      row[k] = row[k] || [];
      const items = v && v.$each ? v.$each : [v];
      for (const item of items) row[k].push({ _id: new ObjectId(), ...item });
    }
  }

  updateOne(filter, update, options = {}) {
    return new Query(() => {
      const row = this.rows.find((r) => matches(r, filter));
      if (row) {
        this._apply(row, update, false);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const base = Object.fromEntries(Object.entries(filter).filter(([, v]) => isScalar(v)));
      const created = { _id: new ObjectId(), ...this.defaults(), ...base };
      this._apply(created, update, true);
      this.rows.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    });
  }

  findOneAndUpdate(filter, update, options = {}) {
    return new Query((opts) => {
      const row = this.rows.find((r) => matches(r, filter));
      if (!row) return null;
      const before = { ...row };
      this._apply(row, update, false);
      return this._out(options.new ? row : before, opts);
    }, { projection: options.projection });
  }
}

const validationError = (message) => Object.assign(new Error(message), { name: "ValidationError" });

export function createFakeDb() {
  const BCRYPT_ROUNDS = 4; // production uses 10; lower keeps tests fast

  const User = new Collection({
    defaults: () => ({ usageCount: 0, isPremium: false, createdAt: new Date() }),
    validate: (row, col) => {
      for (const f of ["username", "email", "password"]) if (!row[f]) throw validationError(`User validation failed: ${f} is required`);
      if (row.password.length < 6) throw validationError("User validation failed: password is shorter than the minimum allowed length (6)");
      row.email = row.email.toLowerCase().trim();
      if (col.rows.some((r) => r.email === row.email)) throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
      row.password = bcrypt.hashSync(row.password, BCRYPT_ROUNDS); // mirrors the pre-save hook
    },
    wrap: (col, row) => {
      const doc = { ...row };
      Object.defineProperty(doc, "comparePassword", { value: (plain) => bcrypt.compare(plain, doc.password) });
      Object.defineProperty(doc, "save", {
        value: async () => {
          await tick();
          const stored = col.rows.find((r) => same(r._id, doc._id));
          if (col.rows.some((r) => r !== stored && r.email === doc.email))
            throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
          if (doc.password !== stored.password) doc.password = await bcrypt.hash(doc.password, BCRYPT_ROUNDS);
          Object.assign(stored, doc);
          return doc;
        },
      });
      return doc;
    },
  });

  const Thread = new Collection({
    defaults: () => ({ title: "New Chat", messages: [], createdAt: new Date(), updatedAt: new Date() }),
  });
  // The chat route's one aggregate: $match then $project the last N messages as `recent`.
  Thread.aggregate = (pipeline) =>
    new Query(() => {
      const match = pipeline.find((s) => s.$match).$match;
      const n = pipeline.find((s) => s.$project).$project.recent.$map.input.$slice[1];
      return Thread.rows
        .filter((r) => matches(r, match))
        .map((r) => ({ _id: r._id, recent: (r.messages || []).slice(n).map((m) => ({ role: m.role, content: m.content })) }));
    });

  const Document = new Collection({
    defaults: () => ({ status: "queued", stage: "Queued", progress: 0, chunkCount: 0, error: null, createdAt: new Date() }),
  });
  const DocumentChunk = new Collection();
  const UploadJob = new Collection({
    defaults: () => ({ status: "queued", attempts: 0, maxAttempts: 3, createdAt: new Date() }),
  });

  const all = { User, Thread, Document, DocumentChunk, UploadJob };
  return {
    ...all,
    reset: () => Object.values(all).forEach((c) => c.reset()),
    hashPassword: (plain) => bcrypt.hashSync(plain, BCRYPT_ROUNDS),
  };
}
