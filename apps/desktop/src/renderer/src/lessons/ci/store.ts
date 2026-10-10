import { useEffect } from "react";
import { create } from "zustand";
import type { CiLessonsState } from "@shrike/schema";
import { api, errorMessage } from "../../lib/api.ts";

// CI: the pipeline map, pre-flight and lessons in the renderer. Main pushes "ci:update"; [Lesson Mastered] arrives on "ci:mastered".

interface CiStore {
  state: CiLessonsState | null;
  busy: null | "load" | "preflight" | "learn" | `fix:${string}`;
  note: { text: string; tone: "ok" | "error" | "info" } | null;
  open: boolean; // the pipeline view (CI1, CI5, CI6)
  focus: string | null; // the job open in the pipeline view
  mastered: { job: string; learned: string }[]; // CI7, shown one at a time
  load(refresh?: boolean): Promise<void>;
  run(): Promise<void>;
  stop(): Promise<void>;
  learn(from?: { check: string; url?: string }): Promise<void>;
  fix(job: string): Promise<void>;
  show(open: boolean, focus?: string | null): void;
}

const isState = (s: unknown): s is CiLessonsState => !!s && typeof s === "object" && Array.isArray((s as CiLessonsState).touched) && typeof (s as CiLessonsState).record === "object";

export const useCi = create<CiStore>((set, get) => {
  const work = async (busy: CiStore["busy"], fn: () => Promise<unknown>, ok?: string) => {
    if (get().busy && get().busy !== "load") return;
    set({ busy, note: null });
    try {
      const r = await fn();
      if (isState(r)) set({ state: r });
      if (ok) set({ note: { text: ok, tone: "ok" } });
    } catch (e) {
      set({ note: { text: errorMessage(e), tone: "error" } });
    } finally {
      set({ busy: null });
    }
  };
  return {
    state: null,
    busy: null,
    note: null,
    open: false,
    focus: null,
    mastered: [],
    async load(refresh) {
      if (!get().state) set({ busy: "load" });
      try {
        set({ state: await (refresh ? api().ciLessons({ refresh }) : api().ciLessons()) });
      } catch (e) {
        set({ note: { text: errorMessage(e), tone: "error" } });
      } finally {
        if (get().busy === "load") set({ busy: null });
      }
    },
    run: () => work("preflight", () => api().preflight()),
    stop: () => api().stopPreflight().catch(() => {}),
    learn: (from) => work("learn", () => (from ? api().ciLearn(from) : api().ciLearn())),
    fix: (job) => work(`fix:${job}`, () => api().ciFixLeg(job), "Your agent is on it. Its fix shows as a change to approve; pre-flight checks it after."),
    show: (open, focus) => set({ open, ...(focus !== undefined ? { focus } : {}) }),
  };
});

/** Mount once (the CI overlay): keeps the store in step with main. */
export function useCiBridge(): void {
  useEffect(() => {
    const a = api();
    const offs = [
      a.on("ci:update", (s) => isState(s) && useCi.setState({ state: s })),
      a.on("ci:mastered", (m) => m && typeof m.job === "string" && typeof m.learned === "string" && useCi.setState((st) => ({ mastered: [...st.mastered, m].slice(-4) }))),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
