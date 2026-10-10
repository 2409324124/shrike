import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "app");
const register = pathToFileURL(path.join(here, "..", "src", "register.mjs")).href;

const lineOf = (file, text) => {
  const lines = readFileSync(path.join(appDir, file), "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(text));
  assert.ok(i >= 0, `${text} not found in ${file}`);
  return i + 1;
};

function startIngest() {
  const messages = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      messages.push({ token: req.headers["x-shrike-token"], url: req.url, message: JSON.parse(body) });
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, messages, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

function startApp(env) {
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: appDir,
    env: { ...process.env, NODE_OPTIONS: "", SHRIKE_INGEST_URL: "", PORT: "0", ...env },
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
    child.on("exit", (code) => reject(new Error(`app exited ${code}: ${stderr}`)));
  });
  return { child, port };
}

async function stopApp(app) {
  if (app.child.exitCode !== null) return;
  const exited = new Promise((r) => app.child.once("exit", r));
  app.child.kill();
  await exited;
}

async function request(port, method, url, { body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, body, headers });
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";

async function exercise(port) {
  return [
    await request(port, "POST", "/__nextjs_original-stack-frames"),
    await request(port, "GET", "/api/hello", { headers: { traceparent: `00-${TRACE}-${SPAN}-01` } }),
    await request(port, "POST", "/api/todos", {
      body: JSON.stringify({ title: "buy milk", userId: 1 }),
      headers: { "content-type": "application/json" },
    }),
    await request(port, "GET", "/api/calc"),
    await request(port, "GET", "/api/fail"),
    await request(port, "GET", "/api/missing"),
  ];
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out waiting for events");
}

