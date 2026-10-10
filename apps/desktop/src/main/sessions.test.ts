import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActionView, DebugEvent } from "@shrike/schema";
import { lastSession, loadSession, MAX_ACTIONS, saveSession, sessionFile, SessionSync } from "./sessions.ts";
import { Store } from "./store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (c: string, n: number) => c.repeat(n);

function trip(store: Store, c: string, label: string, failed = false) {
  const traceId = hex(c, 32);
  const root: DebugEvent = { id: hex(c, 16), traceId, origin: "server", kind: "user_action", name: label, startMs: Date.now(), status: failed ? "error" : "ok", trigger: "server" };
  const fn: DebugEvent = { id: `${hex(c, 15)}f`, traceId, parentId: root.id, origin: "server", kind: "function", name: "createTodo()", startMs: Date.now(), durationMs: 3, status: failed ? "error" : "ok", source: { file: "server/todos.ts", line: 18, precision: "exact" } };
  store.handle({ type: "events", events: [root, fn] });
  store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
}

const shape = (views: ActionView[]) => views.map((v) => ({ id: v.id, label: v.label, status: v.status, tree: v.tree.map((n) => [n.event.name, n.event.source?.line]) }));

test("sessions: trips survive a restart, the newest project is offered, damaged lines are skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-sessions-"));
  const a = new Store({ projectRoot: () => "/proj", onUpdate: () => {} });
  trip(a, "a", 'Clicked "Add Todo"', true);
  trip(a, "b", "GET /api/todos");
  await sleep(700);
  const before = a.listActions();
  assert.equal(before.filter((v) => v.complete).length, 2);

  const sync = new SessionSync({ dir, root: () => "/proj", name: () => "todo-app", list: () => a.listActions(), handle: (m) => a.handle(m) });
  await sync.tick(); // opens: nothing to restore yet
  await sync.tick(); // saves
  assert.equal(readFileSync(sessionFile(dir, "/proj"), "utf8").trim().split("\n").length, 3);

  // A new app session: the same project comes back with the same trips.
  const b = new Store({ projectRoot: () => "/proj", onUpdate: () => {} });
  const again = new SessionSync({ dir, root: () => "/proj", name: () => "todo-app", list: () => b.listActions(), handle: (m) => b.handle(m) });
  await again.tick();
  await sleep(700);
  assert.deepEqual(shape(b.listActions()), shape(before));
  assert.equal(b.listActions().every((v) => v.complete), true);

  const meta = await lastSession(dir);
  assert.deepEqual({ ...meta, at: 0 }, { root: "/proj", name: "todo-app", at: 0, actionIds: before.map((v) => v.id) });
  await saveSession(dir, "/other", "shop-app", [], Date.now() + 1000); // no trips: never offered
  assert.equal((await lastSession(dir))?.root, "/proj");

  writeFileSync(sessionFile(dir, "/proj"), `${readFileSync(sessionFile(dir, "/proj"), "utf8")}{not json\n{"events":[{"id":"x","kind":"log"}]}\n`);
  assert.equal((await loadSession(dir, "/proj")).length, 2);
  assert.equal(await lastSession(join(dir, "missing")), null);
});

test("sessions: capped at the newest MAX_ACTIONS complete trips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-sessions-"));
  const view = (i: number) => ({ id: i.toString(16).padStart(16, "0"), complete: i !== MAX_ACTIONS + 9, root: { id: String(i), kind: "user_action" }, tree: [] }) as unknown as ActionView;
  await saveSession(dir, "/big", "big", Array.from({ length: MAX_ACTIONS + 10 }, (_, i) => view(i + 1)));
  const meta = (await lastSession(dir))!;
  assert.equal(meta.actionIds.length, MAX_ACTIONS);
  assert.equal(meta.actionIds[0], view(10).id);
  assert.ok(!meta.actionIds.includes(view(MAX_ACTIONS + 9).id), "incomplete trips wait for the next save");
});
