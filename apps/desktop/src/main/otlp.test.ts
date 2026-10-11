import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { DebugEvent, IngestMessage, TimelineNode } from "@shrike/schema";
import { startIngest } from "./ingest.ts";
import { decodeTraces, otlpMessages } from "./otlp.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";

// A tiny protobuf encoder, enough to build an ExportTraceServiceRequest the way the SDKs send it.
const vint = (n: number | bigint) => {
  const out: number[] = [];
  let v = BigInt.asUintN(64, BigInt(n));
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v ? b | 0x80 : b);
  } while (v);
  return out;
};
const msg = (f: number, b: number[]) => [...vint((f << 3) | 2), ...vint(b.length), ...b];
const str = (f: number, s: string) => msg(f, [...Buffer.from(s)]);
const id = (f: number, h: string) => msg(f, [...Buffer.from(h, "hex")]);
const varf = (f: number, n: number | bigint) => [...vint(f << 3), ...vint(n)];
const fixed = (f: number, n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...vint((f << 3) | 1), ...b];
};
const any = (v: string | number | boolean) =>
  typeof v === "string" ? str(1, v) : typeof v === "boolean" ? varf(2, v ? 1 : 0) : Number.isInteger(v) ? varf(3, v) : (() => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return [...vint((4 << 3) | 1), ...b]; })();
const kv = (f: number, k: string, v: string | number | boolean) => msg(f, [...str(1, k), ...msg(2, any(v))]);
const attrs = (f: number, a: Record<string, string | number | boolean>) => Object.entries(a).flatMap(([k, v]) => kv(f, k, v));

const T = "4bf92f3577b34da6a3ce929d0e0e4736";
const NS = 1_700_000_000_000n * 1_000_000n;
const span = (s: { id: string; parent?: string; name: string; kind: number; startMs: number; ms: number; attrs: Record<string, string | number | boolean>; events?: number[][]; error?: string }) =>
  msg(2, [
    ...id(1, T),
    ...id(2, s.id),
    ...(s.parent ? id(4, s.parent) : []),
    ...str(5, s.name),
    ...varf(6, s.kind),
    ...fixed(7, NS + BigInt(s.startMs) * 1_000_000n),
    ...fixed(8, NS + BigInt(s.startMs + s.ms) * 1_000_000n),
    ...attrs(9, s.attrs),
    ...(s.events ?? []).flatMap((e) => msg(11, e)),
    ...(s.error ? msg(15, [...str(2, s.error), ...varf(3, 2)]) : []),
  ]);

const STACK = 'Traceback (most recent call last):\n  File "/usr/lib/python3.12/site-packages/starlette/routing.py", line 74, in app\n  File "/proj/api/main.py", line 42, in get_item\n    return price / qty\nZeroDivisionError: division by zero';
const pythonPayload = () =>
  Buffer.from(
    msg(1, [
      ...msg(1, attrs(1, { "service.name": "api", "telemetry.sdk.language": "python" })),
      ...msg(2, [
        ...msg(1, str(1, "opentelemetry.instrumentation.fastapi")),
        ...span({ id: "00f067aa0ba902b7", name: "GET /items/{item_id}", kind: 2, startMs: 10, ms: 30, error: "boom", attrs: { "http.method": "GET", "http.target": "/items/7", "http.url": "http://127.0.0.1:8000/items/7?full=1", "http.host": "127.0.0.1:8000", "net.host.port": 8000, "http.status_code": 500 }, events: [[...fixed(1, NS), ...str(2, "exception"), ...attrs(3, { "exception.type": "ZeroDivisionError", "exception.message": "division by zero", "exception.stacktrace": STACK })]] }),
        ...span({ id: "1111111111111111", parent: "00f067aa0ba902b7", name: "SELECT", kind: 3, startMs: 12, ms: 4, attrs: { "db.system": "sqlite", "db.statement": "SELECT price, qty FROM items WHERE id = ?", "db.name": "/proj/api/shop.db", "sample.ratio": 0.5 } }),
        ...span({ id: "2222222222222222", parent: "00f067aa0ba902b7", name: "GET /items/{item_id} http send", kind: 1, startMs: 39, ms: 1, attrs: { "asgi.event.type": "http.response.start" } }),
        ...span({ id: "3333333333333333", parent: "00f067aa0ba902b7", name: "price_of", kind: 1, startMs: 20, ms: 2, attrs: { "code.filepath": "/proj/api/main.py", "code.lineno": 30, "code.function": "price_of" } }),
      ]),
    ]),
  );

