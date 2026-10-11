import { useEffect } from "react";
import { create } from "zustand";
import type { AgentRunInfo, AgentStep, AgentUsage, ApprovalRequest, BrainId, BrainInfo, Checkpoint, Finding, MemoryNote, Patch, Skill } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { isBackgroundAction } from "../lib/format.ts";
import type { Station } from "../lib/thread-layout.ts";
import { useActions } from "./actions.ts";
import { useProject } from "./project.ts";
import { useThread } from "./thread.ts";
import { toast, useUi } from "./ui.ts";

const MAX_STEPS = 1000;

// A run shows only in the project it started in (main's workspaces.ts rule). Elsewhere it keeps running, parked, and its rail row says so.
type Shown = Pick<AgentState, "run" | "steps" | "picked" | "usage">;
const runRoot = new Map<string, string>();
const parked = new Map<string, Shown>();
const here = (): string => useProject.getState().project?.root ?? "";
const away = (runId: string): Shown | null => {
  const root = runRoot.get(runId);
  return root === undefined || root === here() ? null : (parked.get(root) ?? { run: null, steps: [], picked: {}, usage: null });
};
const park = (runId: string, p: Partial<Shown>): {} => {
  const root = runRoot.get(runId)!;
  const cur = parked.get(root);
  if (cur?.run?.id === runId) parked.set(root, { ...cur, ...p });
  return {};
};
const upsert = (steps: AgentStep[], step: AgentStep): AgentStep[] => {
  const i = steps.findIndex((x) => x.id === step.id);
  return i >= 0 ? steps.map((x, j) => (j === i ? step : x)) : [...steps, step].slice(-MAX_STEPS);
};

interface AgentState {
  open: boolean;
  focusNonce: number;
  brains: BrainInfo[];
  brain: BrainId | null;
  goal: string;
  run: AgentRunInfo | null;
  steps: AgentStep[];
  picked: Record<string, Finding>; // M7: findings step id -> the finding FOUND IT shows
  approvals: ApprovalRequest[];
  inline: string[]; // approvals shown where the user asked (pre-flight, Changes, PR panel): the agent card leaves them there
  /** Approvals answered in this session, kept so the stream can show what was decided. */
  answered: Record<string, boolean>;
  patches: Record<string, Patch>;
  usage: AgentUsage | null; // A7, the current run's
  usageBy: Record<string, AgentUsage>; // branch and aside usage, kept off main's ring
  skills: Skill[]; // A4
  memory: MemoryNote[]; // A5
  checkpoints: Checkpoint[]; // A6
  watched: Record<string, string[]>; // A11: MCP client name -> action ids it read
  unread: Record<string, "trip" | "agent">; // O9: trips that arrived while you were elsewhere, agent results not seen
  revising: string | null; // A13: patch id whose comments were sent, until the revised fix arrives
  sentNotes: { line: number; text: string }[]; // A13: the comments sent, kept above the revised diff
  // C: conversation branches
  runs: Record<string, AgentRunInfo>; // every run of this project: main, its branches, a live aside
  runSteps: Record<string, AgentStep[]>; // branch and aside steps (main's are `steps`)
  viewing: string | null; // C2: the branch the agent column shows; null is main
  aside: string | null; // C3: the side question in the bubble
  asideQ: string;
  forking: string | null; // the branch being made (its own worktree can take a while)
  compare: [string, string] | null; // C4: two run ids side by side ("" for main)
  branch(runId: string, fromStepId: string, question: string, name?: string): Promise<boolean>;
  askAside(question: string): Promise<boolean>;
  keepAside(name?: string): Promise<void>;
  dismissAside(): void;
  bringBack(runId: string, mode: "summary" | "fix"): Promise<void>;
  view(runId: string | null): void;
  loadSteps(runId: string): void;
  loadRuns(): Promise<void>;
  setOpen(v: boolean): void;
  openAndFocus(goal?: string): void;
  loadBrains(): Promise<void>;
  setBrain(b: BrainId): void;
  setGoal(g: string): void;
  start(): Promise<void>;
  retry(): Promise<void>;
  stop(): Promise<void>;
  onStatus(info: AgentRunInfo): void;
  onStep(step: AgentStep): void;
  onApproval(req: ApprovalRequest): void;
  onResolved(id: string, approved: boolean): void;
  onPatch(p: Patch): void;
  answer(id: string, approved: boolean): Promise<void>;
  revert(patchId: string): Promise<void>;
  rewind(checkpointId: string): Promise<void>;
  removeNote(id: string): Promise<void>;
  reviseFix(patchId: string, comments: { line: number; file: string; text: string }[]): Promise<boolean>;
  markRead(actionId: string): void;
}

