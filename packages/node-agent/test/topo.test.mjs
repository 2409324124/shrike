// Two instrumented services (api -> auth), an outside host, ioredis, lru-cache, PGlite and node:sqlite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callerFromRequest, hostLabel, serviceName } from "../src/place.mjs";
import { safeKey } from "../src/cache.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "topo");
const register = pathToFileURL(path.join(here, "..", "src", "register.mjs")).href;

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

function startIngest() {
  const messages = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      messages.push(JSON.parse(body));
      res.end("{}");
    });
  });
  return listen(server).then((port) => ({ server, messages, url: `http://127.0.0.1:${port}` }));
}

// Just enough RESP for ioredis: arrays of bulk strings in, GET/SET/DEL/INFO out.
function startRedis() {
  const store = new Map();
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const args = [];
        let i = buf.indexOf("\r\n");
        if (buf[0] !== 0x2a || i < 0) break;
        const n = Number(buf.subarray(1, i).toString());
        let pos = i + 2;
        for (let k = 0; k < n; k++) {
          const j = buf.indexOf("\r\n", pos);
          if (j < 0) break;
          const len = Number(buf.subarray(pos + 1, j).toString());
          if (buf.length < j + 2 + len + 2) break;
          args.push(buf.subarray(j + 2, j + 2 + len).toString());
          pos = j + 2 + len + 2;
        }
        if (args.length < n) break;
        buf = buf.subarray(pos);
        const [cmd, key, value] = [args[0].toUpperCase(), args[1], args[2]];
        const bulk = (s) => (s === undefined ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
        if (cmd === "GET") sock.write(bulk(store.get(key)));
        else if (cmd === "SET") sock.write((store.set(key, value), "+OK\r\n"));
        else if (cmd === "DEL") sock.write(`:${store.delete(key) ? 1 : 0}\r\n`);
        else if (cmd === "INFO") sock.write(bulk("# Server\r\nloading:0\r\n"));
        else sock.write("+OK\r\n");
      }
    });
  });
  return listen(server).then((port) => ({ server, port, store }));
}

// Stands in for Stripe: a host Shrike doesn't instrument.
function startStripe() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, traceparent: req.headers.traceparent });
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/ping") return void res.end("pong");
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "amount must be at least 50 cents" } }));
    });
  });
  return listen(server).then((port) => ({ server, port, seen }));
}

function startApp(dir, env) {
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: path.join(root, dir),
    env: { ...process.env, NODE_OPTIONS: "", SHRIKE_INGEST_URL: "", SHRIKE_SERVICE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const port = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = /listening (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`${dir} exited ${code}: ${stderr}`)));
  });
  return { child, port };
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null) return;
  const exited = new Promise((r) => app.child.once("exit", r));
  app.child.kill();
  await exited;
}

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

async function get(port, url, headers) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

const exercise = async (port) => [
  await get(port, "/api/session/7", { traceparent: `00-${TRACE}-${SPAN}-01` }),
  await get(port, "/api/session/7", { "user-agent": "curl/8.4.0" }),
  await get(port, "/api/profile/7"),
  await get(port, "/api/profile/7"),
  await get(port, "/api/pay/30"),
  await get(port, "/api/ping"),
  await get(port, "/api/down"),
];

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out waiting for events");
}

