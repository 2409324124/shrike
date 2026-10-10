import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRunInfo, AgentStep, Flow, ShrikeEvents, SkillEvent, StartPlan } from "@shrike/schema";
import { configureSkills, editablePath, getSkillLog, loadSkills, noteSkillStep, noteSkillUse, observe, proposeUpdate, pushUpdate, rescan, saveAsSkill, setFlowLookup, settle, skillHost, type SkillDirs } from "./skills.ts";

const skillHostPropose = (p: { skillId: string; reason: string; after: string }) => skillHost.propose(p);

// SL: every skill path ends in a System event. Real temp folders stand in for the disk.

const md = (fm: string) => `---\n${fm}\n---\n\n# X\n\n1. One.\n`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), "shrike-system-"));
  const d: SkillDirs = { builtin: join(base, "builtin"), project: join(base, "proj"), personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
  for (const p of [d.builtin, join(d.project!, ".shrike/skills"), d.personal, d.claude, d.state]) mkdirSync(p, { recursive: true });
  writeFileSync(join(d.builtin, "bad-value.md"), md("name: Bad value\nwhen: A value is wrong"));
  writeFileSync(join(d.project!, ".shrike/skills/old.md"), md("name: Old one\nwhen: Was here first"));
  const events: SkillEvent[] = [];
  configureSkills(() => d, ((ch: keyof ShrikeEvents, p: unknown) => void (ch === "skill:event" && events.push(p as SkillEvent))) as never);
  return { d, events };
}

const kinds = (evs: SkillEvent[]) => evs.map((e) => `${e.kind}:${e.skillId}`);
const status = (id: string, s: AgentRunInfo["status"], goal = "Why does Add Todo fail?"): AgentRunInfo => ({ id, goal, brain: "claude-code", status: s });
const step = (runId: string, extra: Partial<AgentStep>): AgentStep => ({ id: Math.random().toString(16), runId, kind: "message", text: "x", createdAt: 1, ...extra });

test("acquired and leveled come from one rescan: first look is quiet, copies aren't new, kept proposals level up with the lesson", async () => {
  const { d, events } = setup();
  assert.deepEqual(await rescan(d), []); // baseline: what's already there earns nothing

  writeFileSync(join(d.project!, ".shrike/skills/run-todo-app.md"), md("name: Run todo-app\nwhen: Start the todo app\nkind: run\nversion: 1"));
  const got = await rescan(d);
  assert.deepEqual(kinds(got), ["acquired:run-todo-app"]);
  assert.equal(got[0]!.level, 1);
  assert.equal(got[0]!.rank, "E");
  assert.equal(got[0]!.when, "Start the todo app");
  assert.deepEqual(await rescan(d), []); // only once

  await editablePath(d, "bad-value"); // a project copy of a built-in skill: same skill, not a new one
  assert.deepEqual(await rescan(d), []);

  const p = await proposeUpdate(d, { skillId: "run-todo-app", reason: "Learned: port 5173 is often taken, check it first", after: "# Run\n\n1. Check 5173.\n" });
  await settle(d, { expect: "run", ok: true, skillIds: ["run-todo-app"] });
  await pushUpdate(); // what settleNow does after a level up
  assert.deepEqual(kinds(events), ["leveled:run-todo-app"]);
  assert.equal(events[0]!.level, 2);
  assert.equal(events[0]!.learned, "port 5173 is often taken, check it first");

  writeFileSync(join(d.personal, "starting-apps.md"), md("name: Starting apps\nwhen: Any project")); // R7 personal lesson
  assert.deepEqual(kinds(await rescan(d)), ["acquired:starting-apps"]);
});

test("save as skill (runs and flows) is acquired through pushUpdate", async () => {
  const { d, events } = setup();
  await rescan(d);
  setFlowLookup(() => ({ id: "f1", name: "Add a todo", steps: [{ type: "click", name: "Add Todo" }] }) as Flow);
  await saveAsSkill(d, { flowId: "f1" });
  await pushUpdate();
  assert.deepEqual(kinds(events), ["acquired:add-a-todo"]);
});

test("used: a skill loaded in an agent run that ended done earns proficiency; failed runs earn nothing; fixed and verified completes a quest", async () => {
  const { d, events } = setup();
  await rescan(d);
  await observe("agent:status", status("r1", "running"));
  await observe("agent:step", step("r1", { kind: "message", tool: "load_skill", skill: "bad-value" }));
  await observe("agent:status", status("r1", "failed"));
  assert.equal(events.length, 0);

  await observe("agent:status", status("r2", "running"));
  await observe("agent:step", step("r2", { kind: "message", tool: "load_skill", skill: "bad-value" }));
  await observe("agent:step", step("r2", { kind: "tool_result", skill: "bad-value" }));
  const done = step("r2", { kind: "done", summary: "Fixed and verified" });
  noteSkillStep(done, "Why does Add Todo fail?"); // agent.ts feeds every step
  await observe("agent:step", done);
  await observe("agent:status", status("r2", "done"));
  assert.deepEqual(kinds(events), ["used:bad-value", "quest_complete:bad-value"]);
  assert.equal(events[0]!.proficiency, 1);
  assert.equal(events[0]!.nextRankAt, 3); // E → D at 3
  const q = events[1]!;
  assert.equal(q.quest, "Fix: Why does Add Todo fail?");
  assert.equal(q.runId, "r2");
  assert.deepEqual(q.rewards?.map((r) => `${r.kind}:${r.skillId}`), ["used:bad-value"]);
  assert.equal((await loadSkills(d)).find((s) => s.id === "bad-value")!.proficiency, 1);

  const log = await getSkillLog();
  assert.deepEqual(kinds(log), ["used:bad-value", "quest_complete:bad-value"]);
  assert.ok(JSON.parse(readFileSync(join(d.state, "skill-log.json"), "utf8")).length === 2, "persisted in userData");
});