const eventsOf = (msgs: IngestMessage[] | null) => (msgs ?? []).flatMap((m) => (m.type === "events" ? m.events : []));

test("protobuf: a Python service's spans become a hello and real steps (request, query, function), with its error", () => {
  const msgs = otlpMessages(decodeTraces(pythonPayload()));
  assert.ok(msgs);
  const hello = msgs[0]!;
  assert.deepEqual(hello.type === "hello" && [hello.source, hello.place, hello.url], ["server", { id: "service:api", kind: "service", name: "API", detail: "localhost:8000" }, "http://localhost:8000"]);
  const [req, query, fn, ...rest] = eventsOf(msgs);
  assert.equal(rest.length, 0, "ASGI send/receive spans are dropped");
  assert.equal(req!.id, "00f067aa0ba902b7");
  assert.equal(req!.traceId, T);
  assert.equal(req!.parentId, undefined);
  assert.equal(req!.kind, "http_request");
  assert.equal(req!.name, "GET /items/7");
  assert.equal(req!.startMs, 1_700_000_000_010);
  assert.equal(req!.durationMs, 30);
  assert.equal(req!.status, "error");
  assert.deepEqual(req!.http, { method: "GET", url: "/items/7?full=1", status: 500, reqHeaders: { host: "localhost:8000" } });
  assert.deepEqual(req!.error, { message: "division by zero", type: "ZeroDivisionError", stack: STACK });
  assert.deepEqual(req!.source, { file: "/proj/api/main.py", line: 42, functionName: "get_item", precision: "approximate" });
  assert.equal(req!.place?.id, "service:api");
  assert.deepEqual([query!.kind, query!.origin, query!.parentId, query!.db, query!.place], ["db_query", "db", "00f067aa0ba902b7", { system: "sqlite", statement: "SELECT price, qty FROM items WHERE id = ?" }, { id: "data:sqlite:shop.db", kind: "data", name: "SQLITE · shop.db" }]);
  assert.deepEqual([fn!.kind, fn!.name, fn!.source], ["function", "price_of", { file: "/proj/api/main.py", line: 30, functionName: "price_of", precision: "exact" }]);
  assert.equal(otlpMessages({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "nope" }] }] }] }), null);
  assert.throws(() => decodeTraces(Buffer.from([0x0a, 0x05, 0x01])), /truncated/);
});