export const useAgent = create<AgentState>((set, get) => ({
  open: false,
  focusNonce: 0,
  brains: [],
  brain: null,
  goal: "",
  run: null,
  steps: [],
  picked: {},
  approvals: [],
  inline: [],
  answered: {},
  patches: {},
  usage: null,
  usageBy: {},
  skills: [],
  memory: [],
  checkpoints: [],
  watched: {},
  unread: {},
  revising: null,
  sentNotes: [],
  runs: {},
  runSteps: {},
  viewing: null,
  aside: null,
  asideQ: "",
  forking: null,
  compare: null,
  async branch(runId, fromStepId, question, name) {
    set({ forking: question });
    const info = await call((a) => a.branchRun(runId, fromStepId, question, name ? { name } : undefined), "Couldn't start the branch");
    set((s) => ({ forking: null, ...(info ? { runs: { ...s.runs, [info.id]: s.runs[info.id] ?? info }, viewing: info.id } : {}) }));
    return !!info;
  },
  async askAside(question) {
    const id = get().viewing ?? mainHead(get())?.id;
    if (!id) return (toast("Ask your agent something first, then ask on the side.", "info"), false);
    get().dismissAside();
    const info = await call((a) => a.askAside(id, question), "Couldn't ask that");
    if (info) set((s) => ({ aside: info.id, asideQ: question, runs: { ...s.runs, [info.id]: s.runs[info.id] ?? info } }));
    return !!info;
  },
  async keepAside(name) {
    const id = get().aside;
    if (!id) return;
    const info = await call((a) => a.keepAside(id, name), "Couldn't keep it as a branch");
    if (info) set((s) => ({ aside: null, viewing: info.id, runs: { ...s.runs, [info.id]: info } }));
  },
  dismissAside() {
    const id = get().aside;
    if (!id) return;
    set((s) => {
      const { [id]: _, ...runs } = s.runs;
      const { [id]: __, ...runSteps } = s.runSteps;
      const { [id]: ___, ...usageBy } = s.usageBy;
      return { aside: null, runs, runSteps, usageBy };
    });
    void api().stopAgent(id).catch(() => {}); // main forgets it; it never touched main's session
  },
  async bringBack(runId, mode) {
    const ok = await call((a) => a.bringBack(runId, mode).then(() => true), mode === "fix" ? "Couldn't bring the fix over" : "Couldn't bring it back");
    if (ok && mode === "summary") set({ viewing: null });
  },
  view(viewing) {
    set({ viewing });
    if (viewing) get().loadSteps(viewing);
  },
  loadSteps(id) {
    const s = get();
    if (id === s.run?.id || s.runSteps[id]?.length) return;
    void call((a) => a.getRunSteps(id), "Couldn't load that branch").then((steps) => steps && set((x) => ({ runSteps: { ...x.runSteps, [id]: steps } })));
  },
  async loadRuns() {
    const list = await api().listRuns().catch(() => undefined); // no project yet
    if (list) set((s) => ({ runs: { ...Object.fromEntries(list.map((r) => [r.id, r])), ...pick(s.runs, (r) => !!r.aside) } }));
  },
  setOpen: (open) => set({ open }),
  openAndFocus: (goal) => set((s) => ({ open: true, focusNonce: s.focusNonce + 1, ...(goal != null ? { goal } : {}) })),
  async loadBrains() {
    const brains = await call((a) => a.detectBrains(), "Couldn't check which agents are installed");
    if (!brains) return;
    const cur = get().brain;
    const keep = brains.find((b) => b.id === cur && b.available);
    set({ brains, brain: keep ? keep.id : (brains.find((b) => b.available)?.id ?? null) });
  },
  setBrain: (brain) => set({ brain }),
  setGoal: (goal) => set({ goal }),
  async start() {
    const { goal, brain } = get();
    if (!goal.trim() || !brain) return;
    set({ steps: [], picked: {}, approvals: [], answered: {}, run: null, usage: null, revising: null, sentNotes: [] });
    const info = await call((a) => a.startAgent(goal.trim(), brain), "Couldn't start the agent");
    if (info) set((s) => ({ run: s.run?.id === info.id ? { ...info, status: s.run.status } : info }));
  },
  async retry() {
    const run = get().run;
    if (!run) return;
    const info = await call((a) => a.retryRun(run.id), "Couldn't start your agent again"); // its status event swaps the run in and clears the steps
    if (info) set((s) => ({ run: s.run?.id === info.id ? { ...info, status: s.run.status } : info }));
  },
  async stop() {
    const run = get().run;
    if (run) await call((a) => a.stopAgent(run.id), "Couldn't stop the agent");
  },
  onStatus: (info) =>
    set((s) => {
      const runs = { ...s.runs, [info.id]: info };
      if (isSide(info)) return { runs };
      if (!runRoot.has(info.id)) runRoot.set(info.id, here());
      if (away(info.id)) return park(info.id, { run: info });
      if (s.run && s.run.id !== info.id && info.status === "running") return { run: info, runs, steps: [], ...(info.continues ? {} : { viewing: null }) }; // a run main started (up next, a chain): the last run's steps aren't its
      return !s.run || s.run.id === info.id || info.status === "running" ? { run: info, runs, ...(s.run?.id !== info.id && !info.continues ? { viewing: null } : {}) } : { runs };
    }),
  onStep: (step) =>
    set((s) => {
      const side = s.runs[step.runId];
      if (side && isSide(side)) {
        const list = s.runSteps[step.runId] ?? [];
        return { runSteps: { ...s.runSteps, [step.runId]: [...list.filter((x) => x.id !== step.id), step].slice(-MAX_STEPS) } };
      }
      const p = away(step.runId);
      if (p) return park(step.runId, { steps: upsert(p.steps, step) });
      if (s.run && step.runId !== s.run.id) return {};
      return { steps: upsert(s.steps, step) };
    }),
  onApproval: (req) =>
    set((s) => ({
      approvals: [...s.approvals.filter((a) => a.id !== req.id), req],
      ...(req.patch ? { revising: null } : {}),
      ...(req.patch ? { patches: { ...s.patches, [req.patch.id]: req.patch } } : {}),
    })),
  onResolved: (id, approved) =>
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id), answered: { ...s.answered, [id]: approved } })),
  onPatch: (p) => set((s) => ({ patches: { ...s.patches, [p.id]: p } })),
  async answer(id, approved) {
    const req = get().approvals.find((a) => a.id === id);
    get().onResolved(id, approved);
    const ok = await call((a) => a.answerApproval(id, approved).then(() => true), "Couldn't send your answer");
    if (!ok && req) get().onApproval(req);
  },
  async revert(patchId) {
    await call((a) => a.revertPatch(patchId), "Couldn't undo the change");
  },
  async rewind(checkpointId) {
    await call((a) => a.rewindTo(checkpointId), "Couldn't rewind");
  },
  async removeNote(id) {
    await call((a) => a.removeMemory(id), "Couldn't remove the note");
  },
  async reviseFix(patchId, comments) {
    set({ revising: patchId, sentNotes: comments.map((c) => ({ line: c.line, text: c.text })) });
    const ok = await call((a) => a.reviseFix(patchId, comments).then(() => true), "Couldn't send your comments");
    if (!ok) set({ revising: null });
    return !!ok;
  },
  markRead: (id) =>
    set((s) => {
      if (!s.unread[id]) return {};
      const { [id]: _, ...rest } = s.unread;
      return { unread: rest };
    }),
}));