test("start quest: the run skill it wrote is acquired (not also used: it was made this run), then [Quest Complete]", async () => {
  const { d, events } = setup(); // opened through the UI: no project:opened, the first event takes the quiet look
  const plan = (state: StartPlan["state"], extra: Partial<StartPlan> = {}): StartPlan => ({ projectRoot: d.project!, source: "explored", steps: [], services: [], state, name: "todo-app", runId: "s1", ...extra });
  await observe("start:plan", plan("planning"));
  await observe("agent:status", status("s1", "running", "Get todo-app running"));
  writeFileSync(join(d.project!, ".shrike/skills/run-todo-app.md"), md("name: Run todo-app\nwhen: Start the todo app\nkind: run"));
  await observe("agent:step", step("s1", { tool: "load_skill", skill: "run-todo-app" }));
  await observe("start:plan", plan("ready", { skillId: "run-todo-app" }));
  await observe("agent:status", status("s1", "done", "Get todo-app running"));
  assert.deepEqual(kinds(events), ["acquired:run-todo-app", "quest_complete:run-todo-app"]);
  const q = events[1]!;
  assert.equal(q.quest, "Get todo-app running");
  assert.deepEqual(q.rewards?.map((r) => `${r.kind}:${r.skillId}`), ["acquired:run-todo-app"]);
  await observe("start:plan", plan("ready", { skillId: "run-todo-app" })); // a repeat of ready isn't a second quest
  assert.equal(events.length, 2);
  // the next start follows it: used once (both paths report it); a draft that didn't apply is no reward
  await observe("start:plan", plan("planning", { runId: "s2" }));
  await observe("agent:status", status("s2", "running", "Get todo-app running"));
  await observe("agent:step", step("s2", { tool: "load_skill", skill: "run-todo-app" }));
  await observe("start:plan", plan("ready", { runId: "s2", skillId: "run-todo-app", rewards: [{ kind: "proposed", skillId: "run-todo-app", name: "Run todo-app", level: 2, learned: "x", proposalId: "p1" }] }));
  await observe("agent:status", status("s2", "done", "Get todo-app running"));
  assert.deepEqual(kinds(events).slice(2), ["used:run-todo-app", "quest_complete:run-todo-app"]);
  assert.deepEqual(events[3]!.rewards?.map((r) => `${r.kind}:${r.skillId}`), ["used:run-todo-app"]);
});

test("flows: a passing replay of a flow saved as a skill is a use; the first sighting is only a baseline", async () => {
  const { d, events } = setup();
  writeFileSync(join(d.project!, ".shrike/skills/add-a-todo.md"), md("name: Add a todo\nwhen: Check it works\nkind: flow"));
  const flow = (at: number, ok: boolean): Flow => ({ id: "f1", name: "Add a todo", steps: [], lastRun: { at, ok, actionIds: [] } });
  await observe("flows:update", [flow(1, true)]);
  await observe("flows:update", [flow(2, false)]);
  assert.equal(events.length, 0);
  await observe("flows:update", [flow(3, true)]);
  await observe("flows:update", [flow(3, true)]);
  assert.deepEqual(kinds(events), ["used:add-a-todo"]);
});

test("git skills report their own use", async () => {
  const { d, events } = setup();
  writeFileSync(join(d.builtin, "ship-fix.md"), md("name: Ship this fix\nwhen: Ship\nkind: git"));
  await noteSkillUse("ship-fix");
  assert.deepEqual(kinds(events), ["used:ship-fix"]);
  const s = (await loadSkills(d)).find((x) => x.id === "ship-fix")!;
  assert.equal(s.uses, 1);
  assert.equal(s.proficiency, 1);
});

