import { useEffect } from "react";
import { create } from "zustand";
import type { PrAction, PrAgentTask, PrCheckJob, PrView } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { parseReplies, type Who } from "./logic.ts";

// PR1–PR8 in the renderer. Reads on open, on branch changes and every 15s while a check runs; writes go to main, which asks first.

type Job = PrCheckJob | "loading" | { error: string };

interface PrStore {
  view: PrView | null;
  pick: number | undefined; // a PR picked by number; undefined follows the current branch
  loading: boolean;
  note: { text: string; tone: "info" | "error" | "ok" } | null;
  busy: string | null; // which button is working
  jobs: Record<string, Job>; // by check link
  who: Who;
  drafts: Record<string, string>; // thread id → the agent's reply draft (PR5 Fix all)
  fixRun: string | null;
  want: number; // openPrPanel() bumps it; a dock shell switches to this tab when it changes
  docked: number; // PrPanels mounted inside a dock; 0 shows the fallback drawer
  open: boolean; // the fallback drawer
  list: boolean; // PR14: the open pull requests on top ("show open PRs")
  load(n?: number | null): Promise<void>;
  job(link: string, name: string): Promise<void>;
  act(a: PrAction, ok: string): Promise<boolean>;
  agent(t: PrAgentTask, ok: string): Promise<void>;
}

let loads = 0;

export const usePr = create<PrStore>((set, get) => ({
  view: null,
  pick: undefined,
  loading: false,
  note: null,
  busy: null,
  jobs: {},
  who: "all",
  drafts: {},
  fixRun: null,
  want: 0,
  docked: 0,
  open: false,
  list: false,
  async load(n) {
    const pick = n === null ? undefined : (n ?? get().pick);
    const seq = ++loads;
    set({ loading: true, pick });
    try {
      const view = await api().prView(...(pick ? [pick] : []));
      if (seq !== loads) return; // a newer load (another PR, a refresh) wins
      set((s) => ({ view, note: s.note?.tone === "error" ? null : s.note, ...(s.view?.pr?.number !== view.pr?.number ? { jobs: {}, drafts: {} } : {}) }));
    } catch (e) {
      if (seq === loads) set({ note: { text: errorMessage(e), tone: "error" } });
    } finally {
      if (seq === loads) set({ loading: false });
    }
  },
  async job(link, name) {
    const j = get().jobs[link];
    if (j === "loading" || (j && !("error" in j))) return; // a finished job's steps don't change
    set((s) => ({ jobs: { ...s.jobs, [link]: "loading" } }));
    const r = await api().prCheckJob(link, name).catch((e: unknown) => ({ error: errorMessage(e) }));
    set((s) => ({ jobs: { ...s.jobs, [link]: r } }));
  },
  async act(a, ok) {
    set({ busy: `${a.kind}:${"threadId" in a ? a.threadId : "subjectId" in a ? a.subjectId : ""}`, note: null });
    try {
      const view = await api().prAct(a);
      set({ view, note: { text: ok, tone: "ok" } });
      return true;
    } catch (e) {
      const text = errorMessage(e);
      set({ note: { text, tone: /^Not /.test(text) ? "info" : "error" } });
      return false;
    } finally {
      set({ busy: null });
    }
  },
  async agent(t, ok) {
    set({ busy: `agent:${t.kind}`, note: null });
    try {
      const r = await api().prAgent(t);
      if (t.kind === "fix-all" && "id" in r) set({ fixRun: r.id, drafts: {} });
      set({ note: { text: ok, tone: "ok" } });
    } catch (e) {
      set({ note: { text: errorMessage(e), tone: "error" } });
    } finally {
      set({ busy: null });
    }
  },
}));

/** Show the PR and CI panel: a dock that mounts <PrPanel/> follows `want`; with none, the drawer opens. */
export const openPrPanel = (n?: number, list = false): void => {
  usePr.setState((s) => ({ want: s.want + 1, open: true, list, ...(n ? { pick: n } : {}) }));
};

/** Keeps the panel in step: branch switches, and the agent's reply drafts after Fix all. Mount once per panel. */
export function usePrBridge(): void {
  useEffect(() => {
    const a = api();
    let branch: string | undefined;
    const offs = [
      a.on("git:update", (g) => {
        if (!g || g.branch === branch) return;
        const first = branch === undefined;
        branch = g.branch;
        if (!first && !usePr.getState().pick) void usePr.getState().load();
      }),
      a.on("project:opened", () => void usePr.getState().load(null)),
      a.on("agent:step", (step) => {
        const { fixRun, view } = usePr.getState();
        if (!fixRun || step.runId !== fixRun || !view) return;
        const text = step.kind === "message" ? step.text : step.kind === "done" ? (step.detail ?? step.summary ?? "") : "";
        const found = text ? parseReplies(text, view.threads.map((t) => t.id)) : {};
        if (Object.keys(found).length) usePr.setState((s) => ({ drafts: { ...s.drafts, ...found } }));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