useProject.subscribe((st, prev) => {
  const from = prev.project?.root ?? "";
  const to = st.project?.root ?? "";
  if (from === to) return;
  const { run, steps, picked, usage } = useAgent.getState();
  if (run) parked.set(from, { run, steps, picked, usage });
  useAgent.setState(parked.get(to) ?? { run: null, steps: [], picked: {}, usage: null });
  parked.delete(to);
});

/** A7/X5: a branch's or an aside's usage never lands on main's ring. */
export function onUsage(s: Pick<AgentState, "run" | "runs" | "usageBy">, u: AgentUsage): Partial<AgentState> {
  const r = s.runs[u.runId];
  if (r && isSide(r)) return { usageBy: { ...s.usageBy, [u.runId]: u } };
  if (away(u.runId)) return park(u.runId, { usage: u });
  return !s.run || u.runId === s.run.id ? { usage: u } : {};
}

/** The ring's usage: the run on show, like the context map it opens. */
export const shownUsage = (s: Pick<AgentState, "viewing" | "usage" | "usageBy">): AgentUsage | null => (s.viewing ? (s.usageBy[s.viewing] ?? null) : s.usage);

/** A branch or an aside: never the main run the cards and the probe follow. */
export const isSide = (r: AgentRunInfo): boolean => !!(r.parentRunId || r.aside);

