// Place inspector (docs/13 I): read-only reads of live handles over the long poll, and I3 write capture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeOf } from "../src/inspect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "inspect");
const register = pathToFileURL(path.join(here, "..", "src", "register.mjs")).href;
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const readBody = (req) => new Promise((r) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => r(b ? JSON.parse(b) : {}));
});

// /ingest plus a one-agent stand-in for main's inspector hub.
function startIngest() {
  const messages = [];
  const polls = [];
  const replies = new Map();
  const queue = [];
  let waiter;
  let n = 0;
  const flush = () => {
    if (!waiter || !queue.length) return;
    waiter.end(JSON.stringify({ requests: queue.splice(0) }));
    waiter = undefined;
  };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.headers["x-shrike-token"] !== "t") return void res.writeHead(401).end();
    if (req.url === "/ingest") return (messages.push(body), res.end("{}"));
    if (req.url === "/inspect/poll") {
      polls.push(body);
      waiter = res;
      res.on("close", () => waiter === res && (waiter = undefined));
      setTimeout(() => waiter === res && ((waiter = undefined), res.end(JSON.stringify({ requests: [] }))), 2000);
      return flush();
    }
    if (req.url === "/inspect/reply") {
      replies.get(body.id)?.(body);
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  const ask = (q) =>
    new Promise((resolve, reject) => {
      const id = `q${++n}`;
      const timer = setTimeout(() => reject(new Error(`no reply to ${q.op}`)), 8000);
      replies.set(id, (r) => (clearTimeout(timer), resolve(r)));
      queue.push({ id, ...q });
      flush();
    });
  return listen(server).then((port) => ({ server, messages, polls, ask, url: `http://127.0.0.1:${port}` }));
}

// RESP: GET/SET plus the read commands the inspector uses. Records every command it sees.
function startRedis() {
  const store = new Map([["user:1", "Ann"], ["auth_token", "abc"]]);
  const seen = [];
  const bulk = (s) => (s === undefined ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (buf[0] !== 0x2a || i < 0) break;
        const count = Number(buf.subarray(1, i).toString());
        const args = [];
        let pos = i + 2;
        for (let k = 0; k < count; k++) {
          const j = buf.indexOf("\r\n", pos);
          if (j < 0) break;
          const len = Number(buf.subarray(pos + 1, j).toString());
          if (buf.length < j + 2 + len + 2) break;
          args.push(buf.subarray(j + 2, j + 2 + len).toString());
          pos = j + 2 + len + 2;
        }
        if (args.length < count) break;
        buf = buf.subarray(pos);
        const [cmd, key, value] = [args[0].toUpperCase(), args[1], args[2]];
        seen.push(cmd);
        if (cmd === "GET") sock.write(bulk(store.get(key)));
        else if (cmd === "SET") sock.write((store.set(key, value), "+OK\r\n"));
        else if (cmd === "SCAN") sock.write(`*2\r\n${bulk("0")}*${store.size}\r\n${[...store.keys()].map(bulk).join("")}`);
        else if (cmd === "TYPE") sock.write(store.has(key) ? "+string\r\n" : "+none\r\n");
        else if (cmd === "TTL") sock.write(":-1\r\n");
        else if (cmd === "STRLEN") sock.write(`:${Buffer.byteLength(store.get(key) ?? "")}\r\n`);
        else if (cmd === "INFO") sock.write(bulk("# Server\r\nloading:0\r\n"));
        else sock.write("+OK\r\n");
      }
    });
  });
  return listen(server).then((port) => ({ server, port, store, seen }));
}

function startApp(env) {
  const child = spawn(process.execPath, ["server.ts"], { cwd: appDir, env: { ...process.env, NODE_OPTIONS: "", SHRIKE_INGEST_URL: "", SHRIKE_SERVICE: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const port = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = /listening (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`app exited ${code}: ${stderr}`)));
  });
  return { child, port };
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  const exited = new Promise((r) => app.child.once("exit", r));
  app.child.kill();
  await exited;
}

