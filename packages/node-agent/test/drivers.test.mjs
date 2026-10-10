// Driver hooks (docs/13 DB) against real databases: test/drivers/containers.sh up starts them on non-standard ports.
// Each route of test/drivers/app.mjs runs with node-agent and without; responses must match byte for byte, events
// must name the right place and statement, carry the write, and never the connection password.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "drivers");
const register = pathToFileURL(path.join(here, "..", "src", "register.mjs")).href;
const PW = "shrike-secret-pw";
const URLS = {
  PG_URL: `postgresql://postgres:${PW}@127.0.0.1:25432/shrike`,
  MYSQL_URL: `mysql://root:${PW}@127.0.0.1:23306/shrike`,
  REDIS_URL: `redis://:${PW}@127.0.0.1:26379/0`,
  MONGO_URL: "mongodb://127.0.0.1:27117/shrike",
};

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const up = (port) => new Promise((r) => net.connect(port, "127.0.0.1").on("connect", function () { this.destroy(); r(true); }).on("error", () => r(false)));

function body(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
}

// DynamoDB, PostgREST, Upstash and Neon's HTTP endpoint, just enough for each SDK.
function startFake() {
  const kv = new Map();
  const server = http.createServer(async (req, res) => {
      const text = await body(req);
      const send = (status, obj, type = "application/json") => res.writeHead(status, { "content-type": type }).end(JSON.stringify(obj));
      const target = req.headers["x-amz-target"];
      if (target) {
        const op = String(target).split(".")[1];
        return send(200, op === "GetItem" ? { Item: { id: { S: "o1" }, total: { N: "42" } } } : {}, "application/x-amz-json-1.0");
      }
      if (req.url.startsWith("/rest/v1/notes")) return req.method === "GET" ? send(200, [{ id: 1, title: "seeded" }]) : send(201, [{ id: 2, title: "new" }]);
      if (req.url.startsWith("/upstash")) {
        const sent = JSON.parse(text);
        const b64 = req.headers["upstash-encoding"] === "base64";
        const enc = (v) => (v == null || !b64 ? v : Buffer.from(String(v)).toString("base64"));
        const one = ([cmd, key, value]) => (String(cmd).toLowerCase() === "set" ? (kv.set(key, value), { result: enc("OK") }) : { result: enc(kv.get(key) ?? null) });
        return send(200, Array.isArray(sent[0]) ? sent.map(one) : one(sent));
      }
      if (req.url === "/sql") {
        const arrays = req.headers["neon-array-mode"] === "true";
        return send(200, { command: "SELECT", rowCount: 1, rows: arrays ? [[1]] : [{ one: 1 }], fields: [{ name: "one", dataTypeID: 23 }], rowAsArray: arrays });
      }
      send(404, {});
  });
  return listen(server).then((port) => ({ server, port }));
}

function startIngest() {
  const messages = [];
  const server = http.createServer(async (req, res) => {
    const text = await body(req);
    messages.push({ path: req.url, text, json: JSON.parse(text || "{}") });
    res.writeHead(req.url === "/inspect/poll" ? 404 : 200).end("{}");
  });
  return listen(server).then((port) => ({ server, messages, url: `http://127.0.0.1:${port}` }));
}

function startApp(env) {
  const child = spawn(process.execPath, [path.join(root, "app.mjs")], { cwd: root, env: { ...process.env, ...env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve({ child, port: Number(m[1]), stderr: () => err });
    });
    child.on("exit", (c) => reject(new Error(`app exited ${c}: ${err}`)));
  });
}

