import { test } from "node:test";
import assert from "node:assert/strict";
import type { VoicePlan, VoicePlanStep } from "@shrike/schema";
import { cardShown, isDoubleTap, isPtt, orbState, progress, stepIcon, tail } from "./logic.ts";

const step = (over: Partial<VoicePlanStep>): VoicePlanStep => ({ id: "s", action: "git.push", title: "Push to origin", risk: "outward", state: "waiting", ...over });
const plan = (state: VoicePlan["state"], steps: VoicePlanStep[]): VoicePlan => ({ id: "p", heard: "stage all files and push them", source: "grammar", steps, state });

test("the orb: a problem beats a plan, a plan beats the turn, listening beats acting", () => {
  const waiting = plan("needs_yes", [step({ state: "needs_yes" })]);
  assert.equal(orbState("idle", waiting, true), "error");
  assert.equal(orbState("idle", waiting, false), "confirm");
  assert.equal(orbState("thinking", plan("running", [step({ state: "running" })]), false), "acting");
  assert.equal(orbState("hearing", plan("running", [step({ state: "running" })]), false), "hearing");
  assert.equal(orbState("done", plan("done", []), false), "done");
});

test("double tap: two short wordless presses close together, never a held or spoken turn", () => {
  assert.equal(isDoubleTap(0, 120, 300, false), true);
  assert.equal(isDoubleTap(0, 600, 700, false), false, "first press was held");
  assert.equal(isDoubleTap(0, 120, 900, false), false, "too far apart");
  assert.equal(isDoubleTap(0, 120, 300, true), false, "a quick \"haan\" then another press is not a double tap");
});

test("the push-to-talk key and its variants", () => {
  const e = (code: string, mods: Partial<KeyboardEvent> = {}) => ({ code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
  assert.equal(isPtt(e("Space"), "alt+space"), true);
  assert.equal(isPtt(e("Space", { ctrlKey: true }), "alt+space"), false);
  assert.equal(isPtt(e("Space", { ctrlKey: true }), "ctrl+alt+space"), true);
  assert.equal(isPtt(e("Backquote"), "alt+backquote"), true);
  assert.equal(isPtt(e("Space", { metaKey: true }), "alt+space"), false);
});

test("step icons, progress and the transcript tail", () => {
  assert.equal(stepIcon("git.stage_all"), "stage");
  assert.equal(stepIcon("git.commit"), "commit");
  assert.equal(stepIcon("git.push"), "push");
  assert.equal(stepIcon("pr.open"), "pr");
  assert.equal(stepIcon("ci.rerun"), "ci");
  assert.equal(stepIcon("app.run"), "run");
  assert.equal(stepIcon("panel.show"), "panel");
  assert.equal(stepIcon("agent.ask"), "agent");
  assert.deepEqual(progress(plan("running", [step({ state: "done" }), step({ state: "running" }), step({ state: "skipped" })])), { done: 1, total: 2 });
  assert.deepEqual(tail("a b c", 2), { cut: true, words: ["b", "c"], start: 1 });
});

test("the card: several steps, a yes, or a failure; one quick step stays on the strip", () => {
  assert.equal(cardShown(null), false);
  assert.equal(cardShown(plan("done", [step({ risk: "safe", state: "done" })])), false);
  assert.equal(cardShown(plan("needs_yes", [step({ state: "needs_yes" })])), true);
  assert.equal(cardShown(plan("failed", [step({ state: "failed" })])), true);
  assert.equal(cardShown(plan("running", [step({}), step({})])), true);
});
