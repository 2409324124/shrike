import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DebugEvent, ProcessSpec, TimelineNode } from "@shrike/schema";
import { startIngest } from "./ingest.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";

// fixtures/py-app for real: FastAPI, Flask and Django through the Runner's env, python-agent, the ingest and the store.
const repo = join(import.meta.dirname, "../../../..");
const pyApp = join(repo, "fixtures/py-app");
const python = join(pyApp, "api/.venv/bin/python");
const ready = existsSync(python) && spawnSync(python, ["-c", "import sys, fastapi, flask, django; assert sys.version_info >= (3, 12)"]).status === 0;
const skip = !ready && "needs fixtures/py-app/api/.venv on Python 3.12+ with its requirements (see its README)";
const config: ProcessSpec[] = JSON.parse(readFileSync(join(pyApp, ".shrike/config.json"), "utf8")).processes;

const flat = (nodes: TimelineNode[]): DebugEvent[] => nodes.flatMap((n) => [n.event, ...flat(n.children)]);

async function clickThrough(spec: ProcessSpec, port: number, extra: Partial<ProcessSpec> = {}) {
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const store = new Store({ projectRoot: () => pyApp, onUpdate: () => {}, onHello: (m) => m.source === "server" && runner.setInstrumented(m.place?.id, m.url) });
  const ing = await startIngest((m) => store.handle(m));
  try {
    await runner.start({ root: pyApp, name: "py-app", devCommand: "", routes: [], expectedPlaces: [], processes: [{ ...spec, ...extra }] }, { nodeAgentRegister: "/none.mjs", pythonAgent: join(repo, "packages/python-agent/src"), ingestUrl: ing.url, token: ing.token });
    while (runner.status.state === "starting") await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.status.state, "running");
    const B = "7".repeat(32);
    const url = `http://localhost:${port}/api/items/3/unit-price`;
    store.handle({ type: "hello", source: "browser", url: "http://localhost:5190/", at: Date.now() });
    const root: DebugEvent = { id: "d1".repeat(8), traceId: B, origin: "browser", kind: "user_action", name: 'Clicked "Unit price of Gift card"', trigger: "click", startMs: Date.now(), status: "ok" };
    store.handle({ type: "events", events: [root, { id: "d2".repeat(8), traceId: B, parentId: root.id, origin: "browser", kind: "http_request", name: `GET ${url}`, startMs: Date.now(), status: "ok", http: { method: "GET", url } }] });
    assert.equal((await fetch(url)).status, 500);
    let served: TimelineNode | undefined;
    for (let i = 0; i < 50 && !served?.children.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      served = store.getAction(root.id)?.tree[0]?.children[0];
    }
    return { store, served: served!, steps: flat(served?.children ?? []), labels: store.listActions().map((a) => a.label), instrumented: runner.status.processes?.[0]?.instrumented };
  } finally {
    await runner.stop();
    await ing.close();
  }
}

const cases = [
  { name: "api", port: 8010, view: "unit_price()", viewArgs: ["item_id=3"], at: 'File "api/main.py", line 47, in unit_price', thrower: "unit_price()" },
  { name: "flask", port: 8011, view: "unit_price()", viewArgs: ["item_id=3"], at: 'File "api/shop.py", line 27, in unit_cents', thrower: "unit_cents()" },
  { name: "django", port: 8012, view: "unit_price()", viewArgs: [/^request=<WSGIRequest: GET '\/api\/items\/3\/unit-price'>$/, "item_id=3"], at: 'File "api/shop.py", line 27, in unit_cents', thrower: "unit_cents()" },
];

for (const c of cases) {
  test(`fixtures/py-app live, ${c.name}: the click's call joins the server's request, its steps carry values, the error is at its line`, { skip }, async () => {
    const { served, steps, labels, instrumented } = await clickThrough(config.find((p) => p.name === c.name)!, c.port);
    assert.equal(instrumented, true, "python-agent said hello for its lane");
    assert.deepEqual(labels, ['Clicked "Unit price of Gift card"'], "the readiness check and startup queries make no trips");
    const req = served.event;
    assert.deepEqual([req.kind, req.name, req.status, req.http?.status, req.place?.id, req.error?.type], ["http_request", "GET /api/items/3/unit-price", "error", 500, `service:${c.name}`, "ZeroDivisionError"]);
    assert.equal(req.otel, undefined, "recorded once, by python-agent, not also by OpenTelemetry");
    const view = steps.find((e) => e.name === c.view)!;
    assert.ok(view, steps.map((e) => e.name).join(", "));
    assert.equal(view.args?.length, c.viewArgs.length);
    c.viewArgs.forEach((a, i) => (typeof a === "string" ? assert.equal(view.args![i], a) : assert.match(view.args![i]!, a)));
    const q = steps.find((e) => e.kind === "db_query" && e.name.startsWith("SELECT name"))!;
    assert.deepEqual([q.db?.params, q.place?.id, q.status], ["(3,)", "data:sqlite:shop.db", "ok"]);
    const thrower = steps.find((e) => e.name === c.thrower && e.status === "error")!;
    assert.equal(thrower.error?.type, "ZeroDivisionError");
    assert.ok(thrower.error?.stack?.includes(c.at), thrower.error?.stack);
    if (c.thrower === "unit_cents()") assert.deepEqual(thrower.args, ["price_cents=2500", "pack_size=0"]);
    assert.ok(req.error?.stack?.includes(c.at), "the request's error points at the same line");
    assert.ok(steps.every((e) => !e.source || !e.source.file.includes("site-packages")), "no framework frames");
  });
}

test("fixtures/py-app live: started under opentelemetry-instrument, OpenTelemetry records it alone (no doubled steps)", { skip }, async () => {
  const { served, steps } = await clickThrough(config.find((p) => p.name === "api")!, 8010, { command: ".venv/bin/opentelemetry-instrument .venv/bin/uvicorn main:app --port 8010" });
  assert.equal(served.event.otel, true);
  assert.deepEqual(steps.map((e) => [e.kind, e.otel]), [["db_query", true]]);
});
