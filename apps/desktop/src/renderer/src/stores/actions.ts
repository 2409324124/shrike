import { create } from "zustand";
import type { ActionView } from "@shrike/schema";

interface ActionsState {
  byId: Record<string, ActionView>;
  /** Newest first. */
  order: string[];
  upsert(list: ActionView[]): void;
  replaceAll(list: ActionView[]): void;
  clear(): void;
}

function sortIds(byId: Record<string, ActionView>): string[] {
  return Object.keys(byId).sort((a, b) => (byId[b]?.startMs ?? 0) - (byId[a]?.startMs ?? 0));
}

const valid = (a: ActionView | null | undefined): a is ActionView => !!a && typeof a.id === "string" && !!a.root;

export const useActions = create<ActionsState>((set) => ({
  byId: {},
  order: [],
  upsert(list) {
    set((s) => {
      const byId = { ...s.byId };
      let added = false;
      for (const a of list) {
        if (!valid(a)) continue;
        if (!byId[a.id] || byId[a.id]!.startMs !== a.startMs) added = true;
        byId[a.id] = a;
      }
      return { byId, order: added ? sortIds(byId) : s.order };
    });
  },
  replaceAll(list) {
    const byId: Record<string, ActionView> = {};
    for (const a of list) if (valid(a)) byId[a.id] = a;
    set({ byId, order: sortIds(byId) });
  },
  clear: () => set({ byId: {}, order: [] }),
}));
