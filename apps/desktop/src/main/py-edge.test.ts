import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ActionView, DebugEvent, ProcessSpec, TimelineNode } from "@shrike/schema";
import { dataChanges, unseenWriter } from "../renderer/src/inspector/logic.ts";
import { startIngest } from "./ingest.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";

// fixtures/py-edge for real: httpx to an outside API, SQLAlchemy on Postgres (Docker) or SQLite, a background task, asyncio.gather.
const repo = join(import.meta.dirname, "../../../..");
const root = join(repo, "fixtures/py-edge");
const python = join(root, "app/.venv/bin/python");
const ready = existsSync(python) && spawnSync(python, ["-c", "import sys, fastapi, httpx, sqlalchemy, psycopg; assert sys.version_info >= (3, 12)"]).status === 0;
const skip = !ready && "needs fixtures/py-edge/app/.venv on Python 3.12+ (see its README)";
const docker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const PG = "shrike-py-edge-test-pg";
const config: ProcessSpec[] = JSON.parse(readFileSync(join(root, ".shrike/config.json"), "utf8")).processes;

const flat = (nodes: TimelineNode[]): DebugEvent[] => nodes.flatMap((n) => [n.event, ...flat(n.children)]);
const dump = (nodes: TimelineNode[], d = 0): string => nodes.map((n) => `${"  ".repeat(d)}${n.event.kind} ${n.event.name} [${n.event.place?.id ?? ""}]${n.event.otel ? " otel" : ""} ${n.event.status}\n${dump(n.children, d + 1)}`).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Postgres 16 on 4623 for the test (the fixture's own 4622 may be in use), else SQLAlchemy on SQLite. */
function database(): { url: string; stop(): void } {
  if (docker) {
    spawnSync("docker", ["rm", "-f", PG], { stdio: "ignore" });
    const r = spawnSync("docker", ["run", "-d", "--rm", "--name", PG, "-p", "4623:5432", "-e", "POSTGRES_USER=edge", "-e", "POSTGRES_PASSWORD=edge", "-e", "POSTGRES_DB=edge", "postgres:16"], { encoding: "utf8" });
    if (r.status === 0) return { url: "postgresql+psycopg://edge:edge@localhost:4623/edge", stop: () => void spawnSync("docker", ["rm", "-f", PG], { stdio: "ignore" }) };
  }
  return { url: "sqlite:///.data/edge.db", stop: () => {} };
}

async function trips(command: (c: string) => string, clicks: { name: string; method: string; path: string; body?: unknown }[]) {
  const db = database();
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const store = new Store({ projectRoot: () => root, onUpdate: () => {}, onHello: (m) => m.source === "server" && runner.setInstrumented(m.place?.id, m.url) });
  const ing = await startIngest((m) => store.handle(m));
  try {
    const processes = config.map((p) => (p.name === "api" ? { ...p, command: command(`DATABASE_URL=${db.url} ${p.command}`) } : p));
    await runner.start({ root, name: "py-edge", devCommand: "", routes: [], expectedPlaces: [], processes }, { nodeAgentRegister: "/none.mjs", pythonAgent: join(repo, "packages/python-agent/src"), ingestUrl: ing.url, token: ing.token });
    for (let i = 0; i < 600 && runner.status.state === "starting"; i++) await wait(100);
    assert.equal(runner.status.state, "running", runner.status.error);
    store.handle({ type: "hello", source: "browser", url: "http://localhost:4620/", at: Date.now() });
    const out: Record<string, { status: number; tree: TimelineNode[]; view?: ActionView; body: string }> = {};
    let k = 0;
    for (const c of clicks) {
      const B = (++k).toString(16).repeat(32).slice(0, 32);
      const click: DebugEvent = { id: `c${k}`.padEnd(16, "0"), traceId: B, origin: "browser", kind: "user_action", name: `Clicked "${c.name}"`, trigger: "click", startMs: Date.now(), status: "ok" };
      const call: DebugEvent = { id: `f${k}`.padEnd(16, "0"), traceId: B, parentId: click.id, origin: "browser", kind: "http_request", name: `${c.method} ${c.path}`, startMs: Date.now(), status: "ok", http: { method: c.method, url: `http://localhost:4620${c.path}` } };
      store.handle({ type: "events", events: [click, call] });
      const res = await fetch(`http://localhost:4620${c.path}`, { method: c.method, headers: { "content-type": "application/json", traceparent: `00-${B}-${call.id}-01` }, body: c.body ? JSON.stringify(c.body) : undefined });
      await wait(1500); // the background task runs after the response
      const view = store.getAction(click.id);
      out[c.name] = { status: res.status, tree: view?.tree ?? [], view, body: await res.text() };
    }
    return { out, db: db.url, labels: store.listActions().map((a) => a.label) };
  } finally {
    await runner.stop();
    await ing.close();
    db.stop();
  }
}

const clicks = [
  { name: "Order in USD", method: "POST", path: "/api/orders", body: { item: "mug", cents: 1200, currency: "USD" } },
  { name: "Order in EUR", method: "POST", path: "/api/orders", body: { item: "mug", cents: 1200, currency: "EUR" } },
  { name: "Dashboard", method: "GET", path: "/api/dashboard" },
];

test("fixtures/py-edge live under python-agent: httpx calls, SQLAlchemy's queries and their row changes, background task and gather keep their parents", { skip, timeout: 120_000 }, async () => {
  const { out, db } = await trips((c) => c, clicks);
  const msg = Object.entries(out).map(([k, v]) => `--- ${k} ${v.status}\n${dump(v.tree)}`).join("");
  console.log(`database ${db}\n${msg}`);
  const steps = (name: string) => flat(out[name]!.tree);
  const byId = (name: string) => new Map(steps(name).map((e) => [e.id, e]));

  // USD: the order is written through SQLAlchemy; the background task's steps still nest under the request.
  assert.equal(out["Order in USD"]!.status, 200);
  const usd = steps("Order in USD");
  const req = usd.find((e) => e.kind === "http_request" && e.place?.id === "service:api")!;
  assert.ok(req, msg);
  const receipt = usd.find((e) => e.name === "send_receipt()")!;
  assert.ok(receipt, `the background task is recorded\n${msg}`);
  assert.equal(byId("Order in USD").get(receipt.parentId!)?.id, req.id, "it nests under the request that queued it");
  const receiptCall = usd.find((e) => e.kind === "external_call")!;
  assert.deepEqual([receiptCall?.name, receiptCall?.http?.status, byId("Order in USD").get(receiptCall?.parentId ?? "")?.name], ["POST localhost:4621/receipts", 202, "send_receipt()"], msg);
  // SQLAlchemy's INSERT and the background task's UPDATE, once each, with the rows they changed (psycopg on Postgres, else sqlite3, where booleans bind as 0 and 1).
  const pg = db.startsWith("postgres");
  const lane = pg ? "data:postgres:localhost:4623/edge" : "data:sqlite:edge.db";
  const writes = (re: RegExp) => usd.filter((e) => e.kind === "db_query" && re.test(e.db?.statement ?? ""));
  const [ins, upd] = [writes(/^INSERT INTO orders/), writes(/^UPDATE orders/)];
  assert.deepEqual([ins.length, upd.length], [1, 1], msg);
  const id = JSON.parse(out["Order in USD"]!.body).id;
  assert.deepEqual([ins[0]!.place?.id, ins[0]!.db?.system, byId("Order in USD").get(ins[0]!.parentId!)?.name, ins[0]!.source?.file], [lane, pg ? "postgres" : "sqlite", "create_order()", "app/main.py"], msg);
  assert.deepEqual(ins[0]!.change, { table: "orders", op: "insert", count: 1, rows: [{ pk: String(id), after: { id, item: "mug", cents: 1200, currency: "USD", receipt_sent: pg ? false : 0 } }] });
  assert.deepEqual(upd[0]!.change, { table: "orders", op: "update", count: 1, rows: [{ pk: String(id), after: { id, receipt_sent: pg ? true : 1 } }] });
  assert.equal(byId("Order in USD").get(upd[0]!.parentId!)?.name, "send_receipt()");
  const changed = dataChanges(out["Order in USD"]!.view, lane);
  assert.deepEqual(changed.map((g) => [g.table, g.added, g.changed, g.rows.map((r) => `${r.kind} ${r.pk}`)]), [["orders", 1, 1, [`added ${id}`, `changed ${id}`]]], "What this click changed: the real rows");
  assert.equal(unseenWriter(out["Order in USD"]!.view, lane), undefined, "no can't-tell note once the rows are seen");

  // EUR: the outside API's string rate is visible only as usd_rate()'s return value; convert() fails on it.
  assert.equal(out["Order in EUR"]!.status, 500);
  const eur = steps("Order in EUR");
  const rate = eur.find((e) => e.name === "usd_rate()")!;
  assert.deepEqual([rate.args, rate.returned], [["currency='EUR'"], "'0.92'"], msg);
  const ratesCall = eur.find((e) => e.kind === "external_call")!;
  assert.equal(ratesCall.parentId, rate.id);
  assert.match(ratesCall.http?.resBody ?? "", /"EUR": "0\.92"/, "the outside API's answer, string and all");
  const conv = eur.find((e) => e.name === "convert()")!;
  assert.deepEqual([conv.status, conv.error?.type, conv.args?.[1]], ["error", "TypeError", "rate='0.92'"]);

  // gather: both fetches and the thread's count_orders() hang off dashboard(), not off each other.
  assert.equal(out["Dashboard"]!.status, 200);
  const dash = steps("Dashboard");
  const top = dash.find((e) => e.name === "dashboard()")!;
  const kids = dash.filter((e) => ["fetch_rates()", "count_orders()"].includes(e.name));
  assert.deepEqual(kids.map((e) => e.name).sort(), ["count_orders()", "fetch_rates()", "fetch_rates()"], msg);
  assert.ok(kids.every((e) => e.parentId === top.id), msg);
  const fetches = dash.filter((e) => e.kind === "external_call");
  assert.deepEqual(fetches.map((e) => dash.find((f) => f.id === e.parentId)?.name), ["fetch_rates()", "fetch_rates()"], "each gathered call under its own coroutine");
  assert.notEqual(fetches[0]!.parentId, fetches[1]!.parentId);
  assert.equal(top.callSite, undefined, "app/.venv/bin/uvicorn is not the project's code calling dashboard()");
});

test("fixtures/py-edge live under opentelemetry-instrument: the outside call and the queries are filled in, nothing recorded twice", { skip, timeout: 120_000 }, async () => {
  const { out, db } = await trips((c) => c.replace(".venv/bin/uvicorn", ".venv/bin/opentelemetry-instrument .venv/bin/uvicorn"), clicks.slice(0, 2));
  const msg = Object.entries(out).map(([k, v]) => `--- ${k} ${v.status}\n${dump(v.tree)}`).join("");
  console.log(`database ${db}\n${msg}`);
  const usd = flat(out["Order in USD"]!.tree);
  assert.ok(usd.every((e) => e.origin === "browser" || e.otel), `OpenTelemetry alone\n${msg}`);
  const count = (re: RegExp) => usd.filter((e) => e.kind === "db_query" && re.test(e.db?.statement ?? "")).length;
  assert.deepEqual([count(/^INSERT INTO orders/), count(/^UPDATE orders/)], [1, 1], `the insert and the background task's update once each, though SQLAlchemy and psycopg both trace them\n${msg}`);
  assert.ok(usd.some((e) => e.kind === "external_call" && /receipts/.test(e.name + (e.http?.url ?? ""))), `the background task's outside call\n${msg}`);
  const eur = flat(out["Order in EUR"]!.tree);
  assert.ok(eur.some((e) => e.kind === "external_call" && /rates/.test(e.name + (e.http?.url ?? ""))), `the rates call\n${msg}`);
});
