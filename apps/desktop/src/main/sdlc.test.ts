import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionView, Checkpoint, Flow, GitState, OptionsSession, Quest, QuestObjective } from "@shrike/schema";
import { computeBuild, computeSdlc, currentBuildStage, currentStage, type BuildInput, type SdlcInput } from "./sdlc.ts";
import { summarizeTests, testCommand } from "./tests.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trip = (id: string, startMs: number, status: ActionView["status"], label = 'Clicked "Add Todo"'): ActionView => ({
  id, traceId: "a".repeat(32), trigger: "click", label, startMs, durationMs: 40, status, complete: true, tree: [],
  root: { id, traceId: "a".repeat(32), origin: "browser", kind: "user_action", name: label, startMs, status },
  summary: { headline: "", steps: status === "error" ? [{ ok: false, text: "insertTodo() got userId: undefined", eventId: "x" }] : [], stats: { files: 0, functions: 0, requests: 0, queries: 0, logs: 0, errors: 0, totalMs: 40 } },
  flags: [],
});
const cp = (createdAt: number, current = true): Checkpoint => ({ id: `c${createdAt}`, patchId: `p${createdAt}`, label: "Read userId in createTodo", files: ["server/todos.controller.ts"], createdAt, current });
const repo: GitState = { isRepo: true, branch: "main", ahead: 0, behind: 0, changed: [], conflicts: [], ghReady: true };
const base: SdlcInput = { actions: [], findings: [], checkpoints: [], flows: [], tests: null, review: null, git: repo, race: null };
const at = (i: Partial<SdlcInput>) => {
  const s = computeSdlc({ ...base, ...i });
  return { s, cur: currentStage(s), line: Object.values(s.stages).join(" ") };
};

test("hidden when nothing broke", () => {
  const { s, cur } = at({ actions: [trip("a", 1, "ok")] });
  assert.equal(s.actionId, null);
  assert.equal(cur, null);
});

test("walks Spot → Understand → Fix → Prove → Review → Ship → Watch, one stage active at a time", () => {
  const broke = trip("a", 100, "error");
  const findings = [{ at: 200, summary: "The server reads the wrong field.", actionIds: ["a"] }];
  const fixed = [cp(300)];
  const rerun = trip("b", 400, "ok");
  const flows: Flow[] = [{ id: "f", name: "Add a todo", steps: [], lastRun: { at: 410, ok: true, actionIds: ["b"] } }];

  let r = at({ actions: [broke] });
  assert.equal(r.s.actionId, "a");
  assert.equal(r.line, "done active idle idle idle idle idle");
  assert.match(r.s.detail.spot!, /^Clicked "Add Todo" broke: insertTodo\(\) got userId: undefined/);

  r = at({ actions: [broke], findings });
  assert.equal(r.cur, "fix");
  assert.equal(r.s.detail.understand, "The server reads the wrong field.");

  r = at({ actions: [broke], findings, checkpoints: fixed });
  assert.equal(r.cur, "prove");
  assert.equal(r.line, "done done done active idle idle idle");

  r = at({ actions: [broke, rerun], findings, checkpoints: fixed, flows, tests: { ok: true, summary: "All 12 tests passed.", at: 420 } });
  assert.equal(r.cur, "review");
  assert.match(r.s.detail.prove!, /works now\. Your saved flow passed\. All 12 tests passed\./);
  assert.equal(r.s.tests, "All 12 tests passed.");

  r = at({ actions: [broke, rerun], findings, checkpoints: fixed, flows, review: { state: "concerns", at: 450, summary: "It misses empty titles.", findings: [{ confidence: "likely", claim: "x" }] } });
  assert.equal(r.s.stages.review, "failed");
  assert.equal(r.cur, "review");
  assert.equal(r.s.review?.length, 1);

  const reviewed = { state: "passed" as const, at: 450, summary: "Looks good.", findings: [] };
  const pr = { number: 42, title: "Fix", url: "u", state: "open" as const, checks: [{ name: "test", state: "fail" as const }] };
  r = at({ actions: [broke, rerun], findings, checkpoints: fixed, flows, review: reviewed, git: { ...repo, pr } });
  assert.equal(r.s.stages.ship, "failed");
  assert.equal(r.s.detail.ship, "PR #42: test failed.");

  r = at({ actions: [broke, rerun], findings, checkpoints: fixed, flows, review: reviewed, git: { ...repo, pr: { ...pr, state: "merged" } } });
  assert.equal(r.cur, "watch");
  assert.equal(r.s.stages.watch, "active");

  r = at({ actions: [broke, rerun], findings, checkpoints: fixed, flows: [{ ...flows[0]!, watch: { mode: "save" } }], review: reviewed, git: { ...repo, pr: { ...pr, state: "merged" } } });
  assert.equal(r.s.actionId, null, "merged and watched: nothing in flight");
});

