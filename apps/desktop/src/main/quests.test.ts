import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Flow, Quest } from "@shrike/schema";
import { answerPlan, createQuests, editObjective, issueBody, issueIdea, linkObjective, newQuest, plain, proposePlan, readQuests, settleFlows, focused, questsDir } from "./quests.ts";
import { listIssues, toIssue, type Gh } from "./github.ts";

const plan = { title: "Edit a todo", objectives: [{ text: "Click a todo's title to edit it", doneWhen: "Editing keeps the new title" }, { text: "Esc cancels an edit", doneWhen: "Esc puts the old title back" }] };
const flow = (id: string, at: number, ok: boolean): Flow => ({ id, name: id, steps: [], lastRun: { at, ok, actionIds: [] } });

test("quest state machine: plan, approve, link, flows check objectives off, all green completes", () => {
  let q = newQuest("edit a todo", { at: 100 });
  assert.equal(q.state, "planning");
  assert.throws(() => editObjective({ ...q, state: "complete" }, undefined, { text: "x", doneWhen: "y" }), /complete/);

  q = proposePlan(q, plan, "run1");
  assert.equal(q.waiting, true);
  assert.deepEqual(q.objectives.map((o) => [o.id, o.state]), [["o1", "todo"], ["o2", "todo"]]);
  assert.equal(answerPlan(q, false).objectives.length, 0, "Not this: back to planning, empty");
  q = answerPlan(q, true);
  assert.equal(q.state, "active");
  assert.equal(q.waiting, undefined);
  assert.throws(() => proposePlan(q, plan), /under way/);

  q = linkObjective(q, "o1", "edit", 150);
  q = linkObjective(q, "o2", "esc", 150);
  assert.equal(settleFlows(q, [flow("edit", 50, true)]).changed, false, "a run from before the quest began doesn't count");
  assert.equal(settleFlows(q, [flow("edit", 120, true)]).changed, false, "nor one from before the flow was linked");
  let r = settleFlows(q, [flow("edit", 200, false), flow("esc", 210, true)]);
  assert.deepEqual(r.quest.objectives.map((o) => o.state), ["failed", "done"]);
  assert.equal(r.quest.reds, 1);
  assert.equal(r.completed, false);
  assert.equal(settleFlows(r.quest, [flow("edit", 200, false), flow("esc", 210, true)]).changed, false, "the same run counts once");
  assert.equal(editObjective(r.quest, "o2", { state: "todo" }).objectives[1]!.state, "done", "done comes only from a flow");
  const reworded = editObjective(r.quest, "o2", { doneWhen: "Something easier" }, 250);
  assert.equal(reworded.objectives[1]!.state, "todo", "new words on a passed objective need a new passing run");
  assert.equal(settleFlows(reworded, [flow("edit", 200, false), flow("esc", 210, true)]).changed, false);
  r = settleFlows(r.quest, [flow("edit", 300, true), flow("esc", 210, true)], 310);
  assert.equal(r.completed, true);
  assert.equal(r.quest.state, "complete");
  assert.equal(r.quest.completedAt, 310);

  // a dropped objective doesn't block; a new one is added; linking a new flow starts its proof over
  let d = answerPlan(proposePlan(newQuest("x", { at: 100 }), plan), true);
  d = editObjective(d, undefined, { text: "Undo works", doneWhen: "Undo brings it back" });
  assert.equal(d.objectives[2]!.id, "o3");
  d = editObjective(editObjective(d, "o2", { state: "dropped" }), "o3", { state: "dropped" });
  d = settleFlows(linkObjective(d, "o1", "f", 120), [flow("f", 150, true)]).quest;
  assert.equal(d.state, "complete");
  assert.equal(linkObjective({ ...d, state: "active" }, "o1", "g").objectives[0]!.state, "todo");
});

test("focused: the newest focused open quest; a complete one stays a day", () => {
  const a: Quest = { ...newQuest("a", { at: 1 }), state: "active" };
  const b: Quest = { ...newQuest("b", { at: 2 }), state: "dropped" };
  const c: Quest = { ...newQuest("c", { at: 3 }), state: "complete", completedAt: 3 };
  assert.equal(focused([a, b, c], 10)?.title, "c");
  assert.equal(focused([a, b, c], 3 + 86_400_001)?.title, "a");
  assert.equal(focused([{ ...a, focusAt: 99 }, c], 10)?.title, "a");
  assert.equal(focused([b]), undefined);
});

