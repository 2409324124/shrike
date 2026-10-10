import { create } from "zustand";
import type { SkillDraft, SkillEvent } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { toast, useUi } from "../stores/ui.ts";
import { useProgress } from "../progress/store.ts";
import { enqueue, mergeLog } from "./queue.ts";

interface SystemState {
  current: SkillEvent | null; // the one window on screen
  queue: SkillEvent[];
  log: SkillEvent[]; // SL6, oldest first
  sound: boolean; // off by default; never in Calm
  drafts: SkillDraft[]; // evolve-on-outcome: learnings waiting for their outcome, and applied ones Undo can take back
  loadDrafts(): Promise<void>;
  undo(draftId: string): Promise<boolean>;
  editDraft(draftId: string): Promise<void>;
  push(e: SkillEvent): void;
  next(): void;
  addLog(more: SkillEvent[]): void;
  setSound(on: boolean): void;
}

const SOUND_KEY = "shrike.system.sound";
const readSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
};

export const useSystem = create<SystemState>((set, get) => ({
  current: null,
  queue: [],
  log: [],
  sound: readSound(),
  drafts: [],
  async loadDrafts() {
    const d = await Promise.resolve().then(() => api().listSkillDrafts()).catch(() => null);
    if (Array.isArray(d)) set({ drafts: d });
  },
  async undo(id) {
    const ok = await call((a) => a.undoSkillLevel(id).then(() => true), "Couldn't undo it");
    if (ok) toast("Undone. The previous version is back.", "ok");
    await get().loadDrafts();
    return !!ok;
  },
  async editDraft(id) {
    const path = await call((a) => a.editSkillDraft(id), "Couldn't open the draft");
    if (path) useUi.getState().openFile({ path, line: 1 });
  },
  push(e) {
    set((s) => ({ log: mergeLog(s.log, [e]), queue: enqueue(s.queue, s.current, e) }));
    if (!get().current && !useProgress.getState().notice) get().next();
  },
  next() {
    // one focal point: a waiting [PROMOTED] / card notice plays between windows, then ResultScreen's close calls next()
    set((s) => (useProgress.getState().notice ? { current: null } : { current: s.queue[0] ?? null, queue: s.queue.slice(1) }));
  },
  addLog(more) {
    set((s) => ({ log: mergeLog(s.log, more) }));
  },
  setSound(on) {
    try {
      localStorage.setItem(SOUND_KEY, on ? "1" : "0");
    } catch {}
    set({ sound: on });
  },
}));

/** A valid skill:event from main, or null. */
export function asSkillEvent(p: unknown): SkillEvent | null {
  const e = p as SkillEvent | null;
  return e && typeof e === "object" && typeof e.kind === "string" && typeof e.skillId === "string" && typeof e.name === "string" && typeof e.at === "number" ? e : null;
}
