import { create } from "zustand";

// SC1: the right dock. One tab at a time; ⌘⇧G toggles it, Ship and the PR panel open it.

export type DockTab = "changes" | "pr" | "lessons" | "tools" | "api"; // lessons: RL7 review lessons; tools: MCP hub; api: AP client

interface DockStore {
  open: boolean;
  tab: DockTab;
  show(tab?: DockTab): void;
  toggle(): void;
}

const KEY = "shrike.dock";
const saved = (): { open: boolean; tab: DockTab } => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { open?: unknown; tab?: unknown } | null;
    return { open: v?.open === true, tab: v?.tab === "pr" || v?.tab === "lessons" || v?.tab === "tools" || v?.tab === "api" ? v.tab : "changes" };
  } catch {
    return { open: false, tab: "changes" };
  }
};

export const useDock = create<DockStore>((set, get) => ({
  ...saved(),
  show: (tab) => set({ open: true, ...(tab ? { tab } : {}) }),
  toggle: () => set({ open: !get().open }),
}));

useDock.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: s.open, tab: s.tab }));
  } catch {}
});

export const openChanges = (): void => useDock.getState().show("changes");
