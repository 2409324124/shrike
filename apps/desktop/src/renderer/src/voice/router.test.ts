import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CONTEXT, type LiveContext } from "../actions/registry.ts";
import { Executor } from "./understand/executor.ts";
import type { PlanFn } from "./understand/index.ts";
import { Turn, type Echo, type RouterDeps } from "./router.ts";

const CTX: LiveContext = { ...EMPTY_CONTEXT, prs: [{ number: 42, title: "Fix checkout" }], checks: [{ name: "e2e", state: "fail" }], workspaces: [{ name: "admin" }] };

function rig(o: { planner?: PlanFn; agentBusy?: boolean; approval?: boolean } = {}) {
  const ran: string[] = [];
  const shown: Echo[] = [];
  const planned: string[] = [];
  const exec = new Executor({ run: async (s) => (ran.push(s.action + (Object.keys(s.slots).length ? `:${Object.values(s.slots).join(",")}` : "")), { echo: `did ${s.action}`, undo: () => void ran.push(`undo ${s.action}`) }), pre: (s) => s }, () => {});
  let stoppedAgent = false;
  const deps: RouterDeps = {
    context: () => CTX,
    ...(o.planner ? { plan: async (a) => (planned.push(a.text), o.planner!(a)) } : {}),
    exec,
    approve: (yes) => (o.approval ? (yes ? "Approved: the fix" : "Rejected") : null),
    agentBusy: () => !!o.agentBusy && !stoppedAgent,
    stopAgent: () => void (stoppedAgent = true),
    help: () => void shown.push({ heard: "", tone: "ok", echo: "help" }),
    voiceOff: () => {},
    show: (e) => void shown.push(e),
  };
  let n = 0;
  return { ran, shown, planned, exec, turn: () => new Turn(++n, deps), stopped: () => stoppedAgent };
}

test("a safe command acts on a partial once the same parse holds twice, and only once", async () => {
  const r = rig();
  const t = r.turn();
  t.partial("Show");
  t.partial("Show logs");
  assert.equal(r.ran.length, 0, "one partial is not enough");
  t.partial("Show logs.");
  await new Promise((res) => setTimeout(res, 0));
  assert.deepEqual(r.ran, ["panel.show:logs"]);
  await t.final("Show logs.");
  assert.deepEqual(r.ran, ["panel.show:logs"], "deduped");
});

test("the full words win when they mean something else", async () => {
  const r = rig();
  const t = r.turn();
  t.partial("next");
  t.partial("next");
  await new Promise((res) => setTimeout(res, 0));
  await t.final("next trip");
  assert.deepEqual(r.ran, ["step.next", "trip.next"]);
});

test("outward words never act on a partial, and the final shows the card", async () => {
  const r = rig();
  const t = r.turn();
  t.partial("stage all files and push");
  t.partial("stage all files and push");
  await t.final("stage all files and push them");
  assert.deepEqual(r.ran, []);
  assert.equal(r.shown.at(-1)?.tone, "card");
  assert.equal(r.shown.at(-1)?.echo, "Say yes to push to origin");
  await r.turn().final("haan");
  assert.deepEqual(r.ran, ["git.stage_all", "git.push"]);
});

test("'push it' while the push card is up is a yes; 'no' cancels with nothing sent", async () => {
  let r = rig();
  await r.turn().final("push");
  await r.turn().final("push it");
  assert.deepEqual(r.ran, ["git.push"]);
  r = rig();
  await r.turn().final("merge PR 42");
  await r.turn().final("nahi");
  assert.deepEqual(r.ran, []);
  assert.equal(r.shown.at(-1)?.echo, "Cancelled. Nothing was sent");
});

test("the planner only hears what the grammar can't place; its plan runs through the same gates", async () => {
  const r = rig({ planner: async () => ({ json: { plan: [{ a: "panel.show", panel: "terminal" }] } }) });
  await r.turn().final("show logs");
  assert.deepEqual(r.planned, []);
  await r.turn().final("what did the server print");
  assert.deepEqual(r.planned, ["what did the server print"]);
  assert.deepEqual(r.ran, ["panel.show:logs", "panel.show:terminal"]);
  assert.equal(r.shown.some((e) => e.tone === "thinking"), true);
});

test("a planner plan with an outward step waits on the card too", async () => {
  const r = rig({ planner: async () => ({ json: { plan: [{ a: "git.push" }] } }) });
  await r.turn().final("send my work up to origin");
  assert.deepEqual(r.ran, []);
  assert.equal(r.shown.at(-1)?.tone, "card");
});

test("misses are never silent and never a silent agent run", async () => {
  let r = rig();
  await r.turn().final("");
  assert.equal(r.shown.at(-1)?.echo, "Didn't hear anything");
  r = rig({ planner: async () => ({ json: { plan: [] } }) });
  await r.turn().final("add a spinner while the todos load and make it blue");
  assert.equal(r.shown.at(-1)?.echo, "Didn't catch that");
  assert.deepEqual(r.ran, [], "long words don't go to the agent on their own");
  r = rig({ planner: async () => ({ error: "timeout" }) });
  await r.turn().final("hmm what about the thing");
  assert.equal(r.shown.at(-1)?.echo, "That took too long");
});

test("questions go to the agent through agent.ask", async () => {
  const r = rig();
  await r.turn().final("Why did checkout fail?");
  assert.deepEqual(r.ran, ["agent.ask:why did checkout fail"]);
});

test("stop with recognised words stops the plan and the agent; undo and again", async () => {
  const r = rig({ agentBusy: true });
  await r.turn().final("ruko");
  assert.equal(r.stopped(), true);
  assert.equal(r.shown.at(-1)?.echo, "Stopped");
  const r2 = rig();
  await r2.turn().final("run the app");
  await r2.turn().final("wapas karo");
  assert.deepEqual(r2.ran, ["app.run", "undo app.run"]);
  await r2.turn().final("phir se");
  assert.deepEqual(r2.ran, ["app.run", "undo app.run", "app.run"]);
});

test("yes with no card answers the agent's approval card, like a click", async () => {
  const r = rig({ approval: true });
  await r.turn().final("yes");
  assert.equal(r.shown.at(-1)?.echo, "Approved: the fix");
});

test("text to action is instant for grammar commands", async () => {
  const r = rig();
  const t = performance.now();
  await r.turn().final("open the API explorer");
  assert.ok(performance.now() - t < 10);
  assert.deepEqual(r.ran, ["panel.show:api"]);
});

test("a bare stop or bas with nothing running offers the app, never stops it", async () => {
  const r = rig();
  for (const w of ["stop", "bas", "ruko"]) await r.turn().final(w);
  assert.deepEqual(r.ran, []);
  assert.equal(r.shown.at(-1)?.chips?.[0]?.action, "app.stop");
});

test("haan push kar do: confirms the card when it's up, starts its own card when it isn't", async () => {
  let r = rig();
  await r.turn().final("haan push kar do");
  assert.deepEqual(r.ran, []);
  assert.equal(r.shown.at(-1)?.tone, "card");
  await r.turn().final("yes push it");
  assert.deepEqual(r.ran, ["git.push"]);
  r = rig();
  await r.turn().final("nahi rehne do");
  assert.equal(r.shown.at(-1)?.echo, "Okay");
});
