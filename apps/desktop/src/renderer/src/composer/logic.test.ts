import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunInfo, AgentStep } from "@shrike/schema";
import { answerOf, atQuery, dropAt, turns } from "./logic.ts";

test("@ under the caret opens the file list; an email or a finished word does not", () => {
  assert.deepEqual(atQuery("look at @todo", 13), { start: 8, query: "todo" });
  assert.deepEqual(atQuery("@", 1), { start: 0, query: "" });
  assert.equal(atQuery("mail me@x.com", 13), null);
  assert.equal(atQuery("look at @todo now", 17), null);
  assert.equal(dropAt("look at @todo now", 8, 13), "look at now");
});

const run = (id: string, goal: string, extra: Partial<AgentRunInfo> = {}): AgentRunInfo => ({ id, goal, brain: "claude-code", status: "done", ...extra });
const step = (runId: string, kind: AgentStep["kind"], text: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id: `${runId}-${text}`, runId, kind, text, createdAt: 0, ...extra });

test("turns: your prompt, the agent's answer, steps collapsed, branches marked, asides left out", () => {
  const steps: Record<string, AgentStep[]> = {
    a: [step("a", "tool_call", "Reading todos.controller.ts"), step("a", "findings", "Found it", { findings: [{ confidence: "observed", claim: "The form sends userId", file: "todos.controller.ts", line: 18 }] })],
    b: [step("b", "message", "Trying the cache"), step("b", "done", "Done", { summary: "The cache was stale." })],
  };
  const list = turns([run("a", "Add Todo does nothing\nContext: the file api.ts"), run("x", "side?", { aside: true }), run("b", "try the cache", { parentRunId: "a", name: "try the cache", color: "amber", status: "running" })], (id) => steps[id]);
  assert.equal(list.length, 2);
  assert.deepEqual([list[0]!.prompt, list[0]!.context], ["Add Todo does nothing", ["the file api.ts"]]);
  assert.equal(list[0]!.answer, "**Observed.** The form sends userId → `todos.controller.ts:18`");
  assert.equal(list[0]!.steps.length, 1);
  assert.deepEqual([list[1]!.branch, list[1]!.state, list[1]!.answer], [{ name: "try the cache", color: "amber" }, "working", "The cache was stale."]);
  assert.equal(answerOf([]), undefined);
});