test("issue import: gh issue list parsing, plain words, comments and images dropped", async () => {
  const raw = [
    { number: 2452, title: "`Failed to upload` logged 5.4k times a day", url: "https://github.com/o/r/issues/2452", body: "### Acceptance criteria\r\n\r\n* [ ] An empty buffer is **skipped**\n<!-- template -->\n![shot](https://x/y.png)\n\n\n\nEnd", labels: [{ name: "bug" }, { name: "good first issue" }], state: "OPEN" },
    { bogus: true },
  ];
  const calls: string[][] = [];
  const gh: Gh = { run: async (args) => (calls.push(args), { code: 0, stdout: JSON.stringify(raw), stderr: "" }) };
  const list = await listIssues(gh, "/r");
  assert.deepEqual(calls[0], ["issue", "list", "--state", "open", "--json", "number,title,url,body,labels", "--limit", "30"], "read only");
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.labels, ["bug", "good first issue"]);
  const { title, idea } = issueIdea(list[0]!);
  assert.equal(title, "Failed to upload logged 5.4k times a day");
  assert.match(idea, /^Failed to upload logged 5\.4k times a day\n\nFrom GitHub issue #2452:\n### Acceptance criteria\n\n\* \[ \] An empty buffer is \*\*skipped\*\*\n\nEnd$/);
  assert.doesNotMatch(idea, /template|png/);
  assert.equal(issueIdea(toIssue({ number: 3, title: "", url: "u" })).idea, "Issue #3\n\nFrom GitHub issue #3.");
  assert.equal(plain("See [the docs](http://x) and `a.ts` <b>now</b>"), "See the docs and a.ts now");
  const q = answerPlan(proposePlan(newQuest("Edit a todo"), plan), true);
  assert.match(issueBody(q), /### Objectives\n\n- \[ \] Click a todo's title to edit it \(done when: Editing keeps the new title\)\n- \[ \] Esc cancels/);
});

test("service: propose waits on approval, link_flow saves steps, a passing flow completes it once, files on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-quests-"));
  try {
    const flows: Flow[] = [];
    const emitted: Quest[][] = [];
    const approvals: { title: string; quest?: string }[] = [];
    const done: string[] = [];
    let answer = true;
    const ghCalls: string[][] = [];
    const svc = createQuests({
      root: () => root,
      emit: (l) => emitted.push(l),
      approve: async (title, _reason, quest) => (approvals.push({ title, ...(quest ? { quest } : {}) }), answer),
      flows: async () => flows,
      saveFlow: async (name, steps) => {
        const f = { id: name.toLowerCase().replace(/\W+/g, "-"), name, steps };
        flows.push(f);
        return f;
      },
      runFlow: async () => {},
      gh: { run: async (args) => (ghCalls.push(args), { code: 0, stdout: "https://github.com/o/r/issues/77\n", stderr: "" }) },
      liveRun: () => "run9",
      completed: (q) => done.push(q.id),
      dropped: () => {},
    });
    const q0 = await svc.plan("Plan this: edit a todo");
    answer = false;
    const no = await svc.host.propose({ questId: q0.id, ...plan });
    assert.equal(no.approved, false);
    assert.equal(no.quest.state, "planning");
    answer = true;
    const yes = await svc.host.propose({ questId: q0.id, ...plan });
    assert.equal(yes.approved, true);
    assert.equal(yes.quest.runId, "run9");
    assert.deepEqual(approvals.map((a) => a.quest), [q0.id, q0.id], "the approval names its quest (the board answers it)");

    const r = await svc.host.linkFlow(q0.id, "o1", { name: "Edit a todo", steps: [{ type: "click", name: "Write the release notes" }] });
    assert.equal(r.flow.id, "edit-a-todo");
    await assert.rejects(svc.host.linkFlow(q0.id, "o2", { name: "nope" }), /No saved flow named "nope"/);
    await svc.host.linkFlow(q0.id, "o2", { name: "edit a todo" });

    await svc.host.updateObjective(q0.id, undefined, { text: "Undo works", doneWhen: "Undo brings it back" });
    answer = false;
    await assert.rejects(svc.host.updateObjective(q0.id, "o3", { state: "dropped" }), /kept this objective/);
    answer = true;
    await svc.host.updateObjective(q0.id, "o3", { state: "dropped" });
    assert.match(approvals.at(-1)!.title, /^Drop "Undo works"/, "the agent can't drop an objective to finish early without the user");

    flows[0]!.lastRun = { at: Date.now() + 1, ok: true, actionIds: [] };
    svc.observe("flows:update", flows);
    await new Promise((res) => setTimeout(res, 100));
    svc.observe("flows:update", flows);
    await new Promise((res) => setTimeout(res, 100));
    const [saved] = await readQuests(root);
    assert.equal(saved!.state, "complete");
    assert.deepEqual(done, [q0.id], "completed once");
    assert.ok(emitted.length > 3);
    assert.equal(JSON.parse(readFileSync(join(questsDir(root), `${q0.id}.json`), "utf8")).state, "complete");

    await svc.act(q0.id, { kind: "open-issue" });
    assert.deepEqual(ghCalls[0]!.slice(0, 2), ["issue", "create"]);
    assert.equal((await readQuests(root))[0]!.issue?.number, 77);
    await assert.rejects(svc.act(q0.id, { kind: "open-issue" }), /already issue #77/);

    writeFileSync(join(questsDir(root), "deadbeef.json"), "{ not json");
    assert.equal((await readQuests(root)).length, 1, "a broken file is skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
