import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectInfo, SkillEvent, StartPlan, StartStep } from "@shrike/schema";
import { focusStep, mergeStep, playbookLine, promoteLevelUp, questTitle, tailLines, toKeep, withPlanPlaces } from "./logic.ts";

const step = (id: string, state: StartStep["state"]): StartStep => ({ id, title: id, kind: "other", state });
const plan = (steps: StartStep[]): StartPlan => ({ projectRoot: "/x/xyne-spaces", name: "xyne-spaces", source: "explored", steps, services: [], state: "running" });

test("mergeStep replaces by id and puts new steps before the closing skill step", () => {
  const p = plan([step("recipe", "done"), step("api", "running"), step("skill", "pending")]);
  assert.equal(mergeStep(p, step("api", "fixed"))!.steps[1]!.state, "fixed");
  assert.deepEqual(mergeStep(p, step("push", "skipped"))!.steps.map((s) => s.id), ["recipe", "api", "push", "skill"]);
  assert.equal(mergeStep(null, step("a", "done")), null);
});

test("focusStep: the user's turn first, then what's running, then what's stuck", () => {
  assert.equal(focusStep(plan([step("a", "failed"), step("b", "running"), step("c", "waiting_approval")]))!.id, "c");
  assert.equal(focusStep(plan([step("a", "failed"), step("b", "running")]))!.id, "b");
  assert.equal(focusStep(plan([step("a", "done"), step("b", "failed"), step("c", "pending")]))!.id, "b");
  assert.equal(focusStep(plan([step("a", "done"), step("b", "pending")]))!.id, "a");
  assert.equal(focusStep(null), undefined);
});

test("titles and lines in plain words", () => {
  assert.equal(questTitle(plan([])), "Get xyne-spaces running");
  assert.equal(questTitle(null), "Get your app running");
  assert.equal(playbookLine({ ...plan([]), recipes: [{ id: "lessons:starting-apps", name: "Starting apps", source: "lessons", path: "" }, { id: "project:run-xyne-spaces", name: "run-xyne-spaces", source: "project-skill", path: "" }] }), "Following run-xyne-spaces (the project's own Claude skill)");
  assert.match(playbookLine(plan([])), /explores the project first/);
  assert.equal(tailLines("a\nb\nc\n\n", 2), "b\nc");
});

test("lanes-from-plan: a plan with places replaces the project's guessed lanes; another project's plan, or none, leaves them", () => {
  const proj: ProjectInfo = { root: "/x/xyne-spaces", name: "xyne-spaces", devCommand: "pnpm dev:all", routes: [], processes: [], expectedPlaces: [{ id: "service:all", kind: "service", name: "ALL", detail: "localhost:3001" }] };
  const places = [{ id: "service:backend", kind: "service" as const, name: "BACKEND", detail: "localhost:3001" }, { id: "data:postgres", kind: "data" as const, name: "POSTGRES", detail: "localhost:5433" }];
  const next = withPlanPlaces(proj, { ...plan([]), places })!;
  assert.deepEqual(next.expectedPlaces, places);
  assert.equal(next.placesFrom, "plan");
  assert.equal(withPlanPlaces(next, { ...plan([]), places }), next, "same lanes: same object, no re-render");
  assert.equal(withPlanPlaces(proj, plan([])), proj);
  assert.equal(withPlanPlaces(proj, { ...plan([]), projectRoot: "/elsewhere", places }), proj);
});

test("SL2: a kept improvement's [Level Up] jumps ahead of an open [Quest Complete]; otherwise the queue is left alone", () => {
  const ev = (kind: SkillEvent["kind"], at: number): SkillEvent => ({ kind, skillId: "run-xyne-spaces", name: "Run xyne-spaces", level: 2, rank: "E", proficiency: 1, at });
  const quest = ev("quest_complete", 1);
  const used = ev("used", 2);
  const up = ev("leveled", 3);
  assert.deepEqual(promoteLevelUp(quest, [used, up]), { current: up, queue: [used] });
  assert.equal(promoteLevelUp(quest, [used]), null);
  assert.equal(promoteLevelUp(used, [up]), null);
  assert.equal(promoteLevelUp(null, [up]), null);
});

test("toKeep: only a finished quest's proposal with an id is the improvement to keep", () => {
  const r = { kind: "proposed" as const, skillId: "run-xyne-spaces", name: "Run xyne-spaces", proposalId: "p1" };
  assert.equal(toKeep({ ...plan([]), state: "ready", rewards: [{ kind: "used", skillId: "a", name: "A" }, r] }), r);
  assert.equal(toKeep({ ...plan([]), rewards: [r] }), undefined);
  assert.equal(toKeep({ ...plan([]), state: "ready", rewards: [{ ...r, proposalId: undefined }] }), undefined);
});
