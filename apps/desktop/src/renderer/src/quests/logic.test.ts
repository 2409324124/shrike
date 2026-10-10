import { test } from "node:test";
import assert from "node:assert/strict";
import type { Quest, SdlcState } from "@shrike/schema";
import { focusedQuest, ideaPreview, lookOf, nextObjective, objectivePrompt, planThis, railMode, inFlight, workspaceName } from "./logic.ts";

const q = (p: Partial<Quest> = {}): Quest => ({
  id: "q1", title: "Edit a todo", idea: "edit a todo", state: "active", createdAt: 1, updatedAt: 1,
  objectives: [
    { id: "o1", text: "Your todos still tick off", doneWhen: "Ticking keeps it ticked", flowId: "tick", state: "done" },
    { id: "o2", text: "Click a todo's title to edit it!", doneWhen: "Editing keeps the new title", state: "todo" },
    { id: "o3", text: "Esc cancels", doneWhen: "Esc puts it back", state: "todo" },
  ],
  ...p,
});

test("Plan this: from the composer, nothing else", () => {
  assert.equal(planThis("Plan this: edit a todo"), "edit a todo");
  assert.equal(planThis("  plan this:   due dates\nwith reminders"), "due dates\nwith reminders");
  assert.equal(planThis("plan this out for me"), null);
  assert.equal(planThis("Plan this:   "), null);
  assert.equal(planThis("Why does Add Todo break?"), null);
});

test("objective threads: one next, ghosts after it, a broken one first", () => {
  const a = q();
  assert.deepEqual(a.objectives.map((o) => lookOf(a, o)), ["passed", "next", "ghost"]);
  const b = q({ objectives: [...a.objectives.slice(0, 2), { ...a.objectives[2]!, state: "failed" }] });
  assert.equal(nextObjective(b)?.id, "o3");
  assert.equal(nextObjective(q({ state: "planning" })), undefined, "nothing to build until the plan is started");
  assert.equal(workspaceName(a.objectives[1]!), "click-a-todo-s-title");
  assert.match(objectivePrompt(a, a.objectives[1]!), /no flow for it yet: record one with link_flow first/);
  assert.match(objectivePrompt(a, a.objectives[0]!, { id: "tick", name: "Tick a todo", steps: [] }), /Its flow "Tick a todo" proves it/);
});

test("one quest glows: the pick, else the newest focused open one, complete ones last", () => {
  const list = [q({ id: "a", focusAt: 5 }), q({ id: "b", focusAt: 9, state: "complete" }), q({ id: "c", focusAt: 3, state: "dropped" })];
  assert.equal(focusedQuest(list, null)?.id, "a");
  assert.equal(focusedQuest(list, "b")?.id, "b");
  assert.equal(focusedQuest(list, "c")?.id, "a", "a dropped quest isn't on the board");
});

test("rail mode: a broken trip in focus shows Fix, a quest shows Build, a pick holds until what's in flight changes", () => {
  const stages = {} as SdlcState["stages"];
  const both: SdlcState = { actionId: "t1", stages, detail: {}, build: { questId: "q1", title: "t", stages: {} as never, detail: {} } };
  assert.equal(railMode({ actionId: null, stages, detail: {} }, null, false), null);
  assert.equal(railMode(both, null, true), "fix");
  assert.equal(railMode(both, null, false), "build");
  assert.equal(railMode({ ...both, build: undefined }, null, false), "fix");
  assert.equal(railMode(both, { mode: "fix", key: inFlight(both) }, false), "fix");
  assert.equal(railMode({ ...both, actionId: "t2" }, { mode: "fix", key: inFlight(both) }, false), "build", "a new break: the pick no longer holds");
});

test("idea preview: no repeated title, no markdown marks", () => {
  assert.equal(ideaPreview(q({ title: "Let people edit a todo", idea: "Let people edit a todo\n\nFrom GitHub issue #12:\n### Acceptance criteria\n\n* [ ] Click a `title`\n* [ ] Esc cancels" })), "From GitHub issue #12: Acceptance criteria · Click a title · Esc cancels");
  assert.equal(ideaPreview(q({ title: "Edit a todo", idea: "edit a todo" })), "");
});
