import { useEffect } from "react";
import { create } from "zustand";
import type { StartPlan, StartStep } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useProject } from "../stores/project.ts";
import { useSystem } from "../system/store.ts";
import { mergeStep, promoteLevelUp, withPlanPlaces } from "./logic.ts";

// R: the start quest's state, from "start:plan" and "start:step".

interface StartState {
  plan: StartPlan | null;
  autoKeep: boolean; // keep skill improvements automatically after a successful run
  setPlan(p: StartPlan | null): void;
  onStep(s: StartStep): void;
  setAutoKeep(on: boolean): Promise<void>;
}

export const useStart = create<StartState>((set) => ({
  plan: null,
  autoKeep: false,
  setPlan: (plan) => {
    set({ plan });
    const p = useProject.getState().project;
    const next = withPlanPlaces(p, plan); // lanes-from-plan: the Thread's expected lanes follow Claude's plan
    if (next !== p) useProject.setState({ project: next });
  },
  onStep: (s) => set((st) => ({ plan: mergeStep(st.plan, s) })),
  async setAutoKeep(on) {
    set({ autoKeep: on });
    if (!(await call(async (a) => (await a.setStartSettings({ autoKeep: on }), true), "Couldn't save that setting"))) set({ autoKeep: !on });
  },
}));

/** Mount once where the quest shows (the dock): follows main's pushes and picks up a start already in flight. */
export function useStartBridge(): void {
  useEffect(() => {
    const a = api();
    const offs = [a.on("start:plan", (p) => useStart.getState().setPlan(p)), a.on("start:step", (s) => useStart.getState().onStep(s))];
    void call((x) => x.getStartPlan(), "Couldn't read the start").then((p) => p !== undefined && !useStart.getState().plan && useStart.getState().setPlan(p));
    void call((x) => x.getStartSettings(), "Couldn't read the start settings").then((s) => s && useStart.setState({ autoKeep: s.autoKeep }));
    // SL2: Keep plays [Level Up] now, not after the [Quest Complete] window times out.
    const offSys = useSystem.subscribe((s) => {
      const up = promoteLevelUp(s.current, s.queue);
      if (up) useSystem.setState(up);
    });
    return () => (offs.forEach((off) => off()), offSys());
  }, []);
}

/** Run, driven by Claude (R5). */
export async function startWithClaude(): Promise<void> {
  const p = await call((a) => a.startApp(), "Couldn't start your app");
  if (p) useStart.getState().setPlan(p);
}

export const stopStart = () => call((a) => a.stopApp(), "Couldn't stop");

export const answerStart = (id: string, a: { allow: boolean; always?: boolean; values?: Record<string, string> }) => call((x) => x.answerStart(id, a), "Couldn't send your answer");