describe("places across services", () => {
  let ingest, redis, stripe, auth, api, dbDir, responses, plainEnv;
  let events = [];
  const of = (service) => events.filter((e) => e.place?.id === `service:${service}`);
  const serverReq = (service, url) => of(service).filter((e) => e.kind === "http_request" && e.http.url.startsWith(url));

  before(async () => {
    [ingest, redis, stripe] = await Promise.all([startIngest(), startRedis(), startStripe()]);
    dbDir = mkdtempSync(path.join(tmpdir(), "shrike-topo-"));
    const agent = { NODE_OPTIONS: `--import=${register} --enable-source-maps`, SHRIKE_INGEST_URL: ingest.url, SHRIKE_TOKEN: "t", SHRIKE_PROJECT_ROOT: root };
    auth = startApp("auth", agent);
    const authPort = await auth.port;
    plainEnv = { STRIPE_URL: `http://127.0.0.1:${stripe.port}`, REDIS_PORT: String(redis.port), DB_DIR: dbDir };
    api = startApp("api", { ...agent, ...plainEnv, SHRIKE_SERVICE: "api", AUTH_URL: `http://127.0.0.1:${authPort}` });
    responses = await exercise(await api.port);
    const all = () => ingest.messages.flatMap((m) => (m.type === "events" ? m.events : []));
    await waitFor(() => all().filter((e) => e.kind === "http_request").length === 9 && all().filter((e) => e.kind === "external_call").length === 5);
    events = all();
  });

  after(async () => {
    await Promise.all([stopApp(api), stopApp(auth)]);
    for (const s of [ingest?.server, redis?.server, stripe?.server]) s?.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("every event names its place; hello carries the service", () => {
    const allowed = new Set(["service:api", "service:auth", "data:sqlite:profiles.db", "data:postgres:memory", `cache:redis:localhost:${redis.port}/0`, "cache:lru:sessions"]);
    for (const e of events) {
      assert.ok(e.place, `${e.kind} ${e.name} has no place`);
      if (e.kind === "external_call") assert.equal(e.place.kind, "outside");
      else assert.ok(allowed.has(e.place.id), `unexpected place ${e.place.id} on ${e.kind} ${e.name}`);
    }
    const hellos = ingest.messages.filter((m) => m.type === "hello");
    const apiHellos = hellos.filter((m) => m.place.id === "service:api");
    assert.deepEqual(apiHellos[0].place, { kind: "service", id: "service:api", name: "API" });
    const listened = apiHellos.find((m) => m.url);
    assert.match(listened.url, /^http:\/\/localhost:\d+$/);
    assert.equal(listened.place.detail, listened.url.slice("http://".length));
    assert.ok(hellos.some((m) => m.place.id === "service:auth" && m.place.name === "AUTH"), "auth named from its package.json");
    assert.equal(serverReq("api", "/api/session")[0].place.detail, listened.place.detail);
  });

  test("api -> auth continues the same trace", () => {
    const [first] = serverReq("api", "/api/session");
    assert.equal(first.traceId, TRACE);
    assert.equal(first.parentId, SPAN);
    assert.equal(first.caller, undefined);
    const call = events.find((e) => e.kind === "external_call" && e.traceId === TRACE);
    assert.match(call.name, /^GET localhost:\d+\/verify$/);
    assert.equal(call.http.status, 200);
    assert.equal(call.place.id, `outside:${call.place.detail}`);
    const fn = events.find((e) => e.id === call.parentId);
    assert.equal(fn.kind, "function");
    assert.equal(fn.place.id, "service:api");
    assert.equal(call.http.reqHeaders.traceparent, `00-${TRACE}-${call.id}-01`);
    const authReq = serverReq("auth", "/verify").find((e) => e.traceId === TRACE);
    assert.ok(authReq, "auth's request joined the trace");
    assert.equal(authReq.parentId, call.id);
    assert.equal(authReq.caller, undefined);
  });

  test("lru-cache: miss then set, then a hit, labelled by variable", () => {
    const [a, b] = serverReq("auth", "/verify");
    const ops = (trace) => events.filter((e) => e.kind === "cache_op" && e.traceId === trace).map((e) => [e.name, e.cache.hit]);
    assert.deepEqual(ops(a.traceId), [["GET 7", false], ["SET 7", undefined]]);
    assert.deepEqual(ops(b.traceId), [["GET 7", true]]);
    const hit = events.find((e) => e.kind === "cache_op" && e.cache.hit && e.traceId === b.traceId);
    assert.deepEqual(hit.place, { kind: "cache", id: "cache:lru:sessions", name: "LRU · sessions" });
    assert.equal(hit.source.file, "auth/server.ts");
    assert.equal(hit.returned, "{ user: 'user7' }");
  });

  test("curl is the caller when no browser started the trip", () => {
    const [, second] = serverReq("api", "/api/session");
    assert.equal(second.caller.kind, "curl");
    assert.match(second.caller.command, /^curl 'http:\/\/127\.0\.0\.1:\d+\/api\/session\/7'$/);
    const [plain] = serverReq("api", "/api/profile");
    assert.deepEqual(plain.caller, { kind: "other", label: "node" });
  });

  test("ioredis: GET miss, SET, GET hit; sqlite fills the miss", () => {
    const [miss, hit] = serverReq("api", "/api/profile");
    const kinds = (trace) => events.filter((e) => e.traceId === trace && (e.kind === "cache_op" || e.kind === "db_query")).sort((x, y) => x.startMs - y.startMs);
    const first = kinds(miss.traceId);
    assert.deepEqual(first.map((e) => [e.kind, e.name, e.cache?.hit]), [
      ["cache_op", "GET profile:7", false],
      ["db_query", "SELECT id, name FROM profiles WHERE id = ?", undefined],
      ["cache_op", "SET profile:7", undefined],
    ]);
    assert.deepEqual(first[0].place, { kind: "cache", id: `cache:redis:localhost:${redis.port}/0`, name: "REDIS", detail: `localhost:${redis.port}/0` });
    assert.deepEqual(first[1].place, { kind: "data", id: "data:sqlite:profiles.db", name: "SQLITE · profiles.db" });
    assert.equal(first[0].source.file, "api/server.ts");
    const second = kinds(hit.traceId);
    assert.deepEqual(second.map((e) => [e.name, e.cache?.hit]), [["GET profile:7", true]]);
    assert.equal(second[0].returned, `'{"id":7,"name":"Ann"}'`);
  });

  test("PGlite query and the outside refusal", () => {
    const [req] = serverReq("api", "/api/pay");
    const q = events.find((e) => e.kind === "db_query" && e.traceId === req.traceId);
    assert.equal(q.db.system, "postgres");
    assert.equal(q.db.statement, "INSERT INTO orders (amount) VALUES ($1)");
    assert.equal(q.db.params, "[ 30 ]");
    assert.deepEqual(q.place, { kind: "data", id: "data:postgres:memory", name: "POSTGRES · memory" });
    const call = events.find((e) => e.kind === "external_call" && e.traceId === req.traceId);
    assert.equal(call.name, `POST localhost:${stripe.port}/v1/charges`);
    assert.equal(call.status, "error");
    assert.equal(call.http.status, 400);
    assert.equal(call.http.reqBody, '{"amount":30}');
    assert.match(call.http.resBody, /amount must be at least 50 cents/);
    assert.deepEqual(call.place, { kind: "outside", id: `outside:localhost:${stripe.port}`, name: `LOCALHOST:${stripe.port}`, detail: `localhost:${stripe.port}` });
    assert.equal(call.source.file, "api/server.ts");
    assert.ok(call.durationMs > 0);
  });

  test("http.get is recorded and carries traceparent; network failures are errors", () => {
    const [req] = serverReq("api", "/api/ping");
    const call = events.find((e) => e.kind === "external_call" && e.traceId === req.traceId);
    assert.equal(call.http.status, 200);
    assert.equal(call.http.resBody, "pong");
    assert.equal(stripe.seen.find((s) => s.url === "/v1/ping").traceparent, `00-${req.traceId}-${call.id}-01`);
    const [down] = serverReq("api", "/api/down");
    const fail = events.find((e) => e.kind === "external_call" && e.traceId === down.traceId);
    assert.equal(fail.status, "error");
    assert.equal(fail.http.status, undefined);
    assert.ok(fail.error.message);
  });

  test("the ingest's own calls are never recorded", () => {
    assert.ok(!events.some((e) => e.http?.url?.includes("/ingest")));
  });

  test("responses are byte-identical without the agent", async () => {
    redis.store.clear();
    const plainAuth = startApp("auth", {});
    let plainApi;
    try {
      plainApi = startApp("api", { ...plainEnv, AUTH_URL: `http://127.0.0.1:${await plainAuth.port}` });
      assert.deepEqual(await exercise(await plainApi.port), responses);
    } finally {
      await Promise.all([stopApp(plainApi), stopApp(plainAuth)]);
    }
  });
});

test("caller detection, host labels, service names, key redaction", () => {
  const c = (ua) => callerFromRequest({ "user-agent": ua }, "GET", "/x");
  assert.equal(c("PostmanRuntime/7.36.0").kind, "postman");
  assert.equal(c("shrike-explorer/1").kind, "explorer");
  assert.deepEqual(c("node"), { kind: "other", label: "node" });
  assert.deepEqual(c("node-fetch/1.0"), { kind: "other", label: "node-fetch" });
  assert.deepEqual(c(""), { kind: "other", label: "unknown" });
  assert.equal(c("Mozilla/5.0").kind, "browser");
  const curl = callerFromRequest({ "user-agent": "curl/8", host: "localhost:4100", "content-type": "application/json" }, "POST", "/api/pay", '{"a":1}');
  assert.equal(curl.command, `curl -X POST 'http://localhost:4100/api/pay' -H 'content-type: application/json' -d '{"a":1}'`);
  assert.equal(hostLabel("api.stripe.com"), "STRIPE");
  assert.equal(hostLabel("hooks.slack.com"), "SLACK");
  assert.equal(hostLabel("localhost:4199"), "LOCALHOST:4199");
  assert.equal(hostLabel("10.0.0.2:80"), "10.0.0.2:80");
  assert.equal(serviceName({ SHRIKE_SERVICE: "worker" }), "worker");
  assert.equal(serviceName({}, path.join(root, "auth", "server.ts")), "auth");
  assert.equal(safeKey("session:91"), "session:91");
  assert.equal(safeKey("session:9f8a7b6c5d4e3f2a1b0c"), "session:[redacted]");
  assert.equal(safeKey("todos:3f1c2b9e-8a7d-4c6b-9e2f-1a2b3c4d5e6f"), "todos:3f1c2b9e-8a7d-4c6b-9e2f-1a2b3c4d5e6f", "a UUID record id stays visible");
});
