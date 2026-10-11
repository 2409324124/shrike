import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DebugEvent, ProcessSpec, TimelineNode } from "@shrike/schema";
import { startIngest } from "./ingest.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";

// fixtures/polyglot for real: an Express gateway (node-agent) calling a FastAPI service (python-agent), one trip.
const repo = join(import.meta.dirname, "../../../..");
const root = join(repo, "fixtures/polyglot");
const python = join(root, "pricing/.venv/bin/python");
const ready = existsSync(join(root, "node_modules/express")) && existsSync(python) && spawnSync(python, ["-c", "import sys, fastapi, uvicorn; assert sys.version_info >= (3, 12)"]).status === 0;
const skip = !ready && "needs fixtures/polyglot's node_modules and pricing/.venv on Python 3.12+ (see its README)";
const config: ProcessSpec[] = JSON.parse(readFileSync(join(root, ".shrike/config.json"), "utf8")).processes;

const flat = (nodes: TimelineNode[]): DebugEvent[] => nodes.flatMap((n) => [n.event, ...flat(n.children)]);
const dump = (nodes: TimelineNode[], d = 0): string => nodes.map((n) => `${"  ".repeat(d)}${n.event.kind} ${n.event.name} [${n.event.place?.id ?? ""}] ${n.event.status}\n${dump(n.children, d + 1)}`).join("");

test("fixtures/polyglot live: the gateway's call joins the Python request, its steps and query nest under it, the error is at its line", { skip, timeout: 60_000 }, async () => {
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const store = new Store({ projectRoot: () => root, onUpdate: () => {}, onHello: (m) => m.source === "server" && runner.setInstrumented(m.place?.id, m.url) });
  const ing = await startIngest((m) => store.handle(m));
  try {
    const processes = config.filter((p) => p.name !== "web");
    await runner.start({ root, name: "polyglot", devCommand: "", routes: [], expectedPlaces: [], processes }, { nodeAgentRegister: join(repo, "packages/node-agent/src/register.mjs"), pythonAgent: join(repo, "packages/python-agent/src"), ingestUrl: ing.url, token: ing.token });
    while (runner.status.state === "starting") await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.status.state, "running", runner.status.error);
    assert.deepEqual(runner.status.processes?.map((p) => [p.name, p.instrumented]), [["gateway", true], ["pricing", true]]);

    // The page's click and its same-origin fetch (through Vite's proxy, so it carries a traceparent).
    const B = "7".repeat(32);
    const root_: DebugEvent = { id: "d1".repeat(8), traceId: B, origin: "browser", kind: "user_action", name: 'Clicked "Quote 2 tea books"', trigger: "click", startMs: Date.now(), status: "ok" };
    const call: DebugEvent = { id: "d2".repeat(8), traceId: B, parentId: root_.id, origin: "browser", kind: "http_request", name: "POST /api/quote", startMs: Date.now(), status: "ok", http: { method: "POST", url: "http://localhost:4610/api/quote" } };
    store.handle({ type: "hello", source: "browser", url: "http://localhost:4610/", at: Date.now() });
    store.handle({ type: "events", events: [root_, call] });
    const res = await fetch("http://localhost:4611/api/quote", { method: "POST", headers: { "content-type": "application/json", traceparent: `00-${B}-${call.id}-01` }, body: JSON.stringify({ lines: [{ sku: "book", qty: 2 }] }) });
    assert.equal(res.status, 502);

    let tree: TimelineNode[] = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      tree = store.getAction(root_.id)?.tree ?? [];
      if (flat(tree).some((e) => e.kind === "http_request" && e.place?.id === "service:pricing")) break;
    }
    await new Promise((r) => setTimeout(r, 500));
    tree = store.getAction(root_.id)!.tree;
    const all = flat(tree);
    const msg = dump(tree);
    const at = (pred: (e: DebugEvent) => boolean, what: string) => {
      const e = all.find(pred);
      assert.ok(e, `${what}\n${msg}`);
      return e;
    };
    const parent = (e: DebugEvent) => all.find((x) => x.id === e.parentId);

    const gw = at((e) => e.kind === "http_request" && e.place?.id === "service:gateway", "the gateway's request");
    assert.equal(gw.parentId, call.id);
    const build = at((e) => e.name === "buildQuote()", "buildQuote()");
    const out = at((e) => e.kind === "external_call", "the gateway's outgoing call");
    assert.deepEqual([out.place?.id, out.status, out.http?.status], ["service:pricing", "error", 500], msg);
    assert.equal(parent(out)?.name, "priceLine()", msg);
    assert.equal(parent(parent(out)!)?.id, build.id, msg);

    const py = at((e) => e.kind === "http_request" && e.place?.id === "service:pricing", "the Python request");
    assert.equal(py.parentId, out.id, `the Python request nests under the gateway's call\n${msg}`);
    assert.equal(py.traceId, B, "one trip");
    assert.deepEqual([py.name, py.http?.status, py.error?.type], ["GET /price/book", 500, "KeyError"]);
    const price = at((e) => e.name === "price()" && e.parentId === py.id, "price() under the Python request");
    assert.deepEqual(price.args, ["sku='book'", "qty=2"]);
    const q = at((e) => e.kind === "db_query", "the sqlite query");
    assert.deepEqual([q.place?.id, q.db?.params, parent(q)?.name], ["data:sqlite:pricing.db", "('book',)", "query()"]);
    const tax = at((e) => e.name === "with_tax()", "with_tax()");
    assert.deepEqual([tax.args, tax.status, tax.error?.message, parent(tax)?.id], [["cents=2400", "tax_class='reduced'"], "error", "KeyError: 'reduced'", price.id]);
    assert.ok(tax.error?.stack?.includes('File "pricing/main.py", line 33, in with_tax'), tax.error?.stack);
    assert.deepEqual(store.listActions().map((a) => a.label).filter((l) => l !== "Server output"), ['Clicked "Quote 2 tea books"'], "health checks make no trips");
  } finally {
    await runner.stop();
    await ing.close();
  }
});
