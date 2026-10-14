import { create } from "zustand";
import type { RunStatus } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { useStart } from "../start/store.ts";
import { isLiveSite, useProject } from "./project.ts";

const MAX_OUTPUT = 200_000;

interface RunState {
  status: RunStatus;
  output: string;
  byProcess: Record<string, string>; // O4: output per process, from "process:output"
  appendProcess(name: string, chunk: string): void;
  setStatus(s: RunStatus): void;
  append(chunk: string): void;
  clearOutput(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export const isLive = (s: RunStatus): boolean => s.state === "running" || s.state === "starting";

// ponytail: plain string buffer trimmed from the front; a ring buffer of lines if this ever gets hot
const tail = (s: string) => (s.length > MAX_OUTPUT ? s.slice(s.length - MAX_OUTPUT) : s);

export const useRun = create<RunState>((set, get) => ({
  status: { state: "idle" },
  output: "",
  byProcess: {},
  setStatus: (status) => set({ status }),
  append: (chunk) => set((s) => ({ output: tail(s.output + chunk) })),
  appendProcess: (name, chunk) => set((s) => ({ byProcess: { ...s.byProcess, [name]: tail((s.byProcess[name] ?? "") + chunk) } })),
  clearOutput: () => set({ output: "", byProcess: {} }),
  // R5: every Run (top bar, Setup, voice, dock) is Claude's start quest; the old package.json guess is gone from the UI.
  async start() {
    set({ status: { ...get().status, state: "starting", error: undefined } });
    if (isLiveSite(useProject.getState().project)) {
      // #54: no dev command to start; main asks for consent once per host, then opens the site.
      const s = await call((a) => a.run(), "Couldn't open your live site");
      set({ status: s ?? { state: "error", error: "Couldn't open your live site." } });
      return;
    }
    const p = await call((a) => a.startApp(), "Couldn't start your app");
    if (p) useStart.getState().setPlan(p);
    else set({ status: { state: "error", error: "Couldn't start your app." } });
  },
  async stop() {
    await call((a) => a.stopApp(), "Couldn't stop your app");
    const s = await call((a) => a.getRunStatus(), "Couldn't read your app's state");
    if (s) set({ status: s });
  },
  async restart() {
    if (isLive(get().status)) await get().stop();
    await get().start();
  },
}));

// A quest that ends before any service started leaves the runner idle (no run:status push): don't stay "starting".
useStart.subscribe(({ plan }) => {
  const s = useRun.getState().status;
  if (s.state === "starting" && plan && (plan.state === "failed" || plan.state === "stopped")) useRun.setState({ status: plan.state === "failed" ? { state: "error", error: plan.error } : { state: "stopped" } });
});