test("a start that ends ready without a run skill: [Quest Complete] offers Save as skill, and it writes one from the plan", async () => {
  const { d, events } = setup();
  const plan = (state: StartPlan["state"], extra: Partial<StartPlan> = {}): StartPlan => ({ projectRoot: d.project!, source: "explored", steps: [], services: [], state, name: "todo-app", runId: "s2", ...extra });
  await observe("start:plan", plan("running"));
  const steps: StartPlan["steps"] = [
    { id: "a", title: "Install packages", kind: "install", command: "pnpm install", state: "done" },
    { id: "b", title: "Start the API", kind: "service", command: "uv run uvicorn src.main:app --port 3001", cwd: "api", state: "fixed", fix: "uvicorn isn't on PATH, use uv run" },
    { id: "c", title: "Seed", kind: "other", command: "make seed", state: "skipped" },
  ];
  await observe("start:plan", plan("ready", { steps, services: [{ name: "api", port: 3001, health: "http://localhost:3001/health" }] }));
  const q = events.at(-1)!;
  assert.equal(q.kind, "quest_complete");
  assert.deepEqual(q.rewards, []);
  assert.equal(q.runId, "s2");
  const saved = await saveAsSkill(d, { runId: q.runId! });
  assert.equal(saved.id, "run-todo-app");
  assert.equal(saved.kind, "run");
  assert.match(saved.raw, /`uv run uvicorn src\.main:app --port 3001` \(in api\)\. Gotcha: uvicorn isn't on PATH/);
  assert.match(saved.raw, /`http:\/\/localhost:3001\/health`/);
  assert.doesNotMatch(saved.raw, /make seed/);
});

test("a quest with nothing to draft from carries no runId, so no dead Save as skill", async () => {
  const { d, events } = setup();
  await observe("agent:status", status("gone", "running"));
  await observe("agent:step", step("gone", { kind: "done", summary: "Fixed and verified" }));
  await observe("agent:status", status("gone", "done"));
  const q = events.at(-1)!;
  assert.equal(q.kind, "quest_complete");
  assert.equal(q.runId, undefined);
  void d;
});

test("checkouts and project copies don't re-acquire or re-level skills you already had", async () => {
  const { d } = setup();
  const f = join(d.project!, ".shrike/skills/run-a.md");
  writeFileSync(f, md("name: Run A\nwhen: x\nversion: 3"));
  await rescan(d);
  rmSync(f);
  await rescan(d);
  writeFileSync(f, md("name: Run A\nwhen: x\nversion: 3"));
  assert.deepEqual(await rescan(d), []);
  writeFileSync(f, md("name: Run A\nwhen: x\nversion: 2"));
  await rescan(d);
  writeFileSync(f, md("name: Run A\nwhen: x\nversion: 3"));
  assert.deepEqual(await rescan(d), []);
  writeFileSync(f, md("name: Run A\nwhen: x\nversion: 4"));
  assert.deepEqual(kinds(await rescan(d)), ["leveled:run-a"]);

  writeFileSync(join(d.personal, "my-flow.md"), md("name: My flow\nwhen: y"));
  assert.deepEqual(kinds(await rescan(d)), ["acquired:my-flow"]);
  await editablePath(d, "my-flow");
  assert.deepEqual(await rescan(d), []);
  const b = join(d.project!, "..", "projB");
  mkdirSync(join(b, ".shrike/skills"), { recursive: true });
  const dB = { ...d, project: b };
  await rescan(dB); // B's first look
  assert.deepEqual(await rescan(dB), []);
  writeFileSync(join(b, ".shrike/skills/x.md"), md("name: X\nwhen: z"));
  assert.deepEqual(kinds(await rescan(dB)), ["acquired:x"]);
});

test("evolve-on-outcome: a debug run's draft says Not learned when the fix isn't verified, and levels up (with Undo) on a verified run", async () => {
  const { d, events } = setup();
  await rescan(d);
  const file = join(d.builtin, "bad-value.md");
  const before = readFileSync(file);
  await observe("agent:status", status("u1", "running"));
  await observe("agent:step", step("u1", { tool: "load_skill", skill: "bad-value" }));
  await skillHostPropose({ skillId: "bad-value", reason: "Check the form field names first", after: "# X\n\n1. Check the field names.\n" });
  await observe("agent:status", status("u1", "done"));
  assert.deepEqual(kinds(events), ["used:bad-value", "not_learned:bad-value"]);
  assert.equal(events[1]!.learned, "the fix wasn't verified");
  assert.deepEqual(readFileSync(file), before);

  await observe("agent:status", status("u2", "running"));
  await observe("agent:step", step("u2", { tool: "load_skill", skill: "bad-value" }));
  const done = step("u2", { kind: "done", summary: "Fixed and verified" });
  noteSkillStep(done, "Why does Add Todo fail?");
  await observe("agent:step", done);
  await observe("agent:status", status("u2", "done"));
  const up = events.find((e) => e.kind === "leveled")!;
  assert.equal(up.learned, "Check the form field names first");
  assert.ok(up.draftId);
  assert.equal(events.at(-1)!.kind, "quest_complete");
  assert.ok(events.at(-1)!.rewards?.some((r) => r.kind === "leveled" && r.skillId === "bad-value"));
  assert.match(readFileSync(join(d.personal, "bad-value.md"), "utf8"), /version: 2[\s\S]*field names[\s\S]*## Changelog/);
  assert.deepEqual(readFileSync(file), before, "the built-in file itself is never written");
});
