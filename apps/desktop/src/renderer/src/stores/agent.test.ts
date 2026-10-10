import { after, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunInfo, AgentStep, ShrikeApi } from "@shrike/schema";

const calls: string[] = [];
const run = (id: string, extra: Partial<AgentRunInfo> = {}): AgentRunInfo => ({ id, goal: "g", brain: "claude-code", status: "running", ...extra });
const fake: Partial<ShrikeApi> = {
  askAside: async (runId, q) => (calls.push(`aside ${runId} ${q}`), run("a1", { parentRunId: runId, aside: true, name: "cache" })),
  keepAside: async (id, name) => (calls.push(`keep ${id}`), run(id, { parentRunId: "m1", name: name ?? "cache", color: "violet", status: "done" })),
  stopAgent: async (id) => void calls.push(`stop ${id}`),
  branchRun: async (runId, stepId, q) => (calls.push(`branch ${runId} ${stepId} ${q}`), run("b1", { parentRunId: runId, branchFromStepId: stepId, name: "cache", color: "violet" })),
};
const g = globalThis as { window?: unknown };
const before = g.window;
g.window = { shrike: fake };
after(() => void (g.window = before)); // the suite shares one process

const { useAgent, branchLines, branchState, onUsage, shownUsage } = await import("./agent.ts");
const step = (runId: string, kind: AgentStep["kind"], text = "x", extra: Partial<AgentStep> = {}): AgentStep => ({ id: Math.random().toString(16), runId, kind, text, createdAt: 1, ...extra });

test("C3 aside lifecycle: its status and steps stay off main; keep makes it a branch; dismiss discards it", async () => {
  const s = useAgent.getState;
  s().onStatus(run("m1"));
  s().onStep(step("m1", "message", "main step"));
  assert.equal(await s().askAside("Is it the cache?"), true);
  assert.deepEqual(calls, ["aside m1 Is it the cache?"]);
  s().onStatus(run("a1", { parentRunId: "m1", aside: true }));
  s().onStep(step("a1", "done", "Done", { detail: "No." }));
  assert.equal(s().run?.id, "m1"); // the main run the cards and the probe follow is unchanged
  assert.deepEqual(s().steps.map((x) => x.text), ["main step"]);
  assert.deepEqual(s().runSteps.a1?.map((x) => x.detail), ["No."]);
  assert.equal(s().aside, "a1");
  assert.deepEqual(branchLines(s()).branches, []); // an aside never draws a line

  s().dismissAside();
  assert.equal(s().aside, null);
  assert.equal(s().runs.a1, undefined);
  assert.equal(s().runSteps.a1, undefined);
  assert.equal(calls.at(-1), "stop a1");

  await s().askAside("Is it the cache?");
  await s().keepAside("cache");
  assert.equal(s().aside, null);
  assert.equal(s().viewing, "a1");
  assert.deepEqual(branchLines(s()).branches.map((b) => b.id), ["a1"]);
});

test("C2 map: branches of main's conversation only; a fresh main run starts a new map", async () => {
  const s = useAgent.getState;
  await s().branch("m1", "st1", "What about strings?");
  assert.equal(s().viewing, "b1");
  s().onStatus(run("b1", { parentRunId: "m1", name: "cache", color: "violet" }));
  s().onStep(step("b1", "tool_call", "Reading"));
  assert.equal(s().run?.id, "m1");
  assert.deepEqual(branchLines(s()).branches.map((b) => b.id), ["a1", "b1"]);
  assert.equal(branchState(s().runs.b1!, s().runSteps.b1!), "thinking");
  assert.equal(branchState({ ...s().runs.b1!, status: "done" }, [step("b1", "patch", "Changed", { tool: "worktree_diff" })]), "fixed");
  assert.equal(branchState({ ...s().runs.b1!, status: "stopped" }, []), "stopped");

  s().onStatus(run("m2", { continues: "m1" })); // main resumed with a branch's finding: same map
  assert.deepEqual(branchLines(s()).main.map((r) => r.id), ["m2", "m1"]);
  assert.equal(branchLines(s()).branches.length, 2);
  s().onStep(step("m2", "done", "Done"));
  s().onStatus(run("m3")); // a new question: a new conversation
  assert.deepEqual(s().steps, [], "a run main started shows its own steps, not the last run's Done");
  assert.deepEqual(branchLines(s()).branches, []);
  assert.equal(s().viewing, null);
});

test("X5 usage: a branch's or an aside's tokens never land on main's ring; the ring shows the run on show", () => {
  const u = (runId: string, contextTokens: number) => ({ runId, inputTokens: 1, outputTokens: 1, contextTokens, contextLimit: 100 });
  const runs = { m: run("m"), b: run("b", { parentRunId: "m" }), a: run("a", { parentRunId: "m", aside: true }) };
  const st = { run: null, runs, usage: null, usageBy: {}, viewing: null as string | null }; // after a relaunch: no live main run
  Object.assign(st, onUsage(st, u("b", 50)));
  Object.assign(st, onUsage(st, u("a", 70)));
  assert.equal(st.usage, null);
  Object.assign(st, onUsage(st, u("m", 10)));
  assert.equal(shownUsage(st)?.contextTokens, 10);
  st.viewing = "b";
  assert.equal(shownUsage(st)?.contextTokens, 50);
});
