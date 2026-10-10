import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamParser } from "../src/claude-code.ts";
import { thinkingText, toolResultStep, toolUseStep, usageDelta, type StepInput } from "../src/steps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("X1 activity: plain words with the target, per tool", () => {
  const act = (tool: string, input: unknown) => toolUseStep(`mcp__shrike__${tool}`, input).activity;
  assert.equal(act("read_file", { path: "server/todos.controller.ts", startLine: 10, endLine: 30 }), "Reading todos.controller.ts lines 10-30");
  assert.equal(act("read_file", { path: "server/db.ts" }), "Reading db.ts");
  assert.equal(act("read_file", { path: "server/db.ts", startLine: 40 }), "Reading db.ts from line 40");
  assert.equal(act("search_code", { query: "userId" }), "Searching for userId");
  assert.equal(act("app_click", { ref: "e2", name: "Add Todo" }), "Clicking Add Todo");
  assert.equal(act("app_click", { ref: "e2" }), "Clicking an element");
  assert.equal(act("app_type", { ref: "e3", name: "Title", text: "milk" }), "Typing into Title");
  assert.equal(act("propose_patch", { files: [{ path: "server/db.ts", edits: [] }] }), "Proposing a change to db.ts");
  assert.equal(act("propose_patch", { files: [{ path: "a/x.ts" }, { path: "b/y.ts" }, { path: "c/z.ts" }] }), "Proposing a change to x.ts and 2 other files");
  assert.equal(act("send_request", { method: "post", url: "/api/todos" }), "Sending POST /api/todos");
  assert.equal(act("get_action", { actionId: "x" }), "Reading what happened");
});

test("X2 files: reads with their real range, search hits per file, proposed edits", () => {
  const read = toolResultStep("mcp__shrike__read_file", "server/todos.controller.ts lines 10-30\n10| x", false);
  assert.deepEqual(read.files, [{ path: "server/todos.controller.ts", action: "read", lines: [10, 30] }]);
  assert.equal(toolResultStep("mcp__shrike__read_file", "server/x.ts lines 1-2", true).files, undefined); // errors touch nothing

  const search = toolResultStep("mcp__shrike__search_code", "server/a.ts:18: const userId\nserver/db.ts:9: run(x)\nserver/db.ts:4: insert(userId)", false);
  assert.deepEqual(search.files, [
    { path: "server/a.ts", action: "search", lines: [18, 18] },
    { path: "server/db.ts", action: "search", lines: [4, 9] },
  ]);
  assert.equal(toolResultStep("mcp__shrike__search_code", 'No matches for "zzz".', false).files, undefined);

  const spaced = toolResultStep("mcp__shrike__read_file", "src/My Page.tsx lines 1-5\n1| x", false);
  assert.deepEqual(spaced.files, [{ path: "src/My Page.tsx", action: "read", lines: [1, 5] }]);
  assert.equal(spaced.text, "Read My Page.tsx lines 1 to 5");

  const patch = toolUseStep("mcp__shrike__propose_patch", { files: [{ path: "server/db.ts", edits: [] }, { path: "server/db.ts", edits: [] }], rationale: "r" });
  assert.deepEqual(patch.files, [{ path: "server/db.ts", action: "edit" }]);
});

test("X3/X6 from a recorded stream: thinking rides on the next step, usage per turn sums to the run, cost on done", async () => {
  const text = await fs.readFile(path.join(here, "fixtures", "claude-xray.jsonl"), "utf8");
  for (const chunk of [3, 4096]) {
    const steps: StepInput[] = [];
    const p = createStreamParser((s) => steps.push(s));
    for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
    p.end();
    assert.deepEqual(steps.map((s) => s.kind), ["message", "message", "tool_result", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call", "patch", "message", "done"]);

    // the thinking-only first line has no step of its own: it lands on the text that follows
    assert.match(steps[0]!.thinking!, /userId but the insert says undefined/);
    assert.equal(steps[0]!.text, "This looks like a value going missing, so I'll use the bad-value playbook.");
    assert.equal(steps[1]!.tool, "load_skill");
    assert.equal(steps[1]!.thinking, undefined);
    assert.match(steps[7]!.thinking!, /Fix the casing/);
    assert.equal(steps[7]!.activity, "Proposing a change to todos.controller.ts");

    // msg_1 spans three lines: the first step carries it, the later ones only what each line added
    assert.deepEqual(steps[0]!.usage, { input: 3, output: 80, cacheRead: 0, cacheWrite: 6000 });
    assert.deepEqual(steps[1]!.usage, { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(steps[3]!.usage, { input: 2, output: 30, cacheRead: 6000, cacheWrite: 400 });
    const sum = steps.reduce((a, s) => a + (s.usage?.output ?? 0), 0);
    assert.equal(sum, 95 + 30 + 25 + 120 + 20);
    assert.equal(steps.reduce((a, s) => a + (s.usage?.cacheRead ?? 0), 0), 6000 + 6400 + 7300 + 7600);
    assert.deepEqual(steps.at(-1)!.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.0421 });

    assert.deepEqual(steps[4]!.files, [{ path: "server/todos.controller.ts", action: "read", lines: [10, 30] }]);
    assert.deepEqual(steps[6]!.files?.map((f) => f.path), ["server/todos.controller.ts", "server/db.ts"]);
  }
});

test("usage deltas and thinking trim", () => {
  assert.equal(usageDelta({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }), undefined);
  assert.deepEqual(usageDelta(undefined, { input: 1, output: 5, cacheRead: 2, cacheWrite: 3 }), { input: 1, output: 5, cacheRead: 2, cacheWrite: 3 });
  const long = thinkingText(`start ${"x".repeat(3000)} end`)!;
  assert.ok(long.length <= 1200 && long.startsWith("…") && long.endsWith("end"));
  assert.equal(thinkingText("   "), undefined);
});

test("X6 real CLI stream: per-line output undercounts, the done step carries the rest so the steps add up to the result", async () => {
  const steps: StepInput[] = [];
  let out = 0;
  const p = createStreamParser((s) => steps.push(s), { onUsage: (u) => (out = u.outputTokens) });
  p.push(await fs.readFile(path.join(here, "fixtures", "claude-stream.jsonl"), "utf8"));
  p.end();
  assert.equal(out, 109);
  assert.equal(steps.reduce((a, s) => a + (s.usage?.output ?? 0), 0), 109);
  assert.equal(steps.at(-1)!.kind, "done");
  assert.equal(steps.at(-1)!.usage!.output, 109 - 24 - 50);
});