test("JSON: new semconv names, outside calls, and services another recorder covers are skipped", () => {
  const res = (service: string, spans: unknown[]) => ({ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeSpans: [{ spans }] });
  const a = (o: Record<string, unknown>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : { intValue: String(v) } }));
  const body = {
    resourceSpans: [
      res("orders", [
        { traceId: T.toUpperCase(), spanId: "AAAAAAAAAAAAAAAA", parentSpanId: "", name: "POST /orders", kind: 2, startTimeUnixNano: String(NS), endTimeUnixNano: String(NS + 5_000_000n), attributes: a({ "http.request.method": "POST", "url.path": "/orders", "url.query": "x=1", "server.address": "localhost", "server.port": 5000, "http.response.status_code": 201 }) },
        { traceId: T, spanId: "bbbbbbbbbbbbbbbb", parentSpanId: "aaaaaaaaaaaaaaaa", name: "POST", kind: 3, startTimeUnixNano: Number(NS), endTimeUnixNano: Number(NS), attributes: a({ "http.request.method": "POST", "url.full": "https://api.stripe.com/v1/charges", "http.response.status_code": 402 }) },
        { traceId: T, spanId: "cccccccccccccccc", name: "GET /health", kind: 2, startTimeUnixNano: String(NS), endTimeUnixNano: String(NS), attributes: [...a({ "http.method": "GET", "http.target": "/health" }), { key: "http.request.header.x_shrike_internal", value: { arrayValue: { values: [{ stringValue: "1" }] } } }] },
      ]),
      res("web", [{ traceId: T, spanId: "dddddddddddddddd", name: "x", kind: 1, startTimeUnixNano: "0", endTimeUnixNano: "0" }]),
    ],
  };
  const msgs = otlpMessages(body, (placeId) => placeId === "service:web");
  assert.deepEqual(msgs?.filter((m) => m.type === "hello").map((m) => m.type === "hello" && m.place?.id), ["service:orders"]);
  const [post, stripe, health] = eventsOf(msgs);
  assert.deepEqual([post!.id, post!.traceId, post!.parentId, post!.name, post!.status], ["aaaaaaaaaaaaaaaa", T, undefined, "POST /orders", "ok"]);
  assert.deepEqual(post!.http, { method: "POST", url: "/orders?x=1", status: 201, reqHeaders: { host: "localhost:5000" } });
  assert.deepEqual([stripe!.kind, stripe!.name, stripe!.status, stripe!.place], ["external_call", "POST api.stripe.com/v1/charges", "error", { id: "outside:api.stripe.com", kind: "outside", name: "STRIPE", detail: "api.stripe.com" }]);
  assert.equal(health!.http?.reqHeaders?.["x-shrike-internal"], "1", "Shrike's readiness checks stay recognisable");
});

test("POST /v1/traces: token, protobuf and JSON (gzip too), OTLP responses; node-agent services aren't doubled", async () => {
  const got: IngestMessage[] = [];
  const ing = await startIngest((m) => got.push(m));
  const post = (body: Uint8Array | string, type: string, headers: Record<string, string> = {}) =>
    fetch(`${ing.url}/v1/traces`, { method: "POST", headers: { "x-shrike-token": ing.token, "content-type": type, ...headers }, body: typeof body === "string" ? body : new Uint8Array(body) }).then(async (r) => [r.status, r.headers.get("content-type"), await r.text()]);
  assert.deepEqual(await post(pythonPayload(), "application/x-protobuf", { "x-shrike-token": "nope" }), [401, null, ""]);
  assert.deepEqual(await post(pythonPayload(), "application/x-protobuf"), [200, "application/x-protobuf", ""]);
  assert.deepEqual(await post(gzipSync(pythonPayload()), "application/x-protobuf", { "content-encoding": "gzip" }), [200, "application/x-protobuf", ""]);
  assert.deepEqual(await post(JSON.stringify({ resourceSpans: [] }), "application/json"), [200, "application/json", "{}"]);
  assert.deepEqual((await post("{nope", "application/json"))[0], 400);
  assert.equal(eventsOf(got).length, 6);
  got.length = 0;
  await fetch(`${ing.url}/ingest`, { method: "POST", headers: { "x-shrike-token": ing.token }, body: JSON.stringify({ type: "hello", source: "server", place: { id: "service:api", kind: "service", name: "API" }, at: 1 }) });
  await post(pythonPayload(), "application/x-protobuf");
  assert.deepEqual(got.map((m) => m.type), ["hello"], "a Node service with its own OpenTelemetry SDK is recorded once");
  await ing.close();
});

