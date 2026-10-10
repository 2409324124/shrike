import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS } from "../../actions/registry.ts";
import { Executor, type Bindings, type ExecState, type PlannedStep } from "./executor.ts";

function rig(o: { fail?: string; pre?: Bindings["pre"] } = {}) {
  const ran: string[] = [];
  const undone: string[] = [];
  const states: ExecState[] = [];
  const b: Bindings = {
    run: async (s: PlannedStep) => {
      if (s.action === o.fail) throw new Error("No commits to push");
      ran.push(s.action);
      return { echo: `did ${s.action}`, undo: () => void undone.push(s.action) };
    },
    pre: o.pre ?? ((s) => s),
  };
  return { ran, undone, states, x: new Executor(b, (s) => states.push(s)) };
}
const step = (action: string) => ({ action, slots: {} });
const meta = { heard: "test", source: "grammar" as const };

test("safe and undoable plans run at once, in order", async () => {
  const r = rig();
  const s = await r.x.start([step("git.stage_all"), step("panel.show")], meta);
  assert.deepEqual(r.ran, ["git.stage_all", "panel.show"]);
  assert.equal(s.plan?.state, "done");
  assert.ok(s.undoUntil);
});

test("outward never runs without the card: the whole plan waits for yes", async () => {
  for (const a of ACTIONS.filter((x) => x.risk === "outward" || x.risk === "destructive")) {
    const r = rig();
    const s = await r.x.start([step("git.stage_all"), step(a.id)], meta);
    assert.deepEqual(r.ran, [], `${a.id}: nothing ran, not even the stage before it`);
    assert.equal(s.plan?.state, "needs_yes");
    assert.equal(s.plan?.steps[1]?.state, "needs_yes");
  }
});

test("outward: a spoken yes or a click runs it; no cancels with nothing sent", async () => {
  let r = rig();
  await r.x.start([step("git.stage_all"), step("git.push")], meta);
  assert.equal(r.x.current.needs, "yes");
  assert.equal(await r.x.confirm("voice", "haan"), true);
  assert.deepEqual(r.ran, ["git.stage_all", "git.push"]);
  assert.equal(r.x.current.undoUntil, null, "no Undo once a push left the Mac");
  assert.equal(await r.x.undo(), null);
  r = rig();
  await r.x.start([step("pr.merge")], meta);
  r.x.cancel();
  assert.equal(r.x.current.plan?.state, "stopped");
  assert.equal(await r.x.confirm("click"), false, "a cancelled card can't be confirmed later");
  assert.deepEqual(r.ran, []);
});

test("destructive needs a click and a spoken repeat that names it", async () => {
  const r = rig();
  await r.x.start([step("git.discard")], meta);
  assert.equal(r.x.current.needs, "click-and-say");
  assert.equal(await r.x.confirm("voice", "yes"), false, "a bare yes is not enough");
  assert.equal(await r.x.confirm("click"), false, "a click alone is not enough");
  assert.deepEqual(r.ran, []);
  assert.equal(await r.x.confirm("voice", "yes, discard"), true);
  assert.deepEqual(r.ran, ["git.discard"]);
});

test("a failure stops the plan with plain words; later steps are skipped", async () => {
  const r = rig({ fail: "git.push" });
  await r.x.start([step("git.commit"), step("git.push"), step("panel.show")], meta);
  await r.x.confirm("click");
  const p = r.x.current.plan!;
  assert.deepEqual(p.steps.map((s) => s.state), ["done", "failed", "skipped"]);
  assert.equal(p.steps[1]?.error, "No commits to push");
  assert.equal(p.state, "failed");
});

test("undo runs the undoable steps newest first; again re-runs through the same gates", async () => {
  const r = rig();
  await r.x.start([step("git.stage_all"), step("app.run")], meta);
  assert.equal(await r.x.undo(), "Undone");
  assert.deepEqual(r.undone, ["app.run", "git.stage_all"]);
  assert.equal(await r.x.undo(), null, "nothing left");
  const r2 = rig();
  await r2.x.start([step("git.push")], meta);
  await r2.x.confirm("click");
  const again = await r2.x.repeat();
  assert.equal(again?.plan?.state, "needs_yes", "repeat of an outward plan shows the card again");
});

test("precondition repair is shown on the card, flagged as added", async () => {
  const r = rig({ pre: (steps) => steps.flatMap((s) => (s.action === "git.push" ? [{ action: "git.commit", slots: {}, added: true, detail: "Voice: push it" }, s] : [s])) });
  const s = await r.x.start([step("git.push")], { heard: "push it", source: "planner" });
  assert.deepEqual(s.plan?.steps.map((x) => [x.action, x.added ?? false]), [["git.commit", true], ["git.push", false]]);
  assert.equal(s.plan?.steps[0]?.detail, "Voice: push it");
  assert.deepEqual(r.ran, [], "the added commit waits with the push");
});

test("stop skips what's pending and keeps what's done", async () => {
  let release: () => void = () => {};
  const ran: string[] = [];
  const x = new Executor({ run: async (s) => (s.action === "app.run" ? await new Promise<void>((r) => (release = r)) : undefined, ran.push(s.action), { echo: "" }), pre: (s) => s }, () => {});
  const going = x.start([step("git.stage_all"), step("app.run"), step("panel.show")], meta);
  await new Promise((r) => setTimeout(r, 5));
  x.stop();
  release();
  await going;
  assert.deepEqual(ran, ["git.stage_all", "app.run"]);
  assert.deepEqual(x.current.plan?.steps.map((s) => s.state), ["done", "skipped", "skipped"]);
});

test("a slow plan replaced mid-step never runs the new plan's outward step", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const b: Bindings = {
    run: async (s) => {
      if (s.action === "app.run") await new Promise<void>((r) => (release = r));
      ran.push(s.action);
      return { echo: s.action };
    },
    pre: (s) => s,
  };
  const x = new Executor(b, () => {});
  const slow = x.start([step("app.run"), step("panel.show")], meta);
  await new Promise((r) => setImmediate(r));
  const s = await x.start([step("git.commit"), step("git.push")], meta);
  assert.equal(s.plan?.state, "needs_yes");
  release();
  await slow;
  assert.deepEqual(ran, ["app.run"], "the old loop stopped; commit and push wait for yes");
  assert.equal(x.current.plan?.state, "needs_yes");
});
