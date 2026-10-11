// P: up next, schedules and conditional chains, driven by fake agent runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunInfo, ChainDef, ChainEvent } from "@shrike/schema";
import { createChains, critiqueAsk } from "./chains.ts";
import { blankChain, parseScore } from "../renderer/src/chains/logic.ts";

const flush = () => new Promise((r) => setTimeout(r, 5));

function harness(o: { scores?: number[]; file?: string; proj?: { f?: string }; clock?: { t: number }; hang?: { tokens: number }; syncStop?: boolean } = {}) {
  const started: { prompt: string; target: string; after?: string; run: AgentRunInfo }[] = [];
  const events: ChainEvent[] = [];
  const critiqued: string[] = [];
  const stopped: string[] = [];
  let aborted = 0;
  const scores = [...(o.scores ?? [])];
  let n = 0;
  const chains = createChains({
    emit: (ch, p) => void (ch === "chains:event" && events.push(p as ChainEvent)),
    file: () => (o.proj ? o.proj.f : o.file),
    async start(prompt, x) {
      const run: AgentRunInfo = { id: `r${++n}`, goal: prompt, brain: "claude-code", status: "running" };
      started.push({ prompt, target: x.target, after: x.after?.id, run });
      chains.observe("agent:status", { ...run });
      return run;
    },
    async critique(run, _rubric, x) {
      critiqued.push(run.id);
      if (o.hang) {
        x.onTokens(o.hang.tokens);
        return new Promise((done) => x.signal.addEventListener("abort", () => (aborted++, done(null))));
      }
      const s = scores.shift();
      return s === undefined ? null : { score: s, reason: "needs polish" };
    },
    stop: (id) => void (stopped.push(id), o.syncStop && chains.observe("agent:status", { id, goal: "", brain: "claude-code", status: "stopped" })), // the real agent reports "stopped" synchronously
    ...(o.clock ? { now: () => o.clock!.t } : {}),
  });
  const end = async (id: string, status: AgentRunInfo["status"] = "done", verified = false) => {
    if (verified) chains.observe("agent:step", { id: `s-${id}`, runId: id, kind: "done", text: "Done", summary: "Fixed and verified", createdAt: 0 });
    chains.observe("agent:status", { id, goal: "", brain: "claude-code", status });
    await flush();
  };
  const begin = (id: string) => chains.observe("agent:status", { id, goal: "build it", brain: "claude-code", status: "running" });
  return { chains, started, events, critiqued, stopped, end, begin, aborted: () => aborted };
}

