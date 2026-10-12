import { useEffect } from "react";
import { create } from "zustand";
import type { Finding, Flow, GitState, PullRequest } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { useActions } from "./actions.ts";
import { useAgent } from "./agent.ts";
import { useUi } from "./ui.ts";
import { useScm } from "../scm/store.ts";

// G1–G6 in the renderer: the Ship sheet's state. Main pushes "git:update"; every action here refreshes after.

export type Busy = null | "load" | "ship" | "sync" | "resolve" | "merge" | "prs" | "review" | "explain";

interface GitStore {
  state: GitState | null;
  busy: Busy;
  note: { text: string; tone: "info" | "error" | "ok" } | null; // one calm line under the focal action
  picked: string[] | null; // G1: files the user chose; null = Shrike's own fixes
  prs: PullRequest[] | null; // G2 picker
  review: { runId: string; pr: number; summary?: string; findings: Finding[]; done: boolean } | null;
  flows: Flow[];
  load(): Promise<void>;
  pick(files: string[]): void;
  ship(title?: string): Promise<void>;
  sync(mode?: "preview" | "rebase" | "merge" | "continue" | "abort"): Promise<void>;
  resolve(): Promise<void>;
  explain(name: string): Promise<void>;
  merge(): Promise<void>;
  loadPrs(): Promise<void>;
  reviewPr(n: number): Promise<void>;
}

/** Files changed by fixes Shrike applied (checkpoints still applied) that git also sees as changed. */
export function shrikeFiles(state: GitState | null): string[] {
  const changed = new Set(state?.changed.map((c) => c.path) ?? []);
  const cps = useAgent.getState().checkpoints.filter((c) => c.current);
  return [...new Set(cps.flatMap((c) => c.files))].filter((f) => changed.has(f));
}

/** The trip being shipped: the newest one that broke. */
const brokenTrip = (): string | undefined => {
  const { order, byId } = useActions.getState();
  return order.find((id) => byId[id]?.status === "error");
};

export const useGit = create<GitStore>((set, get) => {
  const run = async <T>(busy: Busy, fn: () => Promise<T>, ok?: (r: T) => string | null): Promise<T | undefined> => {
    set({ busy, note: null });
    try {
      const r = await fn();
      const text = ok?.(r);
      if (text) set({ note: { text, tone: "ok" } });
      return r;
    } catch (e) {
      // Main says what happened in plain words, including "saved locally, not sent".
      const text = errorMessage(e);
      set({ note: { text, tone: /^(Saved|Sent|Not sent|Not merged|Not updated)\b/.test(text) ? "info" : "error" } });
      return undefined;
    } finally {
      set({ busy: null });
      void api()
        .gitState()
        .then((state) => set({ state }), () => {});
    }
  };

  return {
    state: null,
    busy: null,
    note: null,
    picked: null,
    prs: null,
    review: null,
    flows: [],
    async load() {
      set({ busy: get().state ? get().busy : "load" });
      const [state, flows] = await Promise.all([api().gitState().catch((e: unknown) => (set({ note: { text: errorMessage(e), tone: "error" } }), null)), api().listFlows().catch(() => [] as Flow[])]);
      set((s) => ({ state: state ?? s.state, flows, busy: s.busy === "load" ? null : s.busy }));
    },
    pick: (picked) => set({ picked }),
    async ship(title) {
      const files = get().picked ?? shrikeFiles(get().state);
      const message = useScm.getState().message.trim();
      const pr = await run("ship", () => api().shipFix({ actionId: brokenTrip(), files, ...(title ? { title } : {}), ...(message ? { message } : {}) }), (p) => `Opened pull request #${p.number}.`);
      if (pr) set({ picked: null });
      if (pr && message) useScm.setState({ message: "", written: false });
    },
    async sync(mode) {
      await run("sync", () => api().syncWithMain(mode ? { mode } : undefined), (s) =>
        mode === "preview" ? null : s.conflicts.length ? null : mode === "abort" ? "Undone. Your branch is back as it was." : "Up to date with main.",
      );
    },
    async resolve() {
      await run("resolve", () => api().resolveConflicts(), () => "Your agent is working on the conflicts. Apply each file it proposes.");
    },
    async explain(name) {
      const n = get().state?.pr?.number;
      if (n) await run("explain", () => api().explainCheck(n, name), () => "Asked your agent why. Its answer shows in the agent column.");
    },
    async merge() {
      const n = get().state?.pr?.number;
      if (n) await run("merge", () => api().mergePullRequest(n), () => `Merged pull request #${n}.`);
    },
    async loadPrs() {
      const prs = await run("prs", () => api().listPullRequests());
      if (prs) set({ prs });
    },
    async reviewPr(n) {
      const info = await run("review", () => api().reviewPullRequest(n));
      if (info) set({ review: { runId: info.id, pr: n, findings: [], done: info.status !== "running" } });
    },
  };
});

export const shipOpen = (): boolean => useUi.getState().panel === "ship";

/** Keeps the store in step with main. Mount once (Ship does). */
export function useGitBridge(): void {
  useEffect(() => {
    const a = api();
    const offs = [
      a.on("git:update", (state) => state && typeof state.isRepo === "boolean" && useGit.setState({ state })),
      a.on("flows:update", (flows) => Array.isArray(flows) && useGit.setState({ flows })),
      a.on("agent:step", (step) =>
        useGit.setState((s) => {
          if (!s.review || step.runId !== s.review.runId) return {};
          if (step.kind === "findings") return { review: { ...s.review, findings: step.findings ?? [], summary: step.summary ?? s.review.summary } };
          if (step.kind === "done") return { review: { ...s.review, done: true, summary: s.review.summary ?? step.summary } };
          return {};
        }),
      ),
      a.on("agent:status", (info) => useGit.setState((s) => (s.review && info.id === s.review.runId && info.status !== "running" ? { review: { ...s.review, done: true } } : {}))),
    ];
    const focus = () => void (shipOpen() && useGit.getState().load());
    window.addEventListener("focus", focus); // commits made in a terminal show up when you come back
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("focus", focus);
    };
  }, []);
}