function pick<T>(o: Record<string, T>, keep: (v: T) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => keep(v)));
}

/** C2: main's newest run: the one shown, else the newest main run on record (after a relaunch). */
export function mainHead(s: Pick<AgentState, "run" | "runs">): AgentRunInfo | undefined {
  return s.run ?? Object.values(s.runs).findLast((r) => !isSide(r));
}

/** C2: main's conversation (newest first, through `continues`) and the branches that grew from it, oldest first. */
export function branchLines(s: Pick<AgentState, "run" | "runs">): { main: AgentRunInfo[]; branches: AgentRunInfo[] } {
  const main: AgentRunInfo[] = [];
  for (let r = mainHead(s); r && main.length < 50; r = r.continues ? s.runs[r.continues] : undefined) main.push(r);
  const ids = new Set(main.map((r) => r.id));
  const branches: AgentRunInfo[] = [];
  for (const r of Object.values(s.runs)) {
    if (!r.parentRunId || r.aside) continue;
    if (ids.has(r.parentRunId) || branches.some((b) => b.id === r.parentRunId)) branches.push(r);
  }
  return { main, branches };
}

/** C2 state dot: thinking, found, fixed, stopped. */
export function branchState(r: AgentRunInfo, steps: AgentStep[]): "thinking" | "found" | "fixed" | "stopped" {
  if (r.status === "running") return "thinking";
  if (r.status !== "done") return "stopped";
  const done = steps.findLast((x) => x.kind === "done");
  return /verified/i.test(done?.summary ?? "") || steps.some((x) => x.tool === "worktree_diff") ? "fixed" : "found";
}

/** A5: notes pinned to a file (repo-relative path), for the in-app file view and the Thread. */
export function useMemoryFor(file: string | undefined): MemoryNote[] {
  const memory = useAgent((s) => s.memory);
  return file ? memory.filter((n) => n.file === file) : [];
}

/** A1: the current run's plan step, while it runs. */
/** Shows an approval inline, where the user acted, instead of on the agent card: one approval surface. */
export function useInlineApproval(id: string | undefined): void {
  useEffect(() => {
    if (!id) return;
    useAgent.setState((s) => ({ inline: [...s.inline, id] }));
    return () => useAgent.setState((s) => ({ inline: s.inline.filter((x) => x !== id) }));
  }, [id]);
}

export function usePlan(): AgentStep | undefined {
  return useAgent((s) => (s.run?.status === "running" ? s.steps.findLast((x) => !!x.plan?.length && x.runId === s.run?.id) : undefined));
}