test("up next: two prompts queued while a run works fire in order, each continuing the run before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  try {
    const h = harness({ file: join(dir, "p.json") });
    h.begin("r0");
    await h.chains.queue("write the tests", { on: "finished" });
    await h.chains.queue("update the readme", { on: "finished" });
    await flush();
    assert.equal(h.started.length, 0, "nothing fires while the run works");
    await h.end("r0");
    assert.deepEqual(h.started.map((s) => [s.prompt, s.after]), [["write the tests", "r0"]]);
    await h.end("r1");
    assert.deepEqual(h.started.map((s) => [s.prompt, s.after]), [["write the tests", "r0"], ["update the readme", "r1"]]);
    await h.end("r2");
    const st = await h.chains.state();
    assert.deepEqual(st.items.map((i) => i.state), ["done", "done"]);
    assert.ok(h.events.some((e) => e.kind === "next" && /write the tests/.test(e.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("up next: gates skip on a failed or unverified run; a stopped run pauses the queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  try {
    const h = harness({ file: join(dir, "p.json") });
    h.begin("r0");
    await h.chains.queue("ship it", { on: "succeeded" });
    await h.chains.queue("explain why", { on: "always" });
    await h.end("r0", "failed");
    assert.deepEqual(h.started.map((s) => s.prompt), ["explain why"], "only-if-it-worked is skipped, always fires");
    assert.equal((await h.chains.state()).items.find((i) => i.prompt === "ship it")?.state, "skipped");

    await h.chains.queue("write tests", { on: "verified" });
    await h.end("r1", "done", true);
    assert.equal(h.started.at(-1)?.prompt, "write tests", "verified gate passes on a verified fix");

    await h.chains.queue("next thing", { on: "finished" });
    await h.end("r2", "stopped");
    assert.equal((await h.chains.state()).paused, true, "a stopped run pauses up next");
    assert.equal(h.started.length, 2);
    await h.chains.pause(false);
    await flush();
    assert.equal(h.started.at(-1)?.prompt, "next thing", "resume fires it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schedules: a time fires when due; it survives a restart, and one missed while closed asks first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  const file = join(dir, "p.json");
  const clock = { t: 1_000_000 };
  try {
    const h = harness({ file, clock });
    await h.chains.queue("nightly check", { on: "time", at: clock.t + 60_000 });
    await h.chains.queue("later check", { on: "time", at: clock.t + 3_600_000 });
    await h.chains.queue("when the app runs", { on: "app" });
    await h.chains.tick();
    assert.equal(h.started.length, 0);
    clock.t += 61_000;
    await h.chains.tick();
    assert.deepEqual(h.started.map((s) => s.prompt), ["nightly check"]);
    await h.end("r1");
    await h.chains.saved();

    clock.t += 7_200_000; // Shrike was closed past "later check"
    const again = harness({ file, clock });
    const st = await again.chains.state();
    assert.equal(st.items.find((i) => i.prompt === "later check")?.state, "missed");
    assert.equal(st.items.find((i) => i.prompt === "when the app runs")?.state, "waiting", "app items keep waiting");
    assert.ok(again.events.some((e) => e.kind === "missed"));
    await again.chains.tick();
    assert.equal(again.started.length, 0, "a missed one never runs by itself");
    await again.chains.answerMissed(st.items.find((i) => i.prompt === "later check")!.id, true);
    await flush();
    assert.equal(again.started[0]?.prompt, "later check");
    await again.end("r1");
    again.chains.observe("run:status", { state: "running" });
    await flush();
    assert.equal(again.started.at(-1)?.prompt, "when the app runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const def = (o: Partial<ChainDef> = {}): ChainDef => ({ ...blankChain("build the page"), id: "polish", name: "Polish", threshold: 8, maxRounds: 3, ...o });

test("chain: critique 5 takes the below branch with the critique, then stops when the score passes", async () => {
  const h = harness({ scores: [5, 9], file: undefined });
  await h.chains.startChain(def());
  await flush();
  assert.equal(h.started[0]?.prompt, "build the page");
  await h.end("r1");
  assert.deepEqual(h.critiqued, ["r1"]);
  assert.match(h.started[1]!.prompt, /^Improve it[\s\S]*scored the last attempt 5 \/ 10: needs polish/);
  await h.end("r2");
  const c = (await h.chains.state()).chain!;
  assert.equal(c.state, "done");
  assert.deepEqual(c.steps.map((s) => [s.node, s.score, s.took]), [["prompt", 5, "below"], ["below", 9, "stop"]]);
  assert.ok(h.events.some((e) => e.kind === "critique" && e.text === "Critique 5 / 10 → polishing"));
  assert.ok(h.events.some((e) => e.kind === "complete"));
});

test("chain: the round limit stops a score that never passes", async () => {
  const h = harness({ scores: [5, 5, 5, 5] });
  await h.chains.startChain(def({ maxRounds: 2 }));
  await flush();
  await h.end("r1");
  await h.end("r2");
  const c = (await h.chains.state()).chain!;
  assert.equal(h.started.length, 2, "prompt, one polish; the second critique hits the limit");
  assert.equal(c.round, 2);
  assert.match(c.why ?? "", /Stopped after 2 rounds at 5 \/ 10/);
});

test("chain: a failed run takes the failure branch, which ends the chain", async () => {
  const h = harness({ scores: [9] });
  await h.chains.startChain(def({ failed: "Explain what went wrong" }));
  await flush();
  await h.end("r1", "failed");
  assert.deepEqual(h.critiqued, [], "a failed run isn't critiqued");
  assert.equal(h.started[1]?.prompt, "Explain what went wrong");
  await h.end("r2");
  const c = (await h.chains.state()).chain!;
  assert.deepEqual(c.steps.map((s) => [s.node, s.took]), [["prompt", "failed"], ["failed", "stop"]]);
  assert.equal(c.state, "done");
});

test("chain: an empty prompt works on the run going now; up next waits for the chain; budget stops it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  const h = harness({ scores: [3], file: join(dir, "p.json") });
  h.begin("r0");
  await h.chains.startChain(def({ prompt: "", budget: { tokens: 100 } }));
  await h.chains.queue("after the chain", { on: "finished" });
  h.chains.observe("agent:usage", { runId: "r0", inputTokens: 90, outputTokens: 20 });
  await h.end("r0");
  const c = (await h.chains.state()).chain!;
  assert.match(c.why ?? "", /Out of budget/);
  assert.equal(c.state, "stopped");
  await flush();
  assert.deepEqual(h.started.map((s) => s.prompt), ["after the chain"], "up next carries on once the chain is over");
  rmSync(dir, { recursive: true, force: true });
});

test("critique: the critic sees the ask, what the run said, its answer and diff; its reply parses to a score", () => {
  const ask = critiqueAsk({
    skill: "1. Read the ask.",
    rubric: "It works on mobile.",
    goal: "build the about page",
    steps: [
      { id: "a", runId: "r", kind: "message", text: "Adding the page", createdAt: 0 },
      { id: "b", runId: "r", kind: "done", text: "Done", detail: "Added About.tsx", createdAt: 0 },
    ],
    diff: "+++ About.tsx",
  });
  for (const part of ["<playbook>\n1. Read the ask.", "It works on mobile.", "build the about page", "- Adding the page", "Added About.tsx", "+++ About.tsx", "SCORE: <number>/10"]) assert.ok(ask.includes(part), part);
  assert.match(critiqueAsk({ skill: "", rubric: "x", goal: "g", steps: [], diff: "" }), /\(no code changed\)/);
  assert.deepEqual(parseScore("Looks fine.\nSCORE: 6.5/10\nWHY: no empty state"), { score: 6.5, reason: "no empty state" });
});

test("up next never follows another project's run: after a switch it starts fresh there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  try {
    const proj = { f: join(dir, "a.json") };
    const h = harness({ proj });
    h.begin("A-run");
    await h.chains.state();
    proj.f = join(dir, "b.json");
    h.chains.observe("project:opened", { root: "/b" } as never);
    await h.chains.queue("do B thing", { on: "verified" });
    await h.end("A-run", "done", true);
    assert.equal(h.started.length, 0, "A ending never judges or fires B's item");
    await h.chains.queue("then this", { on: "finished" });
    await flush();
    assert.equal(h.started.length, 0, "it waits behind B's verified item, which has no B run to judge yet");
    await h.chains.edit((await h.chains.state()).items[0]!.id, null);
    await flush();
    assert.deepEqual(h.started.map((s) => [s.prompt, s.after]), [["then this", undefined]], "a fresh session in B, never A's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relaunch: run-gated items ask instead of firing, and a chain cut off by a quit says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chains-"));
  const file = join(dir, "p.json");
  try {
    const h = harness({ file, hang: { tokens: 10 } });
    h.begin("r0");
    await h.chains.queue("ship it", { on: "verified" });
    await h.chains.queue("after", { on: "finished" });
    await h.chains.startChain(def());
    await flush();
    await h.chains.saved();
    const again = harness({ file });
    const st = await again.chains.state();
    await again.chains.tick();
    assert.equal(again.started.length, 0, "nothing fires by itself after a restart");
    assert.deepEqual(st.items.map((i) => i.state), ["missed", "missed"]);
    assert.equal(st.chain?.state, "stopped");
    assert.match(st.chain?.why ?? "", /Shrike closed/);
    assert.ok(again.events.some((e) => e.kind === "stopped") && again.events.some((e) => e.kind === "missed" && /closed before it ran/.test(e.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop chain kills a critique that's running; the critic's tokens count toward the budget", async () => {
  const h = harness({ hang: { tokens: 50 } });
  await h.chains.startChain(def({ budget: { tokens: 1000 } }));
  await flush();
  h.chains.observe("agent:usage", { runId: "r1", inputTokens: 100, outputTokens: 0 } as never);
  await h.end("r1");
  let c = (await h.chains.state()).chain!;
  assert.equal(c.state, "critiquing");
  assert.equal(c.tokens, 150, "the run's 100 plus the critic's 50");
  await h.chains.stopChain();
  await flush();
  c = (await h.chains.state()).chain!;
  assert.equal(h.aborted(), 1, "the critic was killed");
  assert.equal(c.state, "stopped");

  const b = harness({ hang: { tokens: 5000 } });
  await b.chains.startChain(def({ budget: { tokens: 1000 } }));
  await flush();
  b.chains.observe("agent:usage", { runId: "r1", inputTokens: 600, outputTokens: 600 } as never);
  await flush();
  assert.deepEqual(b.stopped, ["r1"], "over budget mid-run: the run is stopped then and there");
  const cb = (await b.chains.state()).chain!;
  assert.match(cb.why ?? "", /Out of budget/);
  await b.end("r1", "stopped");
  assert.equal((await b.chains.state()).paused, false, "the chain's own stop doesn't pause up next");

  const sy = harness({ syncStop: true });
  await sy.chains.startChain(def({ budget: { tokens: 1000 } }));
  await flush();
  sy.chains.observe("agent:usage", { runId: "r1", inputTokens: 600, outputTokens: 600 } as never);
  await flush();
  assert.deepEqual(sy.events.filter((e) => e.kind === "stopped").map((e) => e.text), ["Out of budget: 1k tokens used."], "one stop, with the budget as the reason");
});

test("chain: the failure branch ending it is not a success", async () => {
  const h = harness();
  await h.chains.startChain(def({ check: "succeeded", failed: "Explain" }));
  await flush();
  await h.end("r1", "failed");
  await h.end("r2");
  assert.equal(h.events.findLast((e) => e.kind === "complete")?.ok, false);
});
