import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngestMessage } from "@shrike/schema";
import { startIngest } from "./ingest.ts";

test("ingest checks the token, validates and forwards messages", async () => {
  const got: IngestMessage[] = [];
  const ing = await startIngest((m) => got.push(m));
  const post = (body: string, token = ing.token) =>
    fetch(`${ing.url}/ingest`, { method: "POST", headers: { "x-shrike-token": token }, body }).then((r) => r.status);
  const ev = { id: "a".repeat(16), traceId: "b".repeat(32), kind: "log", name: "hi", startMs: 1, status: "ok", origin: "server", log: { level: "info", message: "hi" } };

  assert.equal(await post(JSON.stringify({ type: "hello", source: "server", at: 1 }), "nope"), 401);
  assert.equal(await post("{not json"), 400);
  assert.equal(await post(JSON.stringify({ type: "events", events: [{ ...ev, kind: "bogus" }] })), 400);
  assert.equal(await post(JSON.stringify({ type: "hello", source: "server", pid: 1, at: 1 })), 204);
  assert.equal(await post(JSON.stringify({ type: "events", events: [ev] })), 204);
  assert.equal(await post("x".repeat(5 * 1024 * 1024 + 10)).catch(() => 413), 413);
  assert.equal(got.length, 2);
  assert.equal(got[1]?.type === "events" && got[1].events[0]?.log?.message, "hi");
  await ing.close();
});

test("parseIngest keeps places, callers and cache ops, and drops only a malformed extra", async () => {
  const { parseIngest } = await import("./ingest.ts");
  const base = { id: "a".repeat(16), traceId: "b".repeat(32), name: "get orders", startMs: 1, status: "ok", origin: "server" };
  const place = { id: "cache:lru:orders", kind: "cache", name: "LRU · orders", junk: 1 };
  const m = parseIngest({ type: "events", events: [{ ...base, kind: "cache_op", place, cache: { op: "get", key: "orders", hit: false } }, { ...base, kind: "external_call", place: { id: "x", kind: "planet", name: "X" }, caller: { kind: "curl", label: "curl" } }] });
  assert.ok(m?.type === "events");
  assert.deepEqual(m.events[0]!.place, { id: "cache:lru:orders", kind: "cache", name: "LRU · orders" });
  assert.deepEqual(m.events[0]!.cache, { op: "get", key: "orders", hit: false });
  assert.equal(m.events[1]!.place, undefined);
  assert.deepEqual(m.events[1]!.caller, { kind: "curl", label: "curl" });
  const h = parseIngest({ type: "hello", source: "server", place: { id: "service:api", kind: "service", name: "API" }, at: 1 });
  assert.deepEqual(h?.type === "hello" && h.place, { id: "service:api", kind: "service", name: "API" });
});
