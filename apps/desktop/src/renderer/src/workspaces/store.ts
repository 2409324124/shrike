import { create } from "zustand";
import type { BrainId, CreateWorkspace, Workspace } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useProject } from "../stores/project.ts";
import { useRun } from "../stores/run.ts";
import { useAgent } from "../stores/agent.ts";
import { toast } from "../stores/ui.ts";

type Step = { step: string; state: "running" | "done" | "failed" };
export interface AfterCreate {
  open: boolean; // false with Create more: it waits in the rail
  runSkill: boolean;
  brain?: BrainId | null;
  prompt?: string;
}

interface WorkspacesState {
  list: Workspace[];
  collapsed: boolean;
  dialog: boolean;
  progress: Step[];
  opening: string | null; // path being switched to
  ready: { name: string; project: string; ran: boolean; prompted: boolean; at: number } | null; // WS3 [Workspace ready]
  refresh(): Promise<void>;
  toggle(): void;
  setDialog(open: boolean): void;
  open(path: string): Promise<boolean>;
  create(opts: CreateWorkspace, after: AfterCreate): Promise<Workspace | null>;
  remove(path: string): Promise<void>;
  rename(path: string, label: string): Promise<void>;
  action(path: string, a: "folder" | "terminal" | "stop"): Promise<void>;
}

const KEY = "shrike.rail.collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  list: [],
  collapsed: readCollapsed(),
  dialog: false,
  progress: [],
  opening: null,
  ready: null,
  async refresh() {
    const l = await Promise.resolve().then(() => api().listWorkspaces()).catch(() => null);
    if (Array.isArray(l)) set({ list: l });
  },
  toggle() {
    const collapsed = !get().collapsed;
    try {
      localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {}
    set({ collapsed });
  },
  setDialog: (dialog) => set({ dialog, ...(dialog ? { progress: [] } : {}) }),
  async open(path) {
    if (get().list.find((w) => w.path === path)?.current) return true;
    set({ opening: path });
    const p = await call((a) => a.openWorkspace(path), "Couldn't switch to that workspace");
    set({ opening: null });
    if (p) useProject.getState().setProject(p);
    void get().refresh();
    return !!p;
  },
  async create(opts, after) {
    set({ progress: [] });
    const w = await call((a) => a.createWorkspace(opts), "Couldn't make the workspace");
    if (!w) return null;
    void get().refresh();
    if (!after.open) return w;
    if (!(await get().open(w.path))) return w;
    set({ dialog: false });
    if (after.runSkill) void useRun.getState().start(); // R5: the normal start quest, driven by the run skill
    const prompt = after.prompt?.trim();
    if (prompt) {
      if (after.brain) useAgent.getState().setBrain(after.brain);
      useAgent.getState().setGoal(prompt);
      void useAgent.getState().start();
    }
    set({ ready: { name: w.label ?? w.name, project: w.project, ran: after.runSkill, prompted: !!prompt, at: Date.now() } });
    return w;
  },
  async remove(path) {
    const ok = await call((a) => a.deleteWorkspace(path), "Couldn't delete the workspace");
    if (ok) toast("Workspace deleted. Your main checkout wasn't touched.", "ok");
    void get().refresh();
  },
  async rename(path, label) {
    await call((a) => a.renameWorkspace(path, label), "Couldn't rename it");
    void get().refresh();
  },
  async action(path, a) {
    await call((x) => x.workspaceAction(path, a), a === "stop" ? "Couldn't stop that app" : "Couldn't open it");
  },
}));

/** Push channels for WS1/WS2. Returns an unsubscribe. */
export function connectWorkspaces(): () => void {
  const a = api();
  const offs = [
    a.on("workspaces:update", (l) => Array.isArray(l) && useWorkspaces.setState({ list: l })),
    a.on("workspace:progress", (p) => p && typeof p.step === "string" && useWorkspaces.setState((s) => ({ progress: [...s.progress.map((x) => (x.state === "running" ? { ...x, state: "done" as const } : x)), p] }))),
  ];
  return () => offs.forEach((off) => off());
}