test("a red re-run after a fix fails Prove; rewinding clears Fix", () => {
  const broke = trip("a", 100, "error");
  let r = at({ actions: [broke, trip("b", 400, "error")], checkpoints: [cp(300)] });
  assert.equal(r.s.stages.prove, "failed");
  assert.equal(r.cur, "prove", "no finding, but a fix was applied: Understand is skipped and the failed Prove needs you");
  r = at({ actions: [broke, trip("b", 400, "error")], findings: [{ at: 200, summary: "s", actionIds: [] }], checkpoints: [cp(300)] });
  assert.equal(r.cur, "prove");
  assert.equal(r.s.stages.prove, "failed");
  r = at({ actions: [broke, trip("b", 150, "error")], findings: [{ at: 200, summary: "s", actionIds: [] }] });
  assert.equal(r.s.stages.prove, "idle", "the agent reproducing it before a fix isn't a failed proof");
  assert.equal(r.cur, "fix");
  r = at({ actions: [broke], checkpoints: [cp(300, false)] });
  assert.equal(r.s.stages.fix, "idle");
  assert.match(r.s.detail.fix!, /rewound/);
});

test("fixed by hand skips Understand and Fix; a race fix counts as Fix; failed tests fail Prove", () => {
  let r = at({ actions: [trip("a", 100, "error"), trip("b", 200, "ok")] });
  assert.equal(r.line, "done skipped skipped done active idle idle");
  r = at({ actions: [trip("a", 100, "error")], race: { id: "r", actionId: "a", candidates: [{ worktree: "try-a", approach: "x", state: "green", patchId: "p" }] } });
  assert.equal(r.s.stages.fix, "done");
  assert.match(r.s.detail.fix!, /try-a worktree/);
  assert.equal(r.s.stages.prove, "done", "proven by its own re-run, not the red repro in the main tree");
  r = at({ actions: [trip("a", 100, "error"), trip("b", 150, "error")], race: { id: "r", actionId: "a", candidates: [{ worktree: "try-a", approach: "x", state: "rerunning", patchId: "p" }] } });
  assert.equal(r.s.stages.prove, "active", "still re-running: Prove is the current stage, not done");
  r = at({ actions: [trip("a", 100, "error")], checkpoints: [cp(200)], tests: { ok: false, summary: "1 test failed.", at: 300 } });
  assert.equal(r.s.stages.prove, "failed");
  assert.equal(r.s.tests, "1 test failed.");
});

test("a review of the proposed patch before Apply counts for that fix", () => {
  const input = { actions: [trip("a", 100, "error"), trip("b", 400, "ok")], checkpoints: [cp(300)], findings: [{ at: 200, summary: "s", actionIds: [] }] };
  assert.equal(at({ ...input, review: { state: "passed", at: 250, summary: "Looks good.", findings: [], patchId: "p300" } }).s.stages.review, "done");
  assert.equal(at({ ...input, review: { state: "passed", at: 250, summary: "Looks good.", findings: [], patchId: "other" } }).s.stages.review, "active");
});

test("not a git repo: Ship is skipped and a proven, reviewed fix with no flows leaves the rail", () => {
  const input = { actions: [trip("a", 100, "error"), trip("b", 400, "ok")], checkpoints: [cp(300)], findings: [{ at: 200, summary: "s", actionIds: [] }], git: { ...repo, isRepo: false } };
  assert.equal(at(input).cur, "review");
  assert.equal(at(input).s.stages.ship, "skipped");
  assert.equal(at({ ...input, review: { state: "waived", at: 500, summary: "", findings: [] } }).s.actionId, null);
});

test("tests: detects the script and the package manager, summarizes node, jest, vitest and mocha", () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-tests-"));
  assert.equal(testCommand(dir), null);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(testCommand(dir), null);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.equal(testCommand(dir), "npm test");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  assert.equal(testCommand(dir), "pnpm test");

  assert.deepEqual(summarizeTests("# tests 3\n# pass 3\n# fail 0\n", 0), { ok: true, summary: "All 3 tests passed." });
  assert.deepEqual(summarizeTests("not ok 2 - creates a todo\n# pass 2\n# fail 1\n", 1), { ok: false, summary: "1 test failed, 2 passed. First one: creates a todo." });
  assert.equal(summarizeTests("  ● todos › rejects empty titles\n\nTests:       1 failed, 4 passed, 5 total\n", 1).summary, "1 test failed, 4 passed. First one: todos › rejects empty titles.");
  assert.equal(summarizeTests(" \x1b[32m✓\x1b[0m a\n   × b > c 3ms\n Tests  2 failed | 7 passed (9)\n", 1).summary, "2 tests failed, 7 passed. First one: b > c.");
  assert.equal(summarizeTests("  5 passing (20ms)\n", 0).summary, "All 5 tests passed.");
  assert.match(summarizeTests("boom\n", 2).summary, /exit code 2\)\. Last line: boom/);
  assert.match(summarizeTests("# pass 1\n", null, true).summary, /didn't finish in time/);
});

