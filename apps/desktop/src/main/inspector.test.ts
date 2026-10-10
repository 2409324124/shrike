import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspectRequest } from "@shrike/schema";
import { startIngest } from "./ingest.ts";
import { InspectHub, inspectRequest } from "./inspector.ts";

type Handler = (q: InspectRequest & { id: string }) => Record<string, unknown> | "silent";

/** Polls like node-agent does and answers with `handler`. */
function fakeAgent(url: string, token: string, o: { pid: number; service: string; places: string[] }, handler: Handler) {
  const ac = new AbortController();
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-shrike-token": token }, body: JSON.stringify(body), signal: ac.signal });
  void (async () => {
    while (!ac.signal.aborted) {
      const r = await post("/inspect/poll", o).catch(() => undefined);
      if (!r) return;
      const { requests } = (await r.json()) as { requests: (InspectRequest & { id: string })[] };
      for (const q of requests) {
        const a = handler(q);
        if (a !== "silent") await post("/inspect/reply", { id: q.id, ...a }).catch(() => {});
      }
    }
  })();
  return { stop: () => ac.abort() };
}

const rows = { op: "rows", table: "users", columns: ["id", "password", "note"], pk: ["id"], rows: [[1, "hunter2", "key sk-ant-abcdefghijklmnopqrstuvwxyz"]], total: 1 };

test("routes to the process that holds the place; main redacts the reply", async () => {
  const hub = new InspectHub({ holdMs: 500 });
  const ing = await startIngest(() => {}, hub);
  const seen: string[] = [];
  const api = fakeAgent(ing.url, ing.token, { pid: 11, service: "service:api", places: ["data:sqlite:shop.db"] }, (q) => (seen.push(`api ${q.op}`), { ok: true, result: rows }));
  const auth = fakeAgent(ing.url, ing.token, { pid: 12, service: "service:auth", places: ["cache:lru:sessions"] }, (q) =>
    q.op === "cacheKeys" ? (seen.push("auth cacheKeys"), { ok: true, result: { op: "cacheKeys", system: "lru", size: 1, entries: [{ key: "demo-token", preview: "{ userId: 1 }", ttlMs: null }] } }) : { ok: false, missing: true },
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    const r = await hub.request({ op: "rows", placeId: "data:sqlite:shop.db", table: "users" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.rows, [[1, "[redacted:password]", "key [redacted:anthropic_key]"]]);
    const c = await hub.request({ op: "cacheKeys", placeId: "cache:lru:sessions" });
    assert.ok(c.op === "cacheKeys");
    assert.equal(c.entries[0]!.preview, "[redacted:demo-token]");
    assert.deepEqual(seen, ["api rows", "auth cacheKeys"]);
  } finally {
    api.stop();
    auth.stop();
    await ing.close();
  }
});

test("plain reasons: not running, not seen yet, gone, too slow, unreadable", async () => {
  const hub = new InspectHub({ holdMs: 300, timeoutMs: 400, aliveMs: 200 });
  const ing = await startIngest(() => {}, hub);
  await assert.rejects(hub.request({ op: "tables", placeId: "data:sqlite:x.db" }), /hasn't seen your app use this database yet and found no settings/);
  const api = fakeAgent(ing.url, ing.token, { pid: 21, service: "service:api", places: ["data:postgres:orders", "data:sqlite:slow.db", "data:sqlite:odd.db"] }, (q) =>
    q.placeId === "data:sqlite:slow.db" ? "silent" : q.placeId === "data:sqlite:odd.db" ? { ok: true, result: { op: "rows", nope: 1 } } : { ok: false, missing: true },
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(hub.request({ op: "tables", placeId: "data:sqlite:never.db" }), /hasn't seen your app use this database yet/);
    await assert.rejects(hub.request({ op: "tables", placeId: "data:sqlite:slow.db" }), /The api process didn.t answer within/);
    await assert.rejects(hub.request({ op: "rows", placeId: "data:sqlite:odd.db", table: "t" }), /couldn't read/);
    api.stop();
    await new Promise((r) => setTimeout(r, 600));
    await assert.rejects(hub.request({ op: "tables", placeId: "data:postgres:orders" }), /This database lives in the api process, which isn't running/);
  } finally {
    api.stop();
    await ing.close();
  }
});

test("the ingest guards the inspector routes; requests are validated", async () => {
  const hub = new InspectHub();
  const ing = await startIngest(() => {}, hub);
  const plain = await startIngest(() => {});
  try {
    const poll = (url: string, token: string) => fetch(`${url}/inspect/poll`, { method: "POST", headers: { "x-shrike-token": token }, body: "{}" }).then((r) => r.status);
    assert.equal(await poll(ing.url, "wrong"), 401);
    assert.equal(await poll(ing.url, ing.token), 400);
    assert.equal(await poll(plain.url, plain.token), 404, "an ingest without the inspector (a worktree run) says so and the agent stops polling");
    assert.ok(inspectRequest.safeParse({ op: "rows", placeId: "data:sqlite:a.db", table: "t", limit: 100 }).success);
    assert.ok(!inspectRequest.safeParse({ op: "rows", placeId: "service:api", table: "t" }).success, "only data and cache lanes");
    assert.ok(!inspectRequest.safeParse({ op: "rows", placeId: "data:a", table: "t", limit: 5000 }).success);
    assert.ok(!inspectRequest.safeParse({ op: "tables", placeId: "data:a", sql: "DROP TABLE t" }).success, "no extra fields, so no SQL");
  } finally {
    await ing.close();
    await plain.close();
  }
});