const norm = (t: string) => t.toLowerCase().replace(/\(\)|[`"']/g, "").replace(/\s+/g, " ").trim();

/** A1: station indices the plan names (by stationLabels, else by words in the checks), starting at the click. Every station when nothing matches. */
export function planRoute(stations: Pick<Station, "label" | "where" | "kind">[], plan: AgentStep): number[] {
  let labels: string[] = [];
  try {
    const d = JSON.parse(plan.detail ?? "{}") as { stationLabels?: unknown };
    if (Array.isArray(d.stationLabels)) labels = d.stationLabels.filter((x): x is string => typeof x === "string").map(norm).filter((x) => x.length >= 3);
  } catch {}
  const checks = (plan.plan ?? []).map(norm).join(" | ");
  const hit = stations.flatMap((st, i) => {
    const l = norm(st.label);
    if (l.length < 3 || st.kind === "express") return [];
    const byLabel = labels.some((x) => l.includes(x) || x.includes(l));
    const core = l.split(" ").find((w) => w.length >= 5 && /[a-z]/.test(w));
    return byLabel || (!labels.length && core && checks.includes(core)) ? [i] : [];
  });
  if (!hit.length) return stations.map((_, i) => i);
  return [...new Set([0, ...hit])].sort((a, b) => a - b);
}

/** Subscribes the agent's extra channels and keeps O9 unread marks. Mount once (AgentCards does). */
export function useAgentBridge(): void {
  useEffect(() => {
    const a = api();
    const set = useAgent.setState;
    const offs = [
      a.on("agent:usage", (u) => set((s) => onUsage(s, u))),
      a.on("memory:update", (memory) => Array.isArray(memory) && set({ memory })),
      a.on("checkpoint:update", (checkpoints) => Array.isArray(checkpoints) && set({ checkpoints })),
      a.on("mcp:watch", ({ client, actionIds }) => set((s) => ({ watched: { ...s.watched, [client]: actionIds } }))),
      a.on("actions:cleared", () => set({ watched: {}, unread: {} })),
      a.on("runs:update", (list) => Array.isArray(list) && set((s) => ({ runs: { ...s.runs, ...Object.fromEntries(list.map((r) => [r.id, r])) } }))), // C2
    ];
    void useAgent.getState().loadRuns();
    offs.push(
      useProject.subscribe((st, prev) => {
        if (st.project?.root === prev.project?.root) return;
        set({ runs: {}, runSteps: {}, usageBy: {}, viewing: null, aside: null, compare: null });
        void useAgent.getState().loadRuns();
      }),
    );
    void call((x) => x.listSkills(), "Couldn't load the playbooks").then((skills) => skills && set({ skills }));
    void call((x) => x.getCheckpoints(), "Couldn't load checkpoints").then((checkpoints) => checkpoints && set({ checkpoints }));
    void call((x) => x.watchedBy(), "Couldn't load who is watching").then((w) => w && set({ watched: Object.fromEntries(w.map((x) => [x.client, x.actionIds])) }));
    void a.getMemory().then((memory) => set({ memory }), () => {}); // no project yet: memory:update arrives on open

    // O9: a trip that lands while you're in another app, or while you're busy elsewhere in Shrike, is unread until you focus it.
    const mark = (id: string, kind: "trip" | "agent") => set((s) => (s.unread[id] === "agent" ? {} : { unread: { ...s.unread, [id]: kind } }));
    let seen = new Set(useActions.getState().order);
    offs.push(
      useActions.subscribe((st) => {
        for (const id of st.order) {
          if (seen.has(id)) continue;
          const v = st.byId[id];
          if (v && !isBackgroundAction(v) && !document.hasFocus()) mark(id, "trip");
        }
        seen = new Set(st.order);
      }),
      useUi.subscribe((st, prev) => void (st.newTrip && st.newTrip !== prev.newTrip && mark(st.newTrip, "trip"))),
      useAgent.subscribe((st, prev) => {
        const ended = st.run && st.run.status !== "running" && prev.run?.status === "running" && st.run.id === prev.run.id;
        if (!ended || document.hasFocus()) return;
        const id = useThread.getState().probe?.actionId ?? useThread.getState().focus.actionId;
        if (id) mark(id, "agent");
      }),
    );
    const readFocused = () => {
      const id = useThread.getState().focus.actionId;
      if (id && document.hasFocus()) useAgent.getState().markRead(id);
    };
    offs.push(useThread.subscribe((st, prev) => void (st.focus.actionId !== prev.focus.actionId && readFocused())));
    window.addEventListener("focus", readFocused);
    offs.push(() => window.removeEventListener("focus", readFocused));
    return () => offs.forEach((off) => off());
  }, []);
}
