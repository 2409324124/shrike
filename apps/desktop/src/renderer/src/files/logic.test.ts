import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionView, DebugEvent, SourceLocation, TimelineNode } from "@shrike/schema";
import { buildTrip } from "../lib/thread-layout.ts";
import { cardsOf, fileSteps, flatRows, focusKey, layoutStrip, links, moveOf, placeKey, section, stateAt, treeLayout } from "./logic.ts";

// The killer demo trip as main records it in fixtures/todo-app: Add Todo -> api.ts -> server -> controller L18 -> db.ts -> SQLite refuses.
const at = (file: string, line: number): SourceLocation => ({ file, line, precision: "exact" });
let n = 0;
const ev = (p: Partial<DebugEvent> & Pick<DebugEvent, "kind" | "name">): DebugEvent => ({ id: String(++n).padStart(16, "0"), traceId: "t".repeat(32), origin: "server", startMs: n, durationMs: 1, status: "ok", ...p });
const node = (event: DebugEvent, children: TimelineNode[] = []): TimelineNode => (children.forEach((c) => (c.event.parentId = event.id)), { event, children });

function addTodo(): ActionView {
  const root = ev({ kind: "user_action", origin: "browser", name: 'Clicked "Add Todo"', trigger: "click", status: "error", source: at("src/TodoForm.tsx", 31) });
  const err = "NOT NULL constraint failed: todos.user_id";
  const tree = [
    node(ev({ kind: "http_request", origin: "browser", name: "POST /api/todos", status: "error", source: at("src/api.ts", 12), http: { method: "POST", url: "/api/todos", status: 500, reqBody: '{"title":"buy milk","userId":1}' } }), [
      node(ev({ kind: "http_request", name: "POST /api/todos", status: "error", source: at("server/index.ts", 10), http: { method: "POST", url: "/api/todos", status: 500 } }), [
        node(ev({ kind: "function", name: "createTodo()", status: "error", source: at("server/todos.controller.ts", 14), args: ["req { POST /api/todos }", "res"] }), [
          node(ev({ kind: "log", name: "creating todo", log: { level: "info", message: "creating todo { title: 'buy milk' }" }, source: at("server/todos.controller.ts", 16) })),
          node(ev({ kind: "function", name: "insertTodo()", status: "error", source: at("server/db.ts", 33), callSite: at("server/todos.controller.ts", 18), args: ["{ title: 'buy milk', userId: undefined }"], error: { message: err } }), [
            node(ev({ kind: "db_query", origin: "db", name: "INSERT INTO todos", status: "error", db: { system: "sqlite", statement: "INSERT INTO todos (title, user_id) VALUES (?, ?)", params: "[ 'buy milk', null ]" }, source: at("server/db.ts", 36), error: { message: err } })),
          ]),
        ]),
        node(ev({ kind: "function", name: "handleError()", source: at("server/index.ts", 15), args: [`SqliteError: ${err}`] })),
      ]),
    ]),
  ];
  for (const c of tree) c.event.parentId = root.id;
  return { id: root.id, traceId: root.traceId, trigger: "click", label: root.name, startMs: 0, durationMs: 48, status: "error", complete: true, tree, root, summary: { headline: "", steps: [], stats: { files: 0, functions: 0, requests: 0, queries: 0, logs: 0, errors: 0, totalMs: 48 } }, flags: [] };
}

const view = addTodo();
const trip = buildTrip(view);
const steps = fileSteps(view, trip);
const cards = cardsOf(steps);
const order = [...cards.files, ...cards.places].map((c) => c.key);
const insert = steps.findIndex((s) => s.label === "insertTodo()");

test("step mapping: each station lights the file and line where its code is; a call lights its call site and enters its own file", () => {
  assert.equal(steps.length, trip.stations.length, "one step per Thread station: the two views share the index");
  assert.deepEqual([steps[0]!.file, steps[0]!.line, steps[0]!.weak], ["src/TodoForm.tsx", 31, "Used here"]);
  const fetch = steps.find((s) => s.file === "src/api.ts")!;
  assert.equal(fetch.line, 12);
  const s = steps[insert]!;
  assert.deepEqual([s.file, s.line, s.def, s.err], ["server/todos.controller.ts", 18, 14, true], "the failing line is controller L18, inside createTodo from L14");
  assert.deepEqual(s.enter, { file: "server/db.ts", line: 33 });
  assert.deepEqual(s.facts.find((f) => f.k === "ARGS"), { k: "ARGS", v: "{ title: 'buy milk', userId: undefined }", err: true });
  assert.deepEqual(s.stack.map((f) => f.label), ["click", "POST /api/todos", "POST /api/todos", "createTodo", "insertTodo"]);
  assert.equal(s.stack.at(-1)!.at, "todos.controller.ts:18");
  const q = steps[insert + 1]!;
  assert.equal(q.place?.kind, "data", "the database is a place card, not a file");
  assert.deepEqual([q.file, q.line, q.snap], ["server/db.ts", 36, true], "hung from the line that asked it");
  const back = steps.find((x) => x.label === "handleError()")!;
  assert.deepEqual(back.gone.map((f) => f.label), ["createTodo", "insertTodo"], "returning to the error handler unwinds the frames");
});

