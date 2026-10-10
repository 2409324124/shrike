// P: the pure parts of prompt chains: gates, score parsing and branching, due times, chain skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChainRun, UpNextItem } from "@shrike/schema";
import { afterRun, afterScore, atClock, blankChain, chainView, enqueueToast, pickChain, chainFromSkill, chainSkillText, moveItem, nextUp, onRelaunch, overBudget, parseScore, repeatUntil, whenLabel } from "./logic.ts";

const item = (id: string, when: UpNextItem["when"], state: UpNextItem["state"] = "waiting"): UpNextItem => ({ id, prompt: id, when, target: "main", state, createdAt: 0 });

test("nextUp: run-gated items go in order; scheduled ones fire when due wherever they sit", () => {
  const items = [item("a", { on: "succeeded" }), item("b", { on: "finished" }), item("t", { on: "time", at: 50 })];
  assert.deepEqual(nextUp(items, { now: 0, last: { status: "done", verified: false }, app: false, ci: false }), { item: items[0], fire: true });
  const failed = nextUp(items, { now: 0, last: { status: "failed", verified: false }, app: false, ci: false });
  assert.equal(failed?.item.id, "a");
  assert.equal(failed?.fire, false);
  assert.equal(nextUp([items[2]!], { now: 49, app: false, ci: false }), null);
  assert.equal(nextUp([items[1]!, items[2]!].map((i) => ({ ...i, state: i.id === "b" ? ("done" as const) : i.state })), { now: 50, app: false, ci: false })?.item.id, "t");
  assert.equal(nextUp([item("v", { on: "verified" })], { now: 0, last: { status: "done", verified: false }, app: false, ci: false })?.fire, false);
  assert.equal(nextUp([item("c", { on: "ci" })], { now: 0, app: false, ci: true })?.item.id, "c");
  for (const on of ["succeeded", "verified"] as const) assert.equal(nextUp([item(on, { on }), item("t", { on: "time", at: 0 })], { now: 0, app: false, ci: false })?.item.id, "t", `${on} with no run to judge waits`);
  assert.equal(nextUp([item("f", { on: "finished" })], { now: 0, app: false, ci: false })?.fire, true, "after this finishes, with nothing running: now");
});

test("schedules: next occurrence of a clock time, labels, missed after a restart", () => {
  const now = new Date(2026, 9, 9, 17, 30).getTime();
  assert.equal(atClock("18:00", now), new Date(2026, 9, 9, 18, 0).getTime());
  assert.equal(atClock("09:15", now), new Date(2026, 9, 10, 9, 15).getTime(), "already passed today: tomorrow");
  assert.equal(atClock("25:00", now), null);
  assert.equal(whenLabel({ on: "time", at: now + 30 * 60_000 }, now), "In 30 min");
  assert.equal(whenLabel({ on: "time", at: atClock("18:00", now)! + 3_600_000 }, now), "At 19:00");
  const after = onRelaunch([item("t", { on: "time", at: now - 3_600_000 }), item("r", { on: "finished" }, "running"), item("s", { on: "time", at: now + 1 }), item("v", { on: "verified" }), item("a", { on: "app" })], now);
  assert.deepEqual(after.map((i) => i.state), ["missed", "done", "waiting", "missed", "waiting"], "the run a gated item followed is gone: it asks");
});

test("moveItem: drag reorders only what's still to come", () => {
  const items = [item("r", { on: "finished" }, "running"), item("a", { on: "finished" }), item("b", { on: "finished" }), item("c", { on: "finished" }), item("d", { on: "finished" }, "done")];
  assert.deepEqual(moveItem(items, "c", 0).map((i) => i.id), ["r", "c", "a", "b", "d"]);
  assert.deepEqual(moveItem(items, "a", 9).map((i) => i.id), ["r", "b", "c", "a", "d"]);
  assert.deepEqual(moveItem(items, "r", 2).map((i) => i.id), ["r", "a", "b", "c", "d"], "a running one can't move");
});

test("critique: score parsing and threshold branching with the loop guard", () => {
  assert.deepEqual(parseScore("SCORE: 6.5/10\nWHY: the empty state is missing"), { score: 6.5, reason: "the empty state is missing" });
  assert.equal(parseScore("Score: 7 out of 10. Solid.")?.score, 7);
  assert.equal(parseScore("Score 12/10")?.score, 10);
  assert.equal(parseScore("looks fine"), null);
  const d = { ...blankChain("x"), threshold: 8, maxRounds: 3 };
  assert.equal(afterScore(d, 8, 1).go, "stop", "at the threshold passes; no pass prompt stops");
  assert.equal(afterScore({ ...d, pass: "ship it" }, 9, 1).go, "pass");
  assert.equal(afterScore(d, 7.9, 1).go, "below");
  assert.equal(afterScore(d, 5, 3).go, "stop", "rounds used up");
  assert.equal(afterRun(d, { node: "prompt", prompt: "x", status: "failed" }).go, "stop", "no failure prompt: stop");
  assert.equal(afterRun({ ...d, failed: "explain" }, { node: "prompt", prompt: "x", status: "failed" }).go, "failed");
  assert.equal(afterRun({ ...d, check: "verified", pass: "write tests" }, { node: "prompt", prompt: "x", status: "done", verified: false }).go, "stop");
  assert.equal(afterRun({ ...d, check: "verified", pass: "write tests" }, { node: "prompt", prompt: "x", status: "done", verified: true }).go, "pass");
  assert.equal(afterRun(d, { node: "below", prompt: "x", status: "done" }).go, "critique", "loop: score again");
  assert.equal(afterRun({ ...d, loop: false }, { node: "below", prompt: "x", status: "done" }).go, "stop");
  assert.match(overBudget({ def: { ...d, budget: { minutes: 1 } }, tokens: 0, startedAt: 0 }, 61_000) ?? "", /Out of time/);
  assert.equal(repeatUntil({ ...d, pass: "ship" }, 9).threshold, 9);
  assert.equal(repeatUntil({ ...d, pass: "ship" }, 9).pass, undefined);
});

