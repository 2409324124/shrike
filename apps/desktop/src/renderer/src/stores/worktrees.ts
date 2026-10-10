import { create } from "zustand";
import type { Race, Worktree } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useProject } from "./project.ts";

interface WorktreesState {
  list: Worktree[] | null; // null: not a git repo, so no tabs
  races: Record<string, Race>;
  open: string | null; // race shown in the race view
  busy: boolean;
  refresh(): Promise<void>;
  create(name: string): Promise<boolean>;
  switchTo(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  race(actionId: string, n?: number): Promise<void>;
  sandbox(patchId: string, actionId?: string): Promise<void>;
  adopt(name: string): Promise<void>;
  cleanUp(raceId: string): Promise<void>;
}

export const useWorktrees = create<WorktreesState>((set, get) => ({
  list: null,
  races: {},
  open: null,
  busy: false,
  async refresh() {
    try {
      set({ list: await api().listWorktrees() });
    } catch {
      set({ list: null });
    }
  },
  async create(name) {
    const w = await call((a) => a.createWorktree(name), "Couldn't make the worktree");
    if (w) await get().refresh();
    return !!w;
  },
  async switchTo(name) {
    set({ busy: true });
    const p = await call((a) => a.switchWorktree(name), `Couldn't switch to ${name}`);
    set({ busy: false });
    if (p) useProject.getState().setProject(p);
    await get().refresh();
  },
  async remove(name) {
    await call((a) => a.removeWorktree(name), `Couldn't remove ${name}`);
    await get().refresh();
  },
  async race(actionId, n = 2) {
    const r = await call((a) => a.startRace(actionId, n), "Couldn't start the race");
    if (r) set((s) => ({ races: { ...s.races, [r.id]: s.races[r.id] ?? r }, open: r.id }));
  },
  async sandbox(patchId, actionId) {
    const r = await call((a) => a.trySandbox(patchId, actionId), "Couldn't try it in a sandbox");
    if (r) set((s) => ({ races: { ...s.races, [r.id]: s.races[r.id] ?? r }, open: r.id }));
  },
  async adopt(name) {
    await call((a) => a.adoptWorktreeFix(name), "Couldn't bring the fix over");
  },
  async cleanUp(raceId) {
    const r = get().races[raceId];
    if (!r) return;
    for (const c of r.candidates) await call((a) => a.removeWorktree(c.worktree), `Couldn't remove ${c.worktree}`);
    set((s) => ({ open: s.open === raceId ? null : s.open }));
    await get().refresh();
  },
}));

/** The open tab follows a branch switched outside Shrike (a terminal checkout): git and the Changes dock see it first. */
export const withBranch = (list: Worktree[] | null, branch: string | undefined): Worktree[] | null =>
  list && branch && list.some((w) => w.current && w.branch !== branch) ? list.map((w) => (w.current ? { ...w, branch } : w)) : list;

/** Push channels for W1/W3. Returns an unsubscribe. */
export function connectWorktrees(): () => void {
  const a = api();
  const offs = [
    a.on("worktrees:update", (list) => Array.isArray(list) && useWorktrees.setState({ list })),
    // the open tab's run is the app pane's run: follow it (main only publishes tabs when a worktree's own run changes)
    a.on("run:status", (st) => useWorktrees.setState((s) => (s.list ? { list: s.list.map((w) => (w.current ? { ...w, running: st.state === "starting" || st.state === "running" } : w)) } : {}))),
    a.on("git:update", (g) => useWorktrees.setState((s) => ({ list: withBranch(s.list, g?.branch) }))),
    a.on("scm:update", (g) => useWorktrees.setState((s) => ({ list: withBranch(s.list, g?.branch) }))),
    a.on("race:update", (r) => r && typeof r.id === "string" && useWorktrees.setState((s) => ({ races: { ...s.races, [r.id]: r }, open: s.races[r.id] ? s.open : r.id }))), // a new race opens its view, whoever started it
  ];
  return () => offs.forEach((off) => off());
}
