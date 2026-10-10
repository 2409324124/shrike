import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentStep } from "@shrike/schema";
import { createStreamParser } from "@shrike/agent";
import { createContextTracker } from "./context.ts";

const fixture = readFileSync(join(import.meta.dirname, "../../../../packages/agent/test/fixtures/claude-xray.jsonl"), "utf8");

function recordedSteps(runId: string): AgentStep[] {
  const out: AgentStep[] = [];
  const p = createStreamParser((s) => out.push({ ...s, id: `s${out.length}`, runId, createdAt: out.length }));
  p.push(fixture);
  p.end();
  return out;
}

test("X5 context map from a recorded run: first turn split, deltas per tool and per file, own words measured", () => {
  const t = createContextTracker();
  t.noteRun({ id: "r1", goal: "Why does Add Todo fail?\nThe user pointed at: button \"Add Todo\"" }, "- userId must be a number");
  t.noteLimit("r1", 1_000_000);
  let last = null;
  for (const s of recordedSteps("r1")) last = t.noteStep(s) ?? last;
  assert.ok(last);
  const seg = (kind: string, label?: string) => last!.segments.find((s) => s.kind === kind && (!label || s.label === label));

  // first turn: 3 + 6000 + 0 prompt tokens, split by char/4 for what Shrike knows, the rest is instructions
  const first = ["question", "context", "memory", "instructions"].map((k) => seg(k)!);
  assert.equal(first.reduce((a, s) => a + s.tokens, 0), 6003);
  assert.equal(seg("question")!.tokens, Math.ceil("Why does Add Todo fail?".length / 4));
  assert.ok(first.every((s) => s.estimated && s.stepId === "s0"));

  // turn 2: 6402 - 6003 - 95 own words, all from the one playbook result: measured, not estimated
  assert.deepEqual(seg("skill"), { kind: "skill", label: "Bad value", tokens: 6402 - 6003 - 95, estimated: false, stepId: "s2" });
  // turn 3: one read_file result, one segment per file
  const read = seg("file", "todos.controller.ts")!;
  assert.equal(read.tokens, 7302 - 6402 - 30);
  assert.equal(read.estimated, false);
  // the agent's own words are its output tokens
  assert.equal(seg("agent")!.tokens, 95 + 30 + 25 + 120 + 20);
  assert.equal(seg("agent")!.estimated, false);
  assert.equal(last!.limit, 1_000_000);
  // segments add up to the last prompt plus its answer
  assert.equal(last!.totalTokens, 2 + 200 + 7600 + 20);
});

test("several results in one turn are split by character share and marked estimated", () => {
  const t = createContextTracker();
  t.noteRun({ id: "r", goal: "q" });
  const step = (id: string, s: Partial<AgentStep>): AgentStep => ({ id, runId: "r", kind: "message", text: "", createdAt: 0, ...s });
  t.noteStep(step("a", { kind: "tool_call", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  t.noteStep(step("b", { kind: "tool_result", tool: "read_file", detail: "x".repeat(300), files: [{ path: "server/db.ts", action: "read", lines: [1, 9] }] }));
  t.noteStep(step("c", { kind: "tool_result", tool: "get_logs", detail: "y".repeat(100) }));
  const m = t.noteStep(step("d", { kind: "tool_call", usage: { input: 1400, output: 10, cacheRead: 0, cacheWrite: 0 } }))!;
  const db = m.segments.find((s) => s.label === "db.ts")!;
  const logs = m.segments.find((s) => s.label === "Logs")!; // plain words, not the tool id
  assert.deepEqual([db.tokens, logs.tokens, db.estimated, logs.estimated, db.stepId], [300, 100, true, true, "b"]);
  // compaction: a smaller prompt shrinks what is there to fit
  const after = t.noteStep(step("e", { kind: "message", usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } }))!;
  assert.ok(Math.abs(after.totalTokens - 500) <= after.segments.length);
  assert.equal(t.get("nope"), null);
});

test("real CLI stream: the result line's own words move back from the tool result that took them", () => {
  const raw = readFileSync(join(import.meta.dirname, "../../../../packages/agent/test/fixtures/claude-stream.jsonl"), "utf8");
  const steps: AgentStep[] = [];
  const p = createStreamParser((s) => steps.push({ ...s, id: `s${steps.length}`, runId: "r", createdAt: 0 }));
  p.push(raw);
  p.end();
  const t = createContextTracker();
  t.noteRun({ id: "r", goal: "q" });
  let m = null;
  for (const s of steps) m = t.noteStep(s) ?? m;
  const agent = m!.segments.find((s) => s.kind === "agent")!;
  const tool = m!.segments.find((s) => s.kind === "tool_result")!;
  assert.equal(agent.tokens, 109); // the result line's output_tokens, not 24 + 50
  assert.equal(tool.label, "What happened in the trip");
  assert.equal(tool.tokens, 4357 - 4248 - 109 + 50); // turn 2's new prompt minus turn 1's real words (109 - 50)
  assert.ok(tool.estimated);
  assert.equal(m!.totalTokens, 4357 + 50);
});

test("a resumed or forked run: the earlier conversation is its own segment", () => {
  const t = createContextTracker();
  const u = (input: number, cacheRead: number) => ({ input, output: 0, cacheRead, cacheWrite: 0 });
  t.noteRun({ id: "fresh", goal: "Why?" });
  t.noteStep({ id: "a", runId: "fresh", kind: "message", text: "", createdAt: 0, usage: u(4000, 0) });
  t.noteRun({ id: "next", goal: "And what about the delete button?", continues: "fresh" }, "- memory");
  const m = t.noteStep({ id: "b", runId: "next", kind: "message", text: "", createdAt: 0, usage: u(5, 52000) })!;
  const by = Object.fromEntries(m.segments.map((s) => [s.label, s.tokens]));
  assert.equal(by["Shrike's instructions and tools"], 4000 - 1);
  assert.equal(by["Earlier conversation"], 52005 - 9 - 3999);
  assert.equal(by["Project memory"], undefined); // already in the earlier conversation
  // no earlier size known: one honest segment
  const t2 = createContextTracker();
  t2.noteRun({ id: "b2", goal: "q", parentRunId: "gone" });
  const m2 = t2.noteStep({ id: "c", runId: "b2", kind: "message", text: "", createdAt: 0, usage: u(10, 900) })!;
  assert.deepEqual(m2.segments.map((s) => s.label), ["Your question", "Shrike's instructions and your earlier conversation"]);
});