test("a fix with no FOUND IT (your own agent over MCP) skips Understand", () => {
  const r = at({ actions: [trip("a", 100, "error"), trip("b", 400, "ok")], checkpoints: [cp(300)] });
  assert.equal(r.line, "done skipped done done active idle idle");
  assert.equal(r.cur, "review");
});

test("build mode: Idea → Plan → Design → Build → Prove → Review → Ship → Live from the quest in flight", () => {
  const quest = (p: Partial<Quest> = {}): Quest => ({ id: "q1", title: "Edit a todo", idea: "edit a todo", state: "planning", objectives: [], createdAt: 100, updatedAt: 100, ...p });
  const obj = (id: string, state: QuestObjective["state"], flowId?: string): QuestObjective => ({ id, text: `Objective ${id}`, doneWhen: "it works", state, ...(flowId ? { flowId } : {}) });
  const b = (i: Partial<BuildInput>) => {
    const r = computeBuild({ quest: quest(), options: [], checkpoints: [], flows: [], review: null, git: repo, ...i });
    return { r, cur: r && currentBuildStage(r), line: r ? Object.values(r.stages).join(" ") : "" };
  };
  assert.equal(b({ quest: undefined }).r, undefined);
  assert.equal(b({ quest: quest({ state: "dropped" }) }).r, undefined);

  let x = b({});
  assert.equal(x.line, "done active idle idle idle idle idle idle");
  assert.equal(x.r!.detail.plan, "Your agent is planning this.");
  x = b({ quest: quest({ waiting: true, objectives: [obj("o1", "todo")] }) });
  assert.match(x.r!.detail.plan!, /waiting for you: 1 objective\./);

  const active = quest({ state: "active", runId: "run1", objectives: [obj("o1", "todo", "f1"), obj("o2", "todo")] });
  x = b({ quest: active });
  assert.equal(x.cur, "design");
  const opt = (state: OptionsSession["state"]): OptionsSession => ({ id: "s", runId: "run1", question: "Scope?", header: "", multi: false, cards: {}, rounds: [], state, waiting: false, at: 50, ...(state === "approved" ? { approved: ["B"] } : {}) });
  assert.equal(b({ quest: active, options: [opt("asking")] }).r!.stages.design, "active");
  x = b({ quest: active, options: [opt("approved")] });
  assert.equal(x.r!.detail.design, "You picked B.");
  assert.equal(x.cur, "build");
  x = b({ quest: active, checkpoints: [cp(300)] });
  assert.equal(x.line, "done done skipped done active idle idle idle");
  assert.equal(x.r!.detail.prove, "0 of 2 objectives pass. 1 still need a flow to prove them.");

  x = b({ quest: { ...active, objectives: [obj("o1", "done", "f1"), obj("o2", "todo", "f2")] } });
  assert.equal(x.cur, "prove", "an objective passing with nothing built here: Prove leads");
  assert.equal(x.r!.detail.prove, "1 of 2 objectives pass.");
  x = b({ quest: { ...active, objectives: [obj("o1", "failed", "f1"), obj("o2", "done", "f2")] }, checkpoints: [cp(300)] });
  assert.equal(x.r!.stages.prove, "failed");
  assert.equal(x.cur, "prove");

  const complete = { ...active, state: "complete" as const, objectives: [obj("o1", "done", "f1"), obj("o2", "done", "f2")] };
  x = b({ quest: complete });
  assert.equal(x.line, "done done skipped skipped done active idle idle", "every objective already passed: nothing needed building");
  x = b({ quest: complete, review: { state: "passed", at: 400, summary: "Looks good.", findings: [] }, git: { ...repo, pr: { number: 7, title: "t", url: "u", state: "open", checks: [{ name: "ci", state: "pending" }] } } });
  assert.equal(x.cur, "ship");
  assert.match(x.r!.detail.ship!, /1 check is still running/);
  x = b({ quest: complete, review: { state: "passed", at: 400, summary: "", findings: [] }, git: { ...repo, pr: { number: 7, title: "t", url: "u", state: "merged", checks: [] } } });
  assert.equal(x.r, undefined, "merged and reviewed: nothing in flight");
  x = b({ quest: complete, deployed: { at: 1, url: "https://todo.app" }, git: { ...repo, pr: { number: 7, title: "t", url: "u", state: "open", checks: [] } } });
  assert.equal(x.r!.detail.live, "Live at https://todo.app.");
  assert.equal(b({ quest: active, git: { ...repo, isRepo: false } }).r!.stages.live, "skipped");
});

test("a re-run recorded as a submit proves the fix like a click does", () => {
  const broke = trip("a", 100, "error");
  const findings = [{ at: 200, summary: "The server reads the wrong field.", actionIds: ["a"] }];
  const clicked = at({ actions: [broke, trip("b", 400, "ok")], findings, checkpoints: [cp(300)] }).line;
  const submitted = at({ actions: [broke, trip("b", 400, "ok", 'Submitted "Add Todo"')], findings, checkpoints: [cp(300)] }).line;
  assert.equal(submitted, clicked);
});
