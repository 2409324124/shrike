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

const MAX_ACTIONS = 500; // main's store keeps the same number of trips (MAX_TRIPS) plus Server output
const SERVER_OUTPUT_ID = "0".repeat(16);

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
      if (!added) return { byId, order: s.order };
      const order = sortIds(byId);
      for (const id of order.slice(MAX_ACTIONS)) if (id !== SERVER_OUTPUT_ID) delete byId[id];
      return { byId, order: order.filter((id) => byId[id]) };
    });
  },
  replaceAll(list) {
    const byId: Record<string, ActionView> = {};
    for (const a of list) if (valid(a)) byId[a.id] = a;
    set({ byId, order: sortIds(byId) });
  },
  clear: () => set({ byId: {}, order: [] }),
}));