const get = async (port, url) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`);
  return `${r.status} ${await r.text()}`;
};
const STEPS = ["/session/a", "/session/b", "/session/c", "/session/a", "/redis/user:1", "/users", "/todo-add/four", "/todo-done/2", "/todo-del/3", "/todo-bad", "/user-add/Cy", "/order-add/30", "/order-ship/1", "/lru-order"];

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out");
}

describe("place inspector", () => {
  let ingest, redis, app, port, dbDir, responses;
  const events = () => ingest.messages.flatMap((m) => (m.type === "events" ? m.events : []));
  const ok = async (q) => {
    const r = await ingest.ask(q);
    assert.ok(r.ok, `${q.op} ${q.placeId}: ${r.error ?? (r.missing ? "missing" : "")}`);
    return r.result;
  };
  const inspectAll = () =>
    Promise.all([
      ok({ op: "tables", placeId: "data:sqlite:shop.db" }),
      ok({ op: "rows", placeId: "data:sqlite:shop.db", table: "users" }),
      ok({ op: "tables", placeId: "data:sqlite::memory:" }),
      ok({ op: "rows", placeId: "data:sqlite::memory:", table: "todos", orderBy: "id", desc: true }),
      ok({ op: "tables", placeId: "data:postgres:orders" }),
      ok({ op: "rows", placeId: "data:postgres:orders", table: "orders", search: "ship" }),
      ok({ op: "cacheKeys", placeId: "cache:lru:sessions" }),
      ok({ op: "cacheGet", placeId: "cache:lru:sessions", key: "b" }),
      ok({ op: "cacheKeys", placeId: `cache:redis:localhost:${redis.port}/0` }),
    ]);

  before(async () => {
    [ingest, redis] = await Promise.all([startIngest(), startRedis()]);
    dbDir = mkdtempSync(path.join(tmpdir(), "shrike-inspect-"));
    app = startApp({ NODE_OPTIONS: `--import=${register} --enable-source-maps`, SHRIKE_INGEST_URL: ingest.url, SHRIKE_TOKEN: "t", SHRIKE_PROJECT_ROOT: appDir, REDIS_PORT: String(redis.port), DB_DIR: dbDir });
    port = await app.port;
    responses = [];
    for (const s of STEPS) {
      responses.push(await get(port, s));
      if (s === "/session/a" && responses.length === 1) await waitFor(() => ingest.polls.length > 0); // the cache place is known from here
      await inspectAll().catch(() => {}); // interleaved, so any effect on the app would show in its responses
    }
    await waitFor(() => events().filter((e) => e.kind === "http_request").length === STEPS.length);
  });

  after(async () => {
    await stopApp(app);
    ingest?.server.close();
    redis?.server.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("the agent polls with its service and the places it holds", () => {
    const last = ingest.polls.at(-1);
    assert.equal(last.service, "service:inspect-test");
    for (const id of ["data:sqlite:shop.db", "data:sqlite::memory:", "data:postgres:orders", "cache:lru:sessions", `cache:redis:localhost:${redis.port}/0`]) assert.ok(last.places.includes(id), `${id} in ${last.places}`);
  });

  test("SQLite file and :memory:, read-only, sensitive columns masked", async () => {
    const t = await ok({ op: "tables", placeId: "data:sqlite:shop.db" });
    assert.equal(t.system, "sqlite");
    assert.match(t.how, /read-only connection/);
    assert.deepEqual(t.tables.map((x) => [x.name, x.rows]), [["users", 3]]);
    assert.deepEqual(t.tables[0].columns, [{ name: "id", pk: true }, { name: "name", pk: false }, { name: "password", pk: false }]);
    const users = await ok({ op: "rows", placeId: "data:sqlite:shop.db", table: "users" });
    assert.deepEqual(users.columns, ["id", "name", "password"]);
    assert.deepEqual(users.rows, [[1, "Ann", "[redacted]"], [2, "Bo", "[redacted]"], [3, "Cy", "[redacted]"]]);
    const mem = await ok({ op: "rows", placeId: "data:sqlite::memory:", table: "todos", orderBy: "id", desc: true });
    assert.match((await ok({ op: "tables", placeId: "data:sqlite::memory:" })).how, /in-memory/);
    assert.deepEqual(mem.rows, [[4, "four", 0], [2, "two", 1], [1, "one", 0]]);
    const found = await ok({ op: "rows", placeId: "data:sqlite::memory:", table: "todos", search: "ou" });
    assert.deepEqual([found.total, found.rows], [1, [[4, "four", 0]]]);
    const r = await ingest.ask({ op: "rows", placeId: "data:sqlite::memory:", table: "todos; DROP TABLE todos" });
    assert.equal(r.ok, false);
    assert.match(r.error, /no table called/);
  });

  test("PGlite inside a read-only transaction", async () => {
    const t = await ok({ op: "tables", placeId: "data:postgres:orders" });
    assert.equal(t.system, "postgres");
    assert.deepEqual(t.tables.map((x) => [x.name, x.rows]), [["orders", 3]]);
    const rows = await ok({ op: "rows", placeId: "data:postgres:orders", table: "orders", orderBy: "id" });
    assert.deepEqual(rows.rows, [[1, 100, "shipped"], [2, 250, "new"], [3, 30, "new"]]);
    const shipped = await ok({ op: "rows", placeId: "data:postgres:orders", table: "orders", search: "ship" });
    assert.equal(shipped.total, 1);
  });

  test("lru-cache: keys with previews and TTL, and peek never reorders", async () => {
    const order = await get(port, "/lru-order");
    const c = await ok({ op: "cacheKeys", placeId: "cache:lru:sessions" });
    assert.equal(c.system, "lru");
    assert.deepEqual(c.entries.map((e) => [e.key, e.preview]), [["a", "{ user: 'usera' }"], ["c", "{ user: 'userc' }"], ["b", "{ user: 'userb' }"]]);
    assert.ok(c.entries.every((e) => e.ttlMs > 0 && e.ttlMs <= 60_000));
    assert.equal((await ok({ op: "cacheGet", placeId: "cache:lru:sessions", key: "b" })).value, "{ user: 'userb' }");
    assert.equal(await get(port, "/lru-order"), order);
    assert.equal(order, `200 ["a","c","b"]`);
  });

  test("ioredis: a duplicate connection that only reads; secret-named keys masked", async () => {
    const before = redis.seen.length;
    const c = await ok({ op: "cacheKeys", placeId: `cache:redis:localhost:${redis.port}/0` });
    assert.equal(c.system, "redis");
    assert.deepEqual(c.entries.map((e) => [e.key, e.type, e.preview, e.ttlMs]), [["user:1", "string", "'Ann'", null], ["auth_token", "string", "[redacted]", null]]);
    const sent = new Set(redis.seen.slice(before));
    for (const cmd of sent) assert.ok(["SCAN", "TYPE", "TTL", "STRLEN", "GET", "INFO", "CLIENT", "SELECT"].includes(cmd), `unexpected ${cmd}`);
    assert.equal(redis.store.size, 2);
  });

  test("inspection never creates trip events", async () => {
    await new Promise((r) => setTimeout(r, 300));
    const n = events().length;
    await inspectAll();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(events().length, n);
  });

  test("I3: writes carry what they changed", () => {
    const change = (sql) => events().find((e) => e.kind === "db_query" && e.db.statement.startsWith(sql))?.change;
    assert.deepEqual(change("INSERT INTO todos (title) VALUES (?) RETURNING"), { table: "todos", op: "insert", count: 1, rows: [{ pk: "4", after: { id: 4, title: "four", done: 0 } }] });
    assert.deepEqual(change("UPDATE todos"), { table: "todos", op: "update", count: 1, rows: [{ pk: "2", before: { id: 2, title: "two", done: 0 }, after: { id: 2, title: "two", done: 1 } }] });
    assert.deepEqual(change("DELETE FROM todos"), { table: "todos", op: "delete", count: 1, rows: [{ pk: "3", before: { id: 3, title: "three", done: 0 } }] });
    const bad = events().find((e) => e.kind === "db_query" && e.db.statement === "INSERT INTO todos (title) VALUES (?)");
    assert.equal(bad.status, "error");
    assert.equal(bad.change, undefined, "a refused write changed nothing");
    assert.deepEqual(change("INSERT INTO users"), { table: "users", op: "insert", count: 1, rows: [{ pk: "3", after: { id: 3, name: "Cy", password: "[redacted]" } }] });
    assert.deepEqual(change("INSERT INTO orders"), { table: "orders", op: "insert", count: 1, rows: [{ pk: "3", after: { id: 3, amount: 30 } }] });
    assert.deepEqual(change("UPDATE orders"), { table: "orders", op: "update", count: 1, rows: [{ pk: "1", before: { id: 1, amount: 100, status: "new" }, after: { id: 1, amount: 100, status: "shipped" } }] });
    assert.equal(events().find((e) => e.db?.statement === "SELECT id, name FROM users ORDER BY id").change, undefined);
  });

  test("responses are byte-identical without the agent and without inspection", async () => {
    const plainDir = mkdtempSync(path.join(tmpdir(), "shrike-inspect-plain-"));
    redis.store.clear();
    redis.store.set("user:1", "Ann").set("auth_token", "abc");
    const plain = startApp({ REDIS_PORT: String(redis.port), DB_DIR: plainDir });
    try {
      const p = await plain.port;
      const out = [];
      for (const s of STEPS) out.push(await get(p, s));
      assert.deepEqual(out, responses);
    } finally {
      await stopApp(plain);
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

test("writeOf: the table, the op and a single-key WHERE", () => {
  assert.deepEqual(writeOf("INSERT INTO todos (title, user_id) VALUES (?, ?) RETURNING *"), { op: "insert", table: "todos", returning: true });
  assert.deepEqual(writeOf('UPDATE "todos" SET done = ? WHERE id = ?'), { op: "update", table: "todos", where: { col: "id", index: 1 }, returning: false });
  assert.deepEqual(writeOf("UPDATE orders SET status = $1 WHERE id = $2"), { op: "update", table: "orders", where: { col: "id", index: 1 }, returning: false });
  assert.deepEqual(writeOf("DELETE FROM main.todos WHERE id = ? AND done = 1"), { op: "delete", table: "todos", returning: false });
  assert.deepEqual(writeOf("INSERT OR REPLACE INTO profiles VALUES (7, 'Ann')"), { op: "insert", table: "profiles", returning: false });
  assert.equal(writeOf("SELECT * FROM todos"), undefined);
});