const get = (port, p) =>
  new Promise((resolve, reject) =>
    http.get({ host: "127.0.0.1", port, path: p, headers: { "user-agent": "curl/8" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    }).on("error", reject),
  );

const avail = {};
for (const [k, port] of [["pg", 25432], ["mysql", 23306], ["redis", 26379], ["mongo", 27117]]) avail[k] = await up(port);

describe("database driver hooks", () => {
  let ingest, fake, withAgent, plain, dir;
  const out = {};

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "shrike-drivers-"));
    ingest = await startIngest();
    fake = await startFake();
    const env = { ...URLS, FAKE_URL: `http://127.0.0.1:${fake.port}`, SQLITE_DIR: dir, DATABASE_URL: `file:${path.join(dir, "prisma.db")}` };
    // Prisma needs its client (generated once) and its table (pushed before either run).
    const prisma = (...args) => new Promise((r) => spawn(process.execPath, [path.join(here, "..", "node_modules", "prisma", "build", "index.js"), ...args, "--schema", path.join(root, "prisma", "schema.prisma")], { env: { ...process.env, ...env }, stdio: "ignore" }).on("exit", r));
    if (!existsSync(path.join(root, "prisma", "generated"))) await prisma("generate");
    await prisma("db", "push", "--skip-generate");
    plain = await startApp(env);
    withAgent = await startApp({ ...env, NODE_OPTIONS: `--import=${register}`, SHRIKE_INGEST_URL: ingest.url, SHRIKE_TOKEN: "t", SHRIKE_PROJECT_ROOT: root, SHRIKE_SERVICE: "api", NODE_ENV: "development" });
  });

  after(() => {
    withAgent?.child.kill();
    plain?.child.kill();
    ingest?.server.closeAllConnections();
    ingest?.server.close();
    fake?.server.closeAllConnections();
    fake?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const events = () => ingest.messages.flatMap((m) => m.json.events ?? []);

  async function run(route) {
    const a = await get(plain.port, route);
    const b = await get(withAgent.port, route);
    assert.equal(a.status, 200, `${route} without agent: ${a.body}`);
    assert.equal(b.body, a.body, `${route}: node-agent changed the response`);
    await new Promise((r) => setTimeout(r, 400));
    const root = events().filter((e) => e.kind === "http_request" && e.http?.url === route).at(-1);
    assert.ok(root, `${route}: no request event`);
    out[route] = events().filter((e) => e.traceId === root.traceId);
    return out[route];
  }

  const dbs = (evs, system) => evs.filter((e) => e.kind === "db_query" && e.db?.system === system);

  test("pg: Pool and Client, params, RETURNING, update, error, callback", { skip: !avail.pg && "postgres container not up" }, async () => {
    const evs = dbs(await run("/pg"), "postgres");
    assert.ok(evs.every((e) => e.place.id === "data:postgres:localhost:25432/shrike" && e.place.name === "POSTGRES · shrike"), JSON.stringify(evs.map((e) => e.place)));
    const ins = evs.find((e) => e.db.statement.startsWith("INSERT INTO notes (title, api_token)"));
    assert.match(ins.db.params, /'first'/);
    assert.deepEqual(ins.change, { table: "notes", op: "insert", count: 1, rows: [{ pk: "1", after: { id: 1, title: "first" } }] });
    const upd = evs.find((e) => e.db.statement.startsWith("UPDATE notes"));
    assert.deepEqual(upd.change.rows, [{ pk: "1", after: { id: 1, title: "renamed" } }]);
    assert.ok(evs.find((e) => e.db.statement.startsWith("SELECT title") && e.db.params === "[ 1 ]"), "callback query recorded");
    assert.equal(evs.find((e) => e.db.statement.includes("VALUES (NULL)")).status, "error");
    assert.equal(evs.find((e) => e.db.statement.startsWith("DELETE")).change.count, 1);
  });

  test("postgres.js", { skip: !avail.pg && "postgres container not up" }, async () => {
    const evs = dbs(await run("/postgresjs"), "postgres");
    const ins = evs.find((e) => /^INSERT INTO pjs/.test(e.db.statement));
    assert.equal(ins.place.id, "data:postgres:localhost:25432/shrike");
    assert.match(ins.db.statement, /VALUES \(\$1\) RETURNING/);
    assert.deepEqual(ins.change.rows, [{ pk: "1", after: { id: 1, name: "ada" } }]);
  });

  test("drizzle on pg", { skip: !avail.pg && "postgres container not up" }, async () => {
    const evs = dbs(await run("/drizzle"), "postgres");
    const ins = evs.find((e) => /^insert into "todo"/.test(e.db.statement));
    assert.ok(ins, evs.map((e) => e.db.statement).join("\n"));
    assert.equal(ins.change.op, "insert");
    assert.equal(ins.change.rows[0].after.text, "buy milk");
    assert.ok(evs.some((e) => /^select .* from "todo"/.test(e.db.statement)));
    assert.deepEqual([ins.source?.file, ins.source?.precision], ["app.mjs", "approximate"], "a lazy builder's query falls back to the enclosing function");
  });

  test("mysql2 promise pool: execute, query, insertId", { skip: !avail.mysql && "mysql container not up" }, async () => {
    const evs = dbs(await run("/mysql"), "mysql");
    assert.ok(evs.every((e) => e.place.id === "data:mysql:localhost:23306/shrike"));
    const ins = evs.find((e) => e.db.statement.startsWith("INSERT INTO users"));
    assert.deepEqual(ins.change, { table: "users", op: "insert", count: 1, rows: [{ pk: "1", after: { id: 1, firstName: "Ada", password: "[redacted]" } }] });
    assert.doesNotMatch(JSON.stringify(ins), /hunter2/);
    assert.equal(evs.find((e) => e.db.statement.startsWith("UPDATE users")).change.count, 1);
  });

  test("sequelize on mysql2", { skip: !avail.mysql && "mysql container not up" }, async () => {
    const evs = dbs(await run("/sequelize"), "mysql");
    const ins = evs.find((e) => /^INSERT INTO `instruments`/.test(e.db.statement));
    assert.ok(ins, evs.map((e) => e.db.statement).join("\n"));
    assert.equal(ins.change.count, 1);
  });

  test("mongodb driver: insert, update, find, count", { skip: !avail.mongo && "mongo container not up" }, async () => {
    const evs = dbs(await run("/mongo"), "mongodb");
    assert.ok(evs.length >= 4, JSON.stringify(evs.map((e) => e.name)));
    assert.ok(evs.every((e) => e.place.id === "data:mongodb:localhost:27117/shrike"));
    const ins = evs.find((e) => e.db.statement === "db.users.insertMany()");
    assert.equal(ins.change.op, "insert");
    assert.equal(ins.change.rows[0].after.password, "[redacted]");
    assert.equal(evs.find((e) => e.db.statement === "db.users.update()").change.count, 1);
    assert.match(evs.find((e) => e.db.statement === "db.users.find()").db.params, /ada@example.com/);
    assert.equal(evs.find((e) => e.db.statement === "db.users.countDocuments()")?.returned, "1", JSON.stringify(evs.map((e) => e.name)));
  });

  test("mongoose", { skip: !avail.mongo && "mongo container not up" }, async () => {
    const evs = dbs(await run("/mongoose"), "mongodb");
    assert.ok(evs.some((e) => e.db.statement === "db.tokens.insertMany()" && e.change?.count === 1), JSON.stringify(evs.map((e) => e.name)));
    assert.ok(evs.some((e) => e.db.statement === "db.tokens.find()"));
  });

  test("mongodb 3.x driver (mongoose 5)", { skip: !avail.mongo && "mongo container not up" }, async () => {
    const evs = dbs(await run("/mongo3"), "mongodb");
    for (const coll of ["unified", "legacy"]) {
      assert.ok(evs.some((e) => e.db.statement === `db.${coll}.insertMany()` && e.change?.count === 1), JSON.stringify(evs.map((e) => e.name)));
      assert.ok(evs.some((e) => e.db.statement === `db.${coll}.find()` && e.place.id === "data:mongodb:localhost:27117/shrike"), JSON.stringify(evs.map((e) => e.place.id)));
    }
  });

  test("node-redis v5+ and v4", { skip: !avail.redis && "redis container not up" }, async () => {
    const ops = (await run("/redis")).filter((e) => e.kind === "cache_op");
    assert.ok(ops.every((e) => e.place.id === "cache:redis:localhost:26379/0"), JSON.stringify(ops.map((e) => e.place)));
    assert.equal(ops.find((e) => e.name === "GET todos:1").cache.hit, true);
    assert.equal(ops.find((e) => e.name === "GET todos:nope").cache.hit, false);
    assert.ok(ops.find((e) => e.name === "JSON.SET todos:2"), ops.map((e) => e.name).join(", "));
    const v4 = (await run("/redis4")).filter((e) => e.kind === "cache_op");
    assert.ok(v4.some((e) => e.name === "SET v4:key") && v4.some((e) => e.name === "GET v4:key" && e.cache.hit), v4.map((e) => e.name).join(", "));
  });

  test("better-sqlite3 and libsql", async () => {
    const evs = dbs(await run("/sqlite"), "sqlite");
    const ins = evs.find((e) => e.db.statement.startsWith("INSERT INTO items"));
    assert.equal(ins.place.id, "data:sqlite:bs3.db");
    assert.deepEqual(ins.change.rows, [{ pk: "1", after: { id: 1, name: "pen" } }]);
    assert.deepEqual(evs.find((e) => e.db.statement.startsWith("UPDATE")).change.rows[0].after, { id: 1, name: "pencil" });
    const lib = dbs(await run("/libsql"), "sqlite");
    const li = lib.find((e) => e.db.statement.startsWith("INSERT INTO tags"));
    assert.equal(li?.place.id, "data:sqlite:libsql.db", lib.map((e) => e.db.statement).join("\n"));
    assert.equal(li.change.rows[0].after.label, "red");
  });

  test("prisma (library engine, sqlite)", async () => {
    const evs = dbs(await run("/prisma"), "sqlite");
    const ins = evs.find((e) => /^INSERT INTO `main`.`notes`/.test(e.db.statement));
    assert.ok(ins, evs.map((e) => e.db.statement).join("\n"));
    assert.equal(ins.place.id, "data:sqlite:prisma.db");
    assert.equal(ins.source?.file, "app.mjs", "the lazy PrismaPromise's query still has a source");
    const ups = evs.find((e) => e.change?.table === "prisma_tags");
    assert.match(ups.db.statement, /^INSERT INTO `main`.`prisma_tags`[^\n]*;\nSELECT/, "the write leads a multi-statement call");
    const after = ins.change.rows[0].after;
    assert.match(after.createdAt, /^\d{4}-\d\d-\d\dT/, "typed values are unwrapped");
    assert.deepEqual(after, { id: after.id, title: "hello", body: "world", createdAt: after.createdAt });
    assert.equal(ins.change.table, "notes");
    const upd = evs.find((e) => /^UPDATE/.test(e.db.statement));
    assert.equal(upd.change.op, "update");
    assert.equal(upd.change.rows[0].after.title, "bye");
    assert.ok(evs.some((e) => /^SELECT/.test(e.db.statement)));
    assert.deepEqual(evs.filter((e) => !/^(SELECT|INSERT|UPDATE|DELETE)/.test(e.db.statement)).map((e) => e.name), [], "concurrent calls each keep their own SQL");
    assert.doesNotMatch(evs.find((e) => /prisma_tags/.test(e.db.statement))?.db.statement ?? "", /COUNT/);
  });

  test("dynamodb client and document client", async () => {
    const evs = dbs(await run("/dynamo"), "dynamodb");
    assert.deepEqual(evs.map((e) => e.name), ["PutItem orders", "GetItem orders", "Put orders"]);
    assert.ok(evs.every((e) => e.place.id.startsWith("data:dynamodb:localhost:")), JSON.stringify(evs.map((e) => e.place)));
    assert.deepEqual(evs[0].change, { table: "orders", op: "insert", count: 1, rows: [{ pk: "o1", after: { id: "o1", total: 42 } }] });
    assert.deepEqual(evs[2].change.rows[0].after, { id: "o2", total: 7 });
    assert.ok(!events().some((e) => e.kind === "external_call" && e.traceId === evs[0].traceId), "the SDK's HTTP call is not a second event");
  });

  test("supabase-js PostgREST calls land on the Supabase data lane", async () => {
    const evs = await run("/supabase");
    const q = evs.filter((e) => e.kind === "db_query");
    assert.equal(q[0].name, "SELECT id,title FROM notes WHERE id = $1");
    assert.equal(q[0].place.id.startsWith("data:supabase:localhost:"), true);
    assert.equal(q[0].db.params, "[ '1' ]");
    assert.deepEqual(q[1].change, { table: "notes", op: "insert", count: 1, rows: [{ pk: "2", after: { id: 2, title: "new" } }] });
    assert.ok(!evs.some((e) => e.kind === "external_call"));
  });

  test("upstash and neon over HTTP", async () => {
    const up = (await run("/upstash")).filter((e) => e.kind === "cache_op");
    assert.deepEqual(up.map((e) => e.name), ["SET session:abc", "GET session:abc"], JSON.stringify(up.map((e) => e.name)));
    assert.equal(up[1].cache.hit, true);
    const ne = dbs(await run("/neon"), "postgres");
    assert.equal(ne[0].place.id, "data:postgres:ep-x.neon.tech:5432/neondb");
    assert.match(ne[0].db.statement, /SELECT \$1::int AS one/);
  });

  test("no connection secrets anywhere, no secret column values in database events", () => {
    const all = ingest.messages.map((m) => m.text).join("\n");
    for (const s of [PW, "neon-secret-pw", "anon-key-123", "up-token"]) assert.ok(!all.includes(s), `${s} leaked`);
    // The app's own response bodies may carry them (main redacts those); the database events must not.
    const data = JSON.stringify(events().filter((e) => e.kind === "db_query" || e.kind === "cache_op"));
    for (const s of ["hunter2", "tok-123"]) assert.ok(!data.includes(s), `${s} leaked in a database event`);
  });
});

test("supabase auth from the server joins the Supabase lane, in words main won't mask", async () => {
  const { reclassify } = await import("../src/drivers/http.mjs");
  const { redactEvent } = await import("../../redact/src/index.ts");
  const call = (url, headers) => reclassify({ id: "e", traceId: "t", origin: "server", kind: "external_call", name: url, startMs: 1, status: "ok", http: { method: "GET", url, status: 200, reqHeaders: headers } });
  const keys = call("http://127.0.0.1:15421/auth/v1/.well-known/jwks.json", { apikey: "sb_publishable_x" });
  assert.equal(keys.kind, "db_query");
  assert.equal(keys.place.id, "data:supabase:localhost:15421");
  assert.equal(keys.db.statement, "read the signing keys (auth)");
  assert.equal(redactEvent(keys).db.statement, keys.db.statement);
  assert.equal(call("http://127.0.0.1:15421/auth/v1/token?grant_type=password", { apikey: "k" }).db.statement, "sign in with password (auth)");
  assert.equal(call("http://localhost:4000/auth/v1/user", {}).kind, "external_call", "an app's own /auth/v1 without Supabase headers stays a call");
});
