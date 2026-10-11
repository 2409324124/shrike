import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bandParts, guardReason, parseTrip, resultText, sameView, summaryText } from "../hooks/trips.js";

const broke = parseTrip('t1  Clicked "Add Todo"  broke  12ms  at server/todos.ts:18\nt0  Loaded /  worked  80ms');

test("reads the newest trip from list_trips", () => {
  assert.deepEqual(broke, { id: "t1", label: 'Clicked "Add Todo"', verdict: "broke", ms: 12, at: "server/todos.ts:18" });
  assert.deepEqual(parseTrip("t2  POST /api/todos  worked  9ms"), { id: "t2", label: "POST /api/todos", verdict: "worked", ms: 9 });
  assert.equal(parseTrip("No trips yet."), null);
  assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
});

test("band and /shrike say the same thing; nothing is drawn while Shrike is away", () => {
  const view = { up: true, trip: broke };
  assert.deepEqual(bandParts(view), [{ text: "Shrike", dimColor: true }, { text: '  Clicked "Add Todo"  ' }, { text: "broke", color: "error" }, { text: " at server/todos.ts:18", dimColor: true }]);
  assert.equal(summaryText(view), 'Latest trip: Clicked "Add Todo" broke at server/todos.ts:18 (12ms).');
  assert.equal(bandParts({ up: false, trip: broke }), null);
  assert.equal(bandParts({ up: true, trip: null }), null);
  assert.match(summaryText({ up: false, trip: null }), /^Shrike isn't connected\. Open Shrike, then run \/mcp/);
  assert.match(summaryText({ up: true, trip: null }), /No trips yet/);
  assert.ok(sameView(view, { up: true, trip: { ...broke } }), "an unchanged trip doesn't redraw");
  assert.ok(!sameView(view, { up: true, trip: { ...broke, id: "t9" } }));
});

test("the opt-in guard only turns back edits to project files while Shrike is connected", () => {
  const at = { enabled: true, up: true, tool: "Edit", path: "/work/src/a.ts", root: "/work" };
  assert.match(guardReason(at), /propose_patch/);
  assert.equal(guardReason({ ...at, enabled: false }), undefined);
  assert.equal(guardReason({ ...at, up: false }), undefined);
  assert.equal(guardReason({ ...at, path: "/workshop/a.ts" }), undefined);
  assert.equal(guardReason({ ...at, tool: "Read" }), undefined);
});

test("the plugin's skill is prompts/connect/SKILL.md apart from its name", async () => {
  const source = await readFile(new URL("../../../prompts/connect/SKILL.md", import.meta.url), "utf8");
  const copy = await readFile(new URL("../skills/debug/SKILL.md", import.meta.url), "utf8");
  assert.equal(copy, source.replace(/^name: shrike$/m, "name: debug"), "copy prompts/connect/SKILL.md over skills/debug/SKILL.md and keep name: debug");
});