test("store: an OpenTelemetry server span joins the page's cross-origin call and its lane counts as recorded", () => {
  const hellos: string[] = [];
  const store = new Store({ projectRoot: () => "/proj", onUpdate: () => {}, onHello: (m) => m.source === "server" && hellos.push(`${m.place?.id} ${m.url}`) });
  const B = "9".repeat(32);
  const at = 1_700_000_000_000;
  const ev = (p: Partial<DebugEvent> & Pick<DebugEvent, "id" | "kind" | "name">): DebugEvent => ({ traceId: B, origin: "browser", startMs: at, status: "ok", ...p });
  store.handle({ type: "hello", source: "browser", url: "http://localhost:5173/", at });
  const root = ev({ id: "b1".repeat(8), kind: "user_action", name: 'Clicked "Buy"', trigger: "click" });
  const call = ev({ id: "b2".repeat(8), parentId: root.id, kind: "http_request", name: "GET http://localhost:8000/items/7?full=1", http: { method: "GET", url: "http://localhost:8000/items/7?full=1" } });
  store.handle({ type: "events", events: [root, call] });
  for (const m of otlpMessages(decodeTraces(pythonPayload()))!) store.handle(m);

  assert.deepEqual(hellos, ["service:api http://localhost:8000"]);
  assert.deepEqual(store.listActions().map((a) => a.label), ['Clicked "Buy"'], "no '(from outside the app)' trip");
  const v = store.getAction(root.id)!;
  const served = v.tree.find((n) => n.event.id === call.id)!.children[0]!;
  assert.equal(served.event.name, "GET /items/7");
  assert.equal(served.event.place?.id, "service:api");
  assert.deepEqual(served.children.map((c) => c.event.name).sort(), ["SELECT price, qty FROM items WHERE id = ?", "price_of"]);
  assert.equal(store.getEvent("3333333333333333")?.source?.file, "api/main.py", "absolute SDK paths are made project-relative");
  assert.equal(store.getEvent("00f067aa0ba902b7")?.source?.file, "api/main.py");
});

const pyApp = join(import.meta.dirname, "../../../../fixtures/py-app");
test("fixtures/py-app live: the runner's env makes a real FastAPI app's 500 and its query join the page's click", { skip: !existsSync(join(pyApp, "api/.venv")) && "needs fixtures/py-app/api/.venv (see its README)" }, async () => {
  const store = new Store({ projectRoot: () => pyApp, onUpdate: () => {} });
  const ing = await startIngest((m) => store.handle(m));
  const api = { ...JSON.parse(readFileSync(join(pyApp, ".shrike/config.json"), "utf8")).processes.find((p: { name: string }) => p.name === "api"), command: ".venv/bin/opentelemetry-instrument .venv/bin/uvicorn main:app --port 8010" };
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  try {
    await runner.start({ root: pyApp, name: "py-app", devCommand: "", routes: [], expectedPlaces: [], processes: [api] }, { nodeAgentRegister: "/none.mjs", ingestUrl: ing.url, token: ing.token });
    while (runner.status.state === "starting") await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.status.state, "running");
    const B = "8".repeat(32);
    const url = "http://localhost:8010/api/items/3/unit-price";
    store.handle({ type: "hello", source: "browser", url: "http://localhost:5190/", at: Date.now() });
    const root: DebugEvent = { id: "c1".repeat(8), traceId: B, origin: "browser", kind: "user_action", name: 'Clicked "Unit price of Gift card"', trigger: "click", startMs: Date.now(), status: "ok" };
    store.handle({ type: "events", events: [root, { id: "c2".repeat(8), traceId: B, parentId: root.id, origin: "browser", kind: "http_request", name: `GET ${url}`, startMs: Date.now(), status: "ok", http: { method: "GET", url } }] });
    assert.equal((await fetch(url)).status, 500);
    let served: TimelineNode | undefined;
    for (let i = 0; i < 50 && !served?.children.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      served = store.getAction(root.id)?.tree[0]?.children[0];
    }
    assert.deepEqual(store.listActions().map((a) => a.label), ['Clicked "Unit price of Gift card"'], "the readiness check and startup queries make no trips");
    assert.deepEqual([served?.event.name, served?.event.status, served?.event.error?.type, served?.event.source?.file], ["GET /api/items/3/unit-price", "error", "ZeroDivisionError", "api/main.py"]);
    assert.deepEqual(served?.children.map((c) => [c.event.kind, c.event.place?.id]), [["db_query", "data:sqlite"]]);
  } finally {
    await runner.stop();
    await ing.close();
  }
});
