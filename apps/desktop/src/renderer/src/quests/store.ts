import { useEffect } from "react";
import { create } from "zustand";
import type { BuildStage, GhIssue, Quest, QuestAct, QuestObjective } from "@shrike/schema";
import { api, call, errorMessage } from "../lib/api.ts";
import { useAgent } from "../stores/agent.ts";
import { useProject } from "../stores/project.ts";
import { toast, useUi } from "../stores/ui.ts";
import { useChains } from "../chains/store.ts";
import { useWorkspaces } from "../workspaces/store.ts";
import { ask } from "../hud/commands.ts";
import { objectivePrompt, planGoal, recordPrompt, workspaceName, type RailMode } from "./logic.ts";

// QB: the quest board's state. Quests live in main (.shrike/quests); this keeps the list, the pick and the board.

interface QuestsUi {
  list: Quest[];
  open: boolean;
  pick: string | null; // QB5: the quest the user focused on the board
  issues: GhIssue[] | null;
  issuesError: string | null;
  railPick: { mode: RailMode; key: string } | null; // L-mode
  buildOpen: BuildStage | null; // the build stage whose detail is open
  refresh(): Promise<void>;
  setOpen(open: boolean): void;
  focus(id: string): Promise<void>;
  plan(idea: string): Promise<void>;
  replan(q: Quest): void;
  loadIssues(): Promise<void>;
  importIssue(n: number): Promise<void>;
  act(id: string, a: QuestAct): Promise<boolean>;
  send(q: Quest, o: QuestObjective): Promise<void>;
  toWorkspace(q: Quest, o: QuestObjective): Promise<void>;
  record(q: Quest, o: QuestObjective): void;
}

/** Ask the agent now, or put it on up next while it works. */
function askOrQueue(goal: string): void {
  if (useAgent.getState().run?.status === "running") void useChains.getState().queue(goal, { on: "finished" });
  else {
    ask(goal);
    useAgent.getState().setGoal("");
  }
}

/** A quest that just completed closes the board: [Quest Complete] and the result screen are the one focal point. */
function setList(list: Quest[]): void {
  const was = useQuests.getState().list;
  const done = list.some((q) => q.state === "complete" && was.some((w) => w.id === q.id && w.state !== "complete"));
  useQuests.setState({ list, ...(done ? { open: false } : {}) });
}

export const useQuests = create<QuestsUi>((set, get) => ({
  list: [],
  open: false,
  pick: null,
  issues: null,
  issuesError: null,
  railPick: null,
  buildOpen: null,
  async refresh() {
    const list = await Promise.resolve().then(() => api().listQuests()).catch(() => null);
    if (Array.isArray(list)) set({ list });
  },
  setOpen: (open) => set({ open }),
  async focus(id) {
    set({ pick: id });
    await get().act(id, { kind: "focus" });
  },
  async plan(idea) {
    const q = await call((a) => a.planQuest(idea), "Couldn't start the quest");
    if (!q) return;
    set((s) => ({ list: [...s.list.filter((x) => x.id !== q.id), q], pick: q.id, open: true }));
    askOrQueue(planGoal(q));
  },
  replan: (q) => askOrQueue(planGoal(q)),
  async loadIssues() {
    set({ issuesError: null });
    try {
      set({ issues: await api().listIssues() });
    } catch (e) {
      set({ issues: [], issuesError: errorMessage(e) });
    }
  },
  async importIssue(n) {
    const q = await call((a) => a.importIssue(n), `Couldn't read issue #${n}`);
    if (!q) return;
    set((s) => ({ list: [...s.list.filter((x) => x.id !== q.id), q], pick: q.id, open: true }));
    if (q.state === "planning" && !q.waiting) askOrQueue(planGoal(q));
  },
  async act(id, a) {
    const list = await call((x) => x.questAct(id, a), a.kind === "check" ? "Couldn't run its flow" : a.kind === "open-issue" ? "Couldn't open the issue" : "Couldn't change the quest");
    if (list) setList(list);
    return !!list;
  },
  async send(q, o) {
    const flow = useUi.getState().flows.find((f) => f.id === o.flowId);
    if (await useChains.getState().queue(objectivePrompt(q, o, flow), { on: "finished" })) {
      await get().act(q.id, { kind: "sent", objective: o.id });
      toast("On your agent's up next.", "ok");
    }
  },
  async toWorkspace(q, o) {
    const ws = useWorkspaces.getState();
    const project = ws.list.find((w) => w.current)?.projectRoot ?? useProject.getState().project?.root;
    if (!project) return;
    const flow = useUi.getState().flows.find((f) => f.id === o.flowId);
    await get().act(q.id, { kind: "sent", objective: o.id, workspace: workspaceName(o) });
    // ponytail: the quest stays in this checkout's .shrike/quests; the new workspace gets the objective as its first prompt
    await ws.create({ project, from: { kind: "name", name: workspaceName(o) } }, { open: true, runSkill: true, prompt: objectivePrompt(q, o, flow) });
  },
  record: (q, o) => askOrQueue(recordPrompt(q, o)),
}));

/** quests:update from main, and a fresh list per project. Mount once. */
export function useQuestsBridge(): void {
  const root = useProject((s) => s.project?.root);
  useEffect(() => {
    return api().on("quests:update", (list) => Array.isArray(list) && setList(list));
  }, []);
  useEffect(() => {
    useQuests.setState({ list: [], pick: null, issues: null });
    if (root) void useQuests.getState().refresh();
  }, [root]);
}