test("cards run in story order, keyed by where the code is; the database sits on the shelf past the gate", () => {
  assert.deepEqual(cards.files.map((c) => c.key), ["src/TodoForm.tsx", "src/api.ts", "server/index.ts", "server/todos.controller.ts", "server/db.ts"]);
  assert.deepEqual(cards.places.map((c) => c.place!.kind), ["data"]);
  const strip = layoutStrip(cards, { start: 0, cw: 500, gap: 56, gate: 132, pw: 270 });
  assert.deepEqual(strip.gates.map((g) => g.label), ["SERVER", "OUTSIDE YOUR PROJECT"]);
  assert.ok(strip.x["server/index.ts"]! > strip.gates[0]!.x && strip.gates[0]!.x > strip.x["src/api.ts"]! + 500, "the lane gate sits between PAGE and SERVER cards");
  const ls = links(steps, order);
  const ret = ls.filter((l) => l.ret);
  assert.ok(ls.some((l) => l.from.key === "server/todos.controller.ts" && l.from.line === 18 && l.to.key === "server/db.ts" && l.err), "the thread leaves L18 for db.ts, red");
  assert.ok(ret.length && ret.every((l) => l.to.key === "server/index.ts"), "the error runs back left to index.ts, never a new card");
});

test("reverse stepping: the state at a step is the same whether you got there forward or back", () => {
  const forward = steps.map((_, k) => stateAt(steps, k));
  const last = steps.length - 1;
  for (let k = last; k >= 0; k--) assert.deepEqual(stateAt(steps, k), forward[k]);
  const s = stateAt(steps, insert);
  assert.equal(s.focus, "server/todos.controller.ts");
  assert.ok(s.failed.has("server/todos.controller.ts") && !s.failed.has("src/api.ts"), "red only where it broke");
  assert.deepEqual([...s.open].sort(), ["", "server", "src"]);
  assert.deepEqual([...stateAt(steps, 0).open], ["", "src"], "back at the click, server/ is closed again");
  assert.equal(stateAt(steps, insert + 1).focus, placeKey(steps[insert + 1]!.place!));
  const m = moveOf(steps, order, insert, 1);
  assert.equal(m.dir, -1);
  assert.equal(m.pan, Math.min(1100, Math.round(520 * Math.sqrt(m.slots))), "a long hop back pans in one capped move");
  assert.equal(moveOf(steps, order, insert - 1, insert).pan, 0, "same file: the card scrolls, the camera stays");
  assert.equal(focusKey(steps, 99), focusKey(steps, last), "past the end stays on the last step");
});

test("section: the function round the live line, or a weak window", () => {
  const api = ["export type Todo = {};", "", "export async function createTodo(title: string) {", "  const body = { title };", '  const res = await fetch("/api/todos", {', '    method: "POST",', "  });", "  return res.json();", "}", ""];
  assert.deepEqual(section(api, 5), { start: 3, end: 9, weak: false });
  assert.deepEqual(section(['app.post("/api/todos", createTodo);'], 1), { start: 1, end: 1, weak: true });
});

test("tree layout and level of detail: closed folders hide their rows at the folder's own y, and reopen in place", () => {
  const nodes = [
    { name: "server", path: "server", dir: true, count: 5, children: [{ name: "db.ts", path: "server/db.ts", dir: false }, { name: "+ 38 more", path: "server/#fold1", dir: false, fold: 38 }] },
    { name: "src", path: "src", dir: true, count: 6, children: [{ name: "api.ts", path: "src/api.ts", dir: false }] },
    { name: "node_modules", path: "node_modules", dir: true, ignored: true },
  ];
  const rows = flatRows(nodes, "todo-app");
  assert.deepEqual(rows.map((r) => r.node.path), ["", "server", "server/db.ts", "server/#fold1", "src", "src/api.ts", "node_modules"]);
  const closed = treeLayout(rows, new Set([""]), 22);
  assert.deepEqual(closed.shown, [true, true, false, false, true, false, true]);
  assert.equal(closed.y[2], closed.y[1], "db.ts hides at server/");
  assert.equal(closed.height, 4 * 22);
  const open = treeLayout(rows, new Set(["", "server"]), 22);
  assert.deepEqual([open.y[2], open.y[3], open.y[4]], [44, 66, 88]);
});