describe("node-agent end to end", () => {
  let ingest;
  let app;
  let responses;
  let events = [];
  const agentEnv = () => ({
    NODE_OPTIONS: `--import=${register} --enable-source-maps`,
    SHRIKE_INGEST_URL: ingest.url,
    SHRIKE_TOKEN: "tok-123",
    SHRIKE_PROJECT_ROOT: appDir,
  });
  const byName = (name, traceId) => events.filter((e) => e.name === name && (!traceId || e.traceId === traceId));
  const one = (name, traceId) => {
    const found = byName(name, traceId);
    assert.equal(found.length, 1, `expected one ${name}, got ${found.length}`);
    return found[0];
  };
  const httpEvent = (name) => one(name);

  before(async () => {
    ingest = await startIngest();
    app = startApp(agentEnv());
    responses = await exercise(await app.port);
    const all = () => ingest.messages.flatMap((m) => (m.message.type === "events" ? m.message.events : []));
    await waitFor(() => all().filter((e) => e.kind === "http_request").length === 5);
    events = all();
  });

  after(async () => {
    if (app) await stopApp(app);
    ingest?.server.close();
  });

  test("says hello with the token header", async () => {
    const env = await request(await app.port, "GET", "/api/env");
    assert.deepEqual(JSON.parse(env.body), { shrike: true, patched: true });
    const hello = ingest.messages.find((m) => m.message.type === "hello");
    assert.ok(hello);
    assert.equal(hello.message.source, "server");
    assert.equal(hello.message.pid, app.child.pid);
    assert.equal(hello.url, "/ingest");
    assert.ok(ingest.messages.every((m) => m.token === "tok-123"));
  });

  test("http_request uses the propagated trace context", () => {
    const hello = httpEvent("GET /api/hello");
    assert.equal(hello.traceId, TRACE);
    assert.equal(hello.parentId, SPAN);
    assert.equal(hello.origin, "server");
    assert.equal(hello.http.status, 200);
    assert.equal(hello.http.resBody, JSON.stringify({ message: "hello user7" }));
    assert.match(hello.id, /^[\da-f]{16}$/);

    const post = httpEvent("POST /api/todos");
    assert.notEqual(post.traceId, TRACE);
    assert.match(post.traceId, /^[\da-f]{32}$/);
    assert.equal(post.parentId, undefined);
    assert.equal(post.status, "error");
    assert.equal(post.http.status, 500);
    assert.equal(post.http.method, "POST");
    assert.equal(post.http.reqBody, JSON.stringify({ title: "buy milk", userId: 1 }));
    assert.equal(post.http.resBody, JSON.stringify({ error: "NOT NULL constraint failed: todos.user_id" }));
    assert.equal(post.http.reqHeaders["content-type"], "application/json");
    assert.equal(post.http.resHeaders["content-type"], "application/json");

    assert.equal(httpEvent("GET /api/missing").http.status, 404);
  });

  test("function events nest by parentId with exact lines and call sites", () => {
    const req = httpEvent("GET /api/hello");
    const route = one("GET /api/hello()", TRACE);
    const greet = one("greet()", TRACE);
    const load = one("loadName()", TRACE);
    const listener = events.find((e) => e.id === route.parentId);
    assert.equal(listener.kind, "function");
    assert.equal(listener.parentId, req.id);
    assert.equal(greet.parentId, route.id);
    assert.equal(load.parentId, greet.id);

    assert.deepEqual(greet.source, {
      file: "logic.ts",
      line: lineOf("logic.ts", "export async function greet"),
      column: 8,
      functionName: "greet",
      precision: "exact",
    });
    assert.equal(load.source.line, lineOf("logic.ts", "export async function loadName"));
    assert.deepEqual(
      { file: load.callSite.file, line: load.callSite.line },
      { file: "logic.ts", line: lineOf("logic.ts", "await loadName(id)") },
    );
    assert.deepEqual(
      { file: greet.callSite.file, line: greet.callSite.line },
      { file: "server.ts", line: lineOf("server.ts", "await greet(7)") },
    );
    assert.deepEqual(load.args, ["7"]);
    assert.equal(load.returned, "'user7'");
    assert.equal(greet.returned, "'hello user7'");
    assert.ok(load.durationMs >= 1.5, `loadName took ${load.durationMs}ms`);
    assert.ok(greet.durationMs >= load.durationMs);
    assert.ok(req.durationMs >= greet.durationMs);
    assert.ok(greet.startMs <= load.startMs);
  });

  test("the planted bug: args preview, db error, log line", () => {
    const post = httpEvent("POST /api/todos");
    const create = one("createTodo()", post.traceId);
    const insert = one("insertTodo()", post.traceId);
    assert.equal(create.source.line, lineOf("server.ts", "async function createTodo("));
    assert.equal(create.args[0], "req { POST /api/todos }");
    assert.equal(create.args[1], "res");
    assert.equal(create.status, "ok");

    assert.equal(insert.parentId, create.id);
    assert.deepEqual(insert.args, ["{ title: 'buy milk', userId: undefined }"]);
    assert.equal(insert.source.file, "db.ts");
    assert.equal(insert.source.line, lineOf("db.ts", "export function insertTodo"));
    assert.equal(insert.callSite.file, "server.ts");
    assert.equal(insert.callSite.line, lineOf("server.ts", "insertTodo({ title, userId: body.user })"));
    assert.equal(insert.status, "error");
    assert.equal(insert.error.message, "NOT NULL constraint failed: todos.user_id");

    const query = events.find((e) => e.kind === "db_query" && e.traceId === post.traceId);
    assert.equal(query.origin, "db");
    assert.equal(query.parentId, insert.id);
    assert.equal(query.db.system, "sqlite");
    assert.equal(query.db.statement, "INSERT INTO todos (title, user_id) VALUES (?, ?)");
    assert.equal(query.name, "INSERT INTO todos (title, user_id) VALUES (?, ?)");
    assert.equal(query.db.params, "[ 'buy milk', null ]");
    assert.equal(query.status, "error");
    assert.equal(query.error.message, "NOT NULL constraint failed: todos.user_id");
    assert.deepEqual(
      { file: query.source.file, line: query.source.line },
      { file: "db.ts", line: lineOf("db.ts", 'db.prepare("INSERT') },
    );

    const log = events.find((e) => e.kind === "log" && e.traceId === post.traceId);
    assert.equal(log.log.level, "info");
    assert.equal(log.log.message, "creating todo { title: 'buy milk' }");
    assert.equal(log.parentId, create.id);
    assert.deepEqual(
      { file: log.source.file, line: log.source.line },
      { file: "server.ts", line: lineOf("server.ts", 'console.log("creating todo"') },
    );
  });

  test("destructuring arrows, class methods, no constructors", () => {
    const sum = one("sum()");
    assert.deepEqual(sum.args, ["{ a: 2, b: 3 }"]);
    assert.equal(sum.returned, "5");
    assert.equal(sum.source.line, lineOf("logic.ts", "export const sum"));
    const scale = one("Calc.scale()");
    assert.deepEqual(scale.args, ["4"]);
    assert.equal(scale.returned, "12");
    assert.equal(scale.source.line, lineOf("logic.ts", "scale(n: number)"));
    assert.equal(byName("Calc.constructor()").length, 0);
  });

  test("errors propagate up the async chain", () => {
    const req = httpEvent("GET /api/fail");
    const risky = one("risky()", req.traceId);
    const job = one("runJob()", req.traceId);
    const route = one("GET /api/fail()", req.traceId);
    assert.equal(risky.parentId, job.id);
    assert.equal(job.parentId, route.id);
    assert.equal(risky.status, "error");
    assert.equal(risky.error.message, "too big: 5");
    assert.equal(risky.error.type, "Error");
    assert.equal(job.status, "error");
    assert.equal(job.error.message, "too big: 5");
    assert.equal(route.status, "ok");
    assert.equal(req.status, "error");
  });

  test("the dev server's own endpoints are not trips", () => {
    assert.ok(!events.some((e) => e.http?.url?.startsWith("/__nextjs_")));
  });

  test("logs outside a request use the zero trace", () => {
    const log = events.find((e) => e.kind === "log" && e.log.message.startsWith("listening"));
    assert.equal(log.traceId, "0".repeat(32));
    assert.equal(log.parentId, undefined);
    assert.equal(log.source.line, lineOf("server.ts", "console.log(`listening"));
  });

  test("events are well formed", () => {
    for (const e of events) {
      assert.match(e.id, /^[\da-f]{16}$/);
      assert.match(e.traceId, /^[\da-f]{32}$/);
      assert.equal(typeof e.startMs, "number");
      assert.ok(["ok", "error", "slow"].includes(e.status));
    }
  });

  test("responses are byte-identical without the agent", async () => {
    const plain = startApp({});
    try {
      assert.deepEqual(await exercise(await plain.port), responses);
      const env = await request(await plain.port, "GET", "/api/env");
      assert.deepEqual(JSON.parse(env.body), { shrike: false, patched: false });
    } finally {
      await stopApp(plain);
    }
  });

  for (const [label, env] of [
    ["argv[1] is outside the project root", () => ({ SHRIKE_PROJECT_ROOT: mkdtempSync(path.join(tmpdir(), "shrike-")) })],
    ["NODE_ENV is production", () => ({ NODE_ENV: "production" })],
  ]) {
    test(`inert when ${label}`, async () => {
      const extra = env();
      const token = `inert-${Math.random()}`;
      const inert = startApp({ ...agentEnv(), SHRIKE_TOKEN: token, ...extra });
      try {
        const res = await request(await inert.port, "GET", "/api/env");
        assert.deepEqual(JSON.parse(res.body), { shrike: false, patched: false });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(ingest.messages.filter((m) => m.token === token).length, 0);
      } finally {
        await stopApp(inert);
        if (extra.SHRIKE_PROJECT_ROOT) rmSync(extra.SHRIKE_PROJECT_ROOT, { recursive: true });
      }
    });
  }
});

test("previews drop the null-prototype label (node:sqlite rows)", async () => {
  const { preview } = await import("../src/preview.mjs");
  assert.equal(preview(Object.assign(Object.create(null), { id: 5, title: "buy milk" })), "{ id: 5, title: 'buy milk' }");
});
