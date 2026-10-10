// Place inspector (docs/13 I): main asks over a long poll, node-agent reads the live handles it already patches.
// Read-only: SQLite files through a separate read-only connection, in-memory SQLite and PGlite only with statements
// built here (PGlite inside a READ ONLY transaction that is rolled back), lru-cache with peek(), Redis through a
// duplicate connection limited to read commands. Runs outside any request context, so it never makes trip events.
import http from "node:http";
import { safeKey } from "./cache.mjs";
import { servicePlace } from "./place.mjs";
import { cut, preview, SECRET } from "./preview.mjs";
import { als } from "./runtime.mjs";

const request = http.request; // unpatched: captured before outgoing.mjs patches node:http
const handles = new Map(); // place id -> { kind: "sqlite" | "postgres" | "lru" | "redis", ref: WeakRef }
let base = "";
let token = "";
let polling = false;
let reading = false; // our own read-only sqlite connection is not the app's handle

export function configureInspector(ingestUrl, tok) {
  base = String(ingestUrl ?? "").replace(/\/+$/, "");
  token = tok ?? "";
  if (handles.size) start();
}

/** Called from the library patches with every handle the app uses. Never throws. */
export function remember(place, kind, handle) {
  try {
    if (reading || !place?.id || !handle) return;
    if (handles.get(place.id)?.ref.deref() === handle) return;
    handles.set(place.id, { kind, ref: new WeakRef(handle) });
    start();
  } catch {}
}

function start() {
  if (polling || !base) return;
  polling = true;
  als.exit(() => void loop().catch(() => {}));
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(base + path, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-shrike-token": token } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => text.length < 1_000_000 && (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("socket", (s) => s.unref()); // never keeps the app alive
    req.setTimeout(30_000, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

async function loop() {
  for (let fails = 0; ; ) {
    let r;
    try {
      r = await post("/inspect/poll", { pid: process.pid, service: servicePlace.id, places: [...handles.keys()] });
    } catch {
      await sleep(Math.min(5000, 250 * 2 ** fails++));
      continue;
    }
    let list;
    try {
      list = r.status === 200 ? JSON.parse(r.text).requests : undefined;
    } catch {}
    if (!Array.isArray(list)) return; // this ingest has no inspector (an older Shrike, a worktree run)
    fails = 0;
    for (const q of list) void answer(q);
  }
}

async function answer(q) {
  let reply;
  try {
    reply = { id: q.id, ok: true, result: await Promise.race([inspect(q), sleep(5000).then(() => Promise.reject(new Error("Reading it took longer than 5 seconds.")))]) };
  } catch (e) {
    reply = { id: q?.id, ok: false, missing: !!e?.missing, error: e?.missing ? undefined : cut(String(e?.message ?? e), 500) };
  }
  try {
    await post("/inspect/reply", reply);
  } catch {}
}

export function inspect(q) {
  const entry = handles.get(q?.placeId);
  const h = entry?.ref.deref();
  if (!h) return Promise.reject(Object.assign(new Error("not here"), { missing: true }));
  const fn = READERS[`${entry.kind}:${q.op}`];
  if (!fn) return Promise.reject(new Error("Shrike can't read that here."));
  return Promise.resolve().then(() => fn(h, q));
}

// ---- values

const MAX_CELL = 300;
const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return String(v);
  if (typeof v === "string") return cut(v, MAX_CELL);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  try {
    return cut(JSON.stringify(v) ?? String(v), MAX_CELL);
  } catch {
    return preview(v);
  }
}

/** A column or key that names a secret shows "[redacted]" instead of its value. */
export const masked = (name, v) => (v != null && SECRET.test(String(name)) ? "[redacted]" : cell(v));

export function rowOut(r) {
  const out = {};
  for (const k of Object.keys(r ?? {})) out[k] = masked(k, r[k]);
  return out;
}

export const quote = (id) => `"${String(id).replaceAll('"', '""')}"`;
const likeTerm = (s) => `%${String(s).slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;

// ---- SQLite (node:sqlite)

function withSqlite(app, fn) {
  let file;
  try {
    file = app.location?.();
  } catch {}
  reading = true;
  let db = app;
  try {
    if (file) db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(file, { readOnly: true });
    return fn(db, !!file);
  } finally {
    if (db !== app) db.close();
    reading = false;
  }
}

function sqliteSchema(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => ({ name, columns: db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((c) => ({ name: c.name, pk: c.pk > 0 })) }));
}

function sqliteTables(app) {
  return withSqlite(app, (db, file) => ({
    op: "tables",
    system: "sqlite",
    how: file ? "a separate read-only connection to the same file" : "your app's in-memory database, reading only",
    tables: sqliteSchema(db).map((t) => ({ ...t, rows: Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`).get().n) })),
  }));
}

