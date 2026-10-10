import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentStep } from "@shrike/schema";
import { activeSkill, activityOf, fileTouches, latestThinking, mcpCall, mcpTimings, mcpUsage, readPaths, turnTokens, wasRead } from "./xray.ts";

let n = 0;
const st = (s: Partial<AgentStep>): AgentStep => ({ id: `s${n++}`, runId: "r", kind: "tool_call", text: "", createdAt: n, ...s });

test("X2 chips: one per file, strongest action, counts and distinct ranges", () => {
  const steps = [
    st({ files: [{ path: "server/a.ts", action: "search", lines: [18, 18] }, { path: "server/db.ts", action: "search", lines: [4, 9] }] }),
    st({ files: [{ path: "server/a.ts", action: "read", lines: [10, 30] }] }),
    st({ files: [{ path: "server/a.ts", action: "read", lines: [10, 30] }] }),
    st({ files: [{ path: "server/a.ts", action: "edit" }] }),
  ];
  const [a, db] = fileTouches(steps);
  const { by, ...rest } = a!;
  assert.deepEqual(rest, { path: "server/a.ts", action: "edit", count: 4, ranges: [[18, 18], [10, 30]], first: "search" });
  assert.deepEqual(by, { search: { count: 1, ranges: [[18, 18]] }, read: { count: 2, ranges: [[10, 30]] }, edit: { count: 1, ranges: [] } });
  assert.equal(db!.action, "search");
  assert.deepEqual(readPaths(steps), ["server/a.ts"]);
  assert.ok(wasRead(["server/a.ts"], "a.ts") && wasRead(["a.ts"], "server/a.ts") && !wasRead(["server/a.ts"], "server/db.ts"));
});

test("X6 tokens: later lines fold into their turn, cost shared by weight, costliest marked", () => {
  const steps = [
    st({ usage: { input: 3, output: 80, cacheRead: 0, cacheWrite: 6000 } }),
    st({ usage: { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 } }),
    st({ kind: "tool_result" }),
    st({ usage: { input: 2, output: 30, cacheRead: 6000, cacheWrite: 400 } }),
    st({ kind: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 } }),
  ];
  const { turns, total, costliest } = turnTokens(steps);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.output, 95);
  assert.deepEqual({ ...total, costUsd: +total.costUsd!.toFixed(6) }, { input: 5, output: 125, cacheRead: 6000, cacheWrite: 6400, costUsd: 0.1 });
  assert.ok(Math.abs(turns.reduce((a, t) => a + t.costUsd!, 0) - 0.1) < 1e-9);
  assert.equal(costliest, turns[0]!.stepId);
  assert.equal(turnTokens([st({ usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } })]).costliest, undefined); // one turn: nothing to compare
});

test("X1/X3/X4: activity, latest thinking, skill and why", () => {
  const steps = [
    st({ kind: "message", text: "This looks like a missing value, so I'll use the bad-value playbook.", thinking: "first" }),
    st({ kind: "message", tool: "load_skill", skill: "bad-value", text: "Using the bad value playbook" }),
    st({ activity: "Reading todos.controller.ts lines 10-30", text: "Reading server/todos.controller.ts", skill: "bad-value", thinking: "second" }),
  ];
  assert.equal(activityOf(steps), "Reading todos.controller.ts lines 10-30");
  assert.equal(latestThinking(steps), "second");
  assert.deepEqual(activeSkill(steps), { id: "bad-value", why: "This looks like a missing value, so I'll use the bad-value playbook." });
  assert.deepEqual(activeSkill([st({ skill: "n-plus-one" })]), { id: "n-plus-one" });
  assert.equal(activityOf([st({ kind: "done", text: "Done", summary: "Fixed and verified" })]), "Fixed and verified");
});

test("X2: a rejected proposal is no change; an applied one is", () => {
  const read = st({ kind: "tool_result", tool: "read_file", files: [{ path: "server/db.ts", action: "read", lines: [1, 40] }] });
  const call = st({ tool: "propose_patch", files: [{ path: "server/db.ts", action: "edit" }] });
  const [rej] = fileTouches([read, call, st({ kind: "patch", tool: "propose_patch", text: "Fix rejected" })]);
  assert.deepEqual([rej!.action, rej!.count, rej!.by.edit], ["read", 1, undefined]);
  const [ok] = fileTouches([read, call, st({ kind: "patch", tool: "propose_patch", text: "Fix applied" })]);
  assert.deepEqual([ok!.action, ok!.applied, ok!.by.read?.ranges], ["edit", true, [[1, 40]]]);
  assert.equal(fileTouches([read, call])[0]!.applied, undefined); // still waiting: proposed, not changed
});

test("X1: a result keeps its call's target; X6: the result line's correction is shared over turns", () => {
  const call = st({ tool: "search_code", activity: "Searching for userId", text: "Searching the code" });
  assert.equal(activityOf([call, st({ kind: "tool_result", tool: "search_code", text: "Found 3 matches" })]), "Searching for userId");
  assert.equal(activityOf([st({ kind: "message", tool: "load_skill", text: "Using the bad value playbook" }), st({ kind: "tool_result", tool: "load_skill", text: "Playbook: Bad value" })]), "Using the bad value playbook");
  const { turns, total } = turnTokens([
    st({ usage: { input: 2, output: 24, cacheRead: 0, cacheWrite: 4246 } }),
    st({ usage: { input: 2, output: 50, cacheRead: 4246, cacheWrite: 109 } }),
    st({ kind: "done", usage: { input: 0, output: 35, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 } }),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(total.output, 109);
});

test("MCP6: calls to the user's own MCP servers parse from mcp__<server>__<tool>, with timing and a per-run strip", () => {
  assert.deepEqual(mcpCall("mcp__chrome-devtools__take_snapshot"), { server: "chrome-devtools", tool: "take_snapshot" });
  assert.deepEqual(mcpCall("mcp__my_db__run__query"), { server: "my_db", tool: "run__query" });
  assert.equal(mcpCall("read_file"), undefined, "Shrike's own tools arrive without the prefix");
  assert.equal(mcpCall(undefined), undefined);
  const at = (t: number, s: Partial<AgentStep>) => ({ ...st(s), createdAt: t });
  const steps = [
    at(1000, { id: "c1", tool: "mcp__chrome-devtools__take_snapshot" }),
    at(1400, { kind: "tool_result", tool: "mcp__chrome-devtools__take_snapshot", text: "uid=1 button" }),
    at(1500, { id: "r", tool: "read_file" }),
    at(2000, { id: "c2", tool: "mcp__chrome-devtools__click" }),
    at(2100, { id: "g", tool: "mcp__github__get_issue" }),
    at(2600, { kind: "tool_result", tool: "mcp__github__get_issue", text: "Problem: 401" }),
    at(3200, { kind: "tool_result", tool: "mcp__chrome-devtools__click", text: "Clicked" }),
  ];
  const t = mcpTimings(steps);
  assert.deepEqual([t.get("c1"), t.get("c2"), t.get("g")], [{ ms: 400 }, { ms: 1200 }, { ms: 500, failed: true }]);
  assert.equal(t.get("r"), undefined);
  assert.deepEqual(mcpUsage(steps), [
    { server: "chrome-devtools", calls: 2, ms: 1600, tools: ["take_snapshot", "click"], failed: 0 },
    { server: "github", calls: 1, ms: 500, tools: ["get_issue"], failed: 1 },
  ]);
});