test("chain skills: a saved chain reads back the same, with plain steps for the agent", () => {
  const d = { ...blankChain("Build the landing page"), id: "polish-until-8", name: "Polish until 8", failed: "Explain what broke" };
  const text = chainSkillText(d);
  assert.match(text, /^---\nname: "Polish until 8"\n[\s\S]*kind: chain\n/);
  assert.match(text, /\n1\. Ask: Build the landing page\n2\. A critique scores it/);
  const body = text.replace(/^---[\s\S]*?\n---\n/, "");
  assert.deepEqual(chainFromSkill({ id: d.id, name: d.name, body }), d);
  assert.equal(chainFromSkill({ id: "x", name: "x", body: "no json here" }), null);
  assert.equal(chainFromSkill({ id: "x", name: "x", body: "```json\n{\"threshold\": 99, \"maxRounds\": 0}\n```" })?.threshold, 10);
});

test("chain view: the working node, the branch taken, the newest score", () => {
  const def = { ...blankChain("build it"), threshold: 8 };
  const run = (o: Partial<ChainRun>): ChainRun => ({ id: "c", def, state: "running", steps: [], round: 0, tokens: 0, startedAt: 0, ...o });
  assert.deepEqual(chainView(run({ steps: [{ node: "prompt", prompt: "build it", runId: "r1" }] })), { active: "prompt", lit: null });
  assert.equal(chainView(run({ state: "critiquing", steps: [{ node: "prompt", prompt: "p", status: "done" }] })).active, "critique");
  const polishing = chainView(run({ steps: [{ node: "prompt", prompt: "p", status: "done", score: 5, reason: "gap", took: "below" }, { node: "below", prompt: "A", runId: "r2" }] }));
  assert.deepEqual(polishing, { active: "below", lit: "below", score: 5, reason: "gap" });
  const passed = chainView(run({ state: "done", steps: [{ node: "prompt", prompt: "p", status: "done", score: 5, took: "below" }, { node: "below", prompt: "A", status: "done", score: 9, took: "stop" }] }));
  assert.equal(passed.lit, "pass", "a score over the line that stops lights the pass branch");
  assert.equal(passed.score, 9);
  const limit = chainView(run({ state: "done", steps: [{ node: "prompt", prompt: "p", status: "done", score: 5, took: "stop" }] }));
  assert.equal(limit.lit, null, "the round limit lights no branch");
  assert.equal(chainView(run({ steps: [{ node: "prompt", prompt: "p", status: "failed", took: "failed" }, { node: "failed", prompt: "C" }] })).lit, "failed");
  assert.equal(chainView(run({ state: "done", steps: [{ node: "prompt", prompt: "p", status: "failed", took: "failed" }, { node: "failed", prompt: "C", status: "done", took: "stop" }] })).lit, "failed", "the failure branch stays lit after it ends the chain");
});

test("/chain name: by id with or without chain-, or by name; the rest is its prompt", () => {
  const defs = [{ ...blankChain(), id: "chain-polish-until-8", name: "Build, critique, polish until 8/10" }, { ...blankChain(), id: "review-after", name: "After it finishes, review the diff" }];
  assert.equal(pickChain(defs, "polish-until-8 build the about page")?.def.id, "chain-polish-until-8");
  assert.equal(pickChain(defs, "polish-until-8 build the about page")?.prompt, "build the about page");
  assert.equal(pickChain(defs, "build")?.def.id, "chain-polish-until-8");
  assert.equal(pickChain(defs, "review")?.def.id, "review-after");
  assert.equal(pickChain(defs, "nothing-like-it"), null);
  assert.equal(pickChain(defs, ""), null);
});

test("toasts: one at a time, repeats dropped, the oldest queued goes first when full", () => {
  let q = enqueueToast([], { kind: "queued", text: "a" });
  q = enqueueToast(q, { kind: "queued", text: "a" });
  assert.equal(q.length, 1);
  for (const t of ["b", "c", "d"]) q = enqueueToast(q, { kind: "next", text: t });
  q = enqueueToast(q, { kind: "complete", text: "done" });
  assert.deepEqual(q.map((x) => x.text), ["b", "c", "d", "done"]);
});