function sqliteRows(app, o) {
  return withSqlite(app, (db) => {
    const t = sqliteSchema(db).find((x) => x.name === o.table);
    if (!t) throw new Error(`There's no table called ${o.table} here.`);
    const cols = t.columns.map((c) => c.name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const where = o.search ? ` WHERE ${cols.map((c) => `CAST(${quote(c)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")}` : "";
    const params = o.search ? cols.map(() => likeTerm(o.search)) : [];
    const order = cols.includes(o.orderBy) ? ` ORDER BY ${quote(o.orderBy)} ${o.desc ? "DESC" : "ASC"}` : pk.length ? ` ORDER BY ${pk.map(quote).join(", ")}` : "";
    const sql = `SELECT * FROM ${quote(t.name)}${where}${order} LIMIT ${clamp(o.limit, 1, 200, 100)} OFFSET ${clamp(o.offset, 0, 10_000_000, 0)}`;
    const rows = db.prepare(sql).all(...params);
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}${where}`).get(...params).n);
    return { op: "rows", table: t.name, columns: cols, pk, rows: rows.map((r) => cols.map((c) => masked(c, r[c]))), total };
  });
}

// ---- PGlite

const SCHEMAS = "table_schema NOT IN ('pg_catalog', 'information_schema')";

function pgRead(db, fn) {
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 2000");
    try {
      return await fn(tx);
    } finally {
      await tx.rollback().catch(() => {});
    }
  });
}

async function pgSchema(tx) {
  const tables = (await tx.query(`SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND ${SCHEMAS} ORDER BY 1, 2`)).rows;
  const cols = (await tx.query(`SELECT table_schema AS s, table_name AS t, column_name AS n FROM information_schema.columns WHERE ${SCHEMAS} ORDER BY table_schema, table_name, ordinal_position`)).rows;
  const pks = (
    await tx.query(
      `SELECT k.table_schema AS s, k.table_name AS t, k.column_name AS n FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema WHERE c.constraint_type = 'PRIMARY KEY'`,
    )
  ).rows;
  const isPk = new Set(pks.map((p) => `${p.s}.${p.t}.${p.n}`));
  return tables.map(({ s, t }) => ({
    name: s === "public" ? t : `${s}.${t}`,
    ref: `${quote(s)}.${quote(t)}`,
    columns: cols.filter((c) => c.s === s && c.t === t).map((c) => ({ name: c.n, pk: isPk.has(`${s}.${t}.${c.n}`) })),
  }));
}

function pgTables(db) {
  return pgRead(db, async (tx) => {
    const schema = await pgSchema(tx);
    const counts = schema.length ? (await tx.query(`SELECT ${schema.map((t, i) => `(SELECT COUNT(*) FROM ${t.ref}) AS c${i}`).join(", ")}`)).rows[0] : {};
    return {
      op: "tables",
      system: "postgres",
      how: "a read-only transaction on your app's database, rolled back after",
      tables: schema.map((t, i) => ({ name: t.name, columns: t.columns, rows: Number(counts[`c${i}`] ?? 0) })),
    };
  });
}

function pgRows(db, o) {
  return pgRead(db, async (tx) => {
    const t = (await pgSchema(tx)).find((x) => x.name === o.table);
    if (!t) throw new Error(`There's no table called ${o.table} here.`);
    const cols = t.columns.map((c) => c.name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const where = o.search ? ` WHERE ${cols.map((c) => `${quote(c)}::text ILIKE $1`).join(" OR ")}` : "";
    const params = o.search ? [likeTerm(o.search)] : [];
    const order = cols.includes(o.orderBy) ? ` ORDER BY ${quote(o.orderBy)} ${o.desc ? "DESC" : "ASC"}` : pk.length ? ` ORDER BY ${pk.map(quote).join(", ")}` : "";
    const rows = (await tx.query(`SELECT * FROM ${t.ref}${where}${order} LIMIT ${clamp(o.limit, 1, 200, 100)} OFFSET ${clamp(o.offset, 0, 10_000_000, 0)}`, params)).rows;
    const total = Number((await tx.query(`SELECT COUNT(*) AS n FROM ${t.ref}${where}`, params)).rows[0].n);
    return { op: "rows", table: t.name, columns: cols, pk, rows: rows.map((r) => cols.map((c) => masked(c, r[c]))), total };
  });
}

// ---- lru-cache: keys() and peek() never change which entry is most recently used

const shown = (k, v, max) => (SECRET.test(String(k)) ? "[redacted]" : cut(preview(v), max));
const bytesOf = (v) => {
  try {
    return Buffer.byteLength(typeof v === "string" ? v : (JSON.stringify(v) ?? ""));
  } catch {
    return undefined;
  }
};

function lruKeys(cache, o) {
  const limit = clamp(o.limit, 1, 500, 200);
  const match = String(o.match ?? "").toLowerCase();
  const entries = [];
  for (const k of cache.keys()) {
    const key = safeKey(k);
    if (match && !key.toLowerCase().includes(match)) continue;
    if (entries.length >= limit) break;
    const v = cache.peek(k);
    const ttl = cache.getRemainingTTL?.(k);
    entries.push({ key, preview: shown(k, v, MAX_CELL), ttlMs: Number.isFinite(ttl) ? Math.max(0, Math.round(ttl)) : null, bytes: bytesOf(v) });
  }
  return { op: "cacheKeys", system: "lru", size: cache.size, max: cache.max || undefined, entries };
}

function lruGet(cache, o) {
  for (const k of cache.keys()) if (safeKey(k) === o.key) return { op: "cacheGet", key: o.key, value: shown(k, cache.peek(k), 8192) };
  throw new Error("That key isn't in the cache anymore.");
}

// ---- ioredis: a duplicate connection that only sends these commands

const REDIS_READ = new Set(["scan", "type", "get", "hgetall", "lrange", "smembers", "zrange", "ttl", "strlen"]);

async function withRedis(client, fn) {
  const dup = client.duplicate({ maxRetriesPerRequest: 1, retryStrategy: () => null, enableReadyCheck: false });
  dup.on("error", () => {});
  const send = (cmd, ...args) => (REDIS_READ.has(cmd) ? dup.call(cmd, ...args) : Promise.reject(new Error(`${cmd} is not a read command`)));
  try {
    return await fn(send);
  } finally {
    dup.disconnect();
  }
}

const str = (v) => (Buffer.isBuffer(v) ? v.toString() : v);

async function redisValue(send, key, type, max) {
  if (type === "string") {
    const n = Number(await send("strlen", key));
    return { bytes: n, value: n > 4096 ? `(${n} bytes)` : shown(key, str(await send("get", key)), max) };
  }
  if (type === "hash") return { value: shown(key, await send("hgetall", key), max) };
  if (type === "list") return { value: shown(key, await send("lrange", key, 0, 19), max) };
  if (type === "set") return { value: shown(key, (await send("smembers", key)).slice(0, 20), max) };
  if (type === "zset") return { value: shown(key, await send("zrange", key, 0, 19), max) };
  return { value: `(${type})` };
}

function redisKeys(client, o) {
  return withRedis(client, async (send) => {
    const limit = clamp(o.limit, 1, 500, 200);
    const pattern = o.match ? `*${String(o.match).replace(/[*?[\]\\]/g, "\\$&")}*` : "*";
    const keys = [];
    let cursor = /^\d{1,20}$/.test(o.cursor ?? "") ? o.cursor : "0";
    for (let i = 0; i < 20 && keys.length < limit; i++) {
      const [next, batch] = await send("scan", cursor, "MATCH", pattern, "COUNT", 100);
      keys.push(...batch.map(str));
      cursor = String(next);
      if (cursor === "0") break;
    }
    const entries = await Promise.all(
      keys.slice(0, limit).map(async (k) => {
        const [type, ttl] = await Promise.all([send("type", k), send("ttl", k)]);
        const v = await redisValue(send, k, String(type), MAX_CELL);
        return { key: safeKey(k), type: String(type), preview: v.value, ttlMs: Number(ttl) >= 0 ? Number(ttl) * 1000 : null, bytes: v.bytes };
      }),
    );
    return { op: "cacheKeys", system: "redis", size: entries.length, entries, ...(cursor !== "0" ? { cursor } : {}) };
  });
}

function redisGet(client, o) {
  if (String(o.key).includes("[redacted]")) return Promise.reject(new Error("This key is hidden because it looks like a secret."));
  return withRedis(client, async (send) => {
    const type = String(await send("type", o.key));
    if (type === "none") throw new Error("That key isn't in the cache anymore.");
    return { op: "cacheGet", key: o.key, type, value: (await redisValue(send, o.key, type, 8192)).value };
  });
}

const READERS = {
  "sqlite:tables": sqliteTables,
  "sqlite:rows": sqliteRows,
  "postgres:tables": pgTables,
  "postgres:rows": pgRows,
  "lru:cacheKeys": lruKeys,
  "lru:cacheGet": lruGet,
  "redis:cacheKeys": redisKeys,
  "redis:cacheGet": redisGet,
};

// ---- I3: what a write changed. Parsed from the statement; a simple `WHERE col = ?` gets before/after rows.

const WRITE = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:[\w$"`]+\.)?["`]?([\w$]+)["`]?/i;
const ONE_KEY = /\bWHERE\s+["`]?([\w$]+)["`]?\s*=\s*(\?|\$(\d+))\s*(?:RETURNING\b[\s\S]*?)?;?\s*$/i;

// ponytail: quoted names with spaces, CTEs and `?` inside string literals aren't followed; those writes get counts only.
export function writeOf(sql) {
  const m = WRITE.exec(sql);
  if (!m) return undefined;
  const verb = m[1].split(/\s/)[0].toUpperCase();
  const op = verb === "UPDATE" ? "update" : verb === "DELETE" ? "delete" : "insert";
  const w = ONE_KEY.exec(sql);
  const where = op !== "insert" && w ? { col: w[1], index: w[3] ? Number(w[3]) - 1 : (sql.slice(0, w.index).match(/\?/g) ?? []).length } : undefined;
  return { op, table: m[2], ...(where ? { where } : {}), returning: /\bRETURNING\b/i.test(sql) };
}

const MAX_ROWS = 5;
const pkOf = (row, pk) => (row && pk.length ? pk.map((c) => String(row[c])).join(", ") : row?.id !== undefined ? String(row.id) : undefined);

/** The change event field from a write plan and the rows captured around it. */
export function changeOf(plan, count, { before, after, pk = [] } = {}) {
  const rows = [];
  if (plan.op === "insert") for (const a of (after ?? []).slice(0, MAX_ROWS)) rows.push({ pk: pkOf(a, pk), after: rowOut(a) });
  else if (plan.op === "delete") for (const b of (before ?? []).slice(0, MAX_ROWS)) rows.push({ pk: pkOf(b, pk), before: rowOut(b) });
  else
    for (let i = 0; i < Math.min(MAX_ROWS, Math.max(before?.length ?? 0, after?.length ?? 0)); i++) {
      const b = before?.[i];
      const a = after?.[i];
      rows.push({ pk: pkOf(a ?? b, pk), ...(b ? { before: rowOut(b) } : {}), ...(a ? { after: rowOut(a) } : {}) });
    }
  return { table: plan.table, op: plan.op, count: Math.max(0, Number(count) || 0), ...(rows.length ? { rows } : {}) };
}
