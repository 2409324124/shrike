import type { GhIssue, Quest, QuestAct, ShrikeApi } from "@shrike/schema";

// QB in the dev mock (renderer only): one quest under way, one planning, and two open issues.

const now = Date.now();
let quests: Quest[] = [
  {
    id: "a1b2c3d4", title: "Edit a todo", idea: "Plan this: edit a todo's title in place", state: "active", createdAt: now - 600_000, updatedAt: now, focusAt: now,
    objectives: [
      { id: "o1", text: "Your todos still load and tick off", doneWhen: "Ticking a todo keeps it ticked", flowId: "tick-a-todo", state: "done", runAt: now - 60_000 },
      { id: "o2", text: "Click a todo's title to edit it", doneWhen: "Editing a todo keeps the new title", state: "todo" },
      { id: "o3", text: "Press Esc to cancel an edit", doneWhen: "Esc puts the old title back", state: "todo" },
    ],
  },
  { id: "e5f60718", title: "Due dates", idea: "Add due dates to todos", state: "planning", objectives: [], createdAt: now - 3_600_000, updatedAt: now - 3_600_000 },
];
const issues: GhIssue[] = [
  { number: 12, title: "Let people edit a todo", url: "https://github.com/e2e/todo-app/issues/12", body: "### Acceptance criteria\n\n* [ ] Click the title to edit\n* [ ] Esc cancels", labels: ["enhancement"] },
  { number: 9, title: "Dark mode", url: "https://github.com/e2e/todo-app/issues/9", body: "", labels: [] },
];
let listener: (l: Quest[]) => void = () => {};
export const onMockQuests = (fn: (l: Quest[]) => void): void => void (listener = fn);
const put = (q: Quest) => ((quests = [...quests.filter((x) => x.id !== q.id), q]), listener(quests), q);

export const questsMock: Pick<ShrikeApi, "listQuests" | "planQuest" | "listIssues" | "importIssue" | "questAct"> = {
  async listQuests() {
    return quests;
  },
  async planQuest(idea) {
    return put({ id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"), title: idea.slice(0, 80), idea, state: "planning", objectives: [], createdAt: Date.now(), updatedAt: Date.now(), focusAt: Date.now() });
  },
  async listIssues() {
    return issues;
  },
  async importIssue(n) {
    const i = issues.find((x) => x.number === n)!;
    return put({ id: `0000${n}`.slice(-8), title: i.title, idea: `${i.title}\n\n${i.body}`, state: "planning", objectives: [], issue: { number: n, url: i.url, imported: true }, createdAt: Date.now(), updatedAt: Date.now(), focusAt: Date.now() });
  },
  async questAct(id, a: QuestAct) {
    const q = quests.find((x) => x.id === id);
    if (!q) throw new Error("No such quest.");
    if (a.kind === "focus") put({ ...q, focusAt: Date.now() });
    else if (a.kind === "drop") put({ ...q, state: "dropped" });
    else if (a.kind === "check") put({ ...q, objectives: q.objectives.map((o) => (o.id === a.objective ? { ...o, state: "done" } : o)) });
    else if (a.kind === "link") put({ ...q, objectives: q.objectives.map((o) => (o.id === a.objective ? { ...o, ...(a.flowId ? { flowId: a.flowId } : {}) } : o)) });
    else if (a.kind === "sent") put({ ...q, objectives: q.objectives.map((o) => (o.id === a.objective ? { ...o, sentAt: Date.now(), ...(a.workspace ? { workspace: a.workspace } : {}) } : o)) });
    return quests;
  },
};
