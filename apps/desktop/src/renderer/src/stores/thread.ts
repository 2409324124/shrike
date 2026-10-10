import { create } from "zustand";
import { useActions } from "./actions.ts";
import { knownPlaces, buildTrip, firstFailure, type Trip } from "../lib/thread-layout.ts";
import { useProject } from "./project.ts";
import { useRun } from "./run.ts";

export { firstFailure };
import { isBackgroundAction } from "../lib/format.ts";
import { resendOrder } from "../thread/logic.ts";

// Shared contract between the Thread view (thread/**), the shell/agent (hud/**) and the clip painter (capture/**).
interface ThreadState {
  focus: { actionId: string | null; station: number };
  dived: boolean;
  timeMode: boolean;
  expanded: Set<string>; // express-track station ids the user opened
  arriving: string | null; // action id currently playing M1 (drop) and M2/M3
  knit: Set<string>; // action ids that are verified re-runs (draw with M8 re-knit)
  probe: { actionId: string; station: number; ticks: number[]; found?: number } | null; // M7
  autoDive: boolean; // dive into the failure after a snap (Calm turns it off)
  openGroups: Set<string>; // D10: lane kinds whose group header the user expanded
  view: "thread" | "files"; // FV: the same trip and step, drawn as lanes or on the folder tree
  outward: 0 | 1 | 2; // FV: Esc steps out from the file cards to the tree (1), then the whole route (2)
  playing: boolean; // FV: Space steps forward on its own
  setView(view: "thread" | "files"): void;
  setOutward(o: 0 | 1 | 2): void;
  setPlaying(on: boolean): void;
  setFocus(actionId: string, station?: number): void;
  step(delta: 1 | -1): void; // next/previous station, crossing into neighbouring trips
  stepTrip(delta: 1 | -1): void;
  nextFailure(): void;
  dive(): void;
  surface(): void;
  toggleTime(): void;
  expand(stationId: string): void;
  arrive(actionId: string | null): void;
  markKnit(actionId: string): void;
  setProbe(p: ThreadState["probe"]): void;
  setAutoDive(v: boolean): void;
  toggleGroup(kind: string): void;
}

/** Trips oldest first (feed order, newest at the bottom). */
export const projectPlaces = () => knownPlaces(useProject.getState().project?.expectedPlaces, useRun.getState().status.processes);

export function tripOrder(): string[] {
  const { order, byId } = useActions.getState();
  const ids = order.filter((id) => { const a = byId[id]; return !!a && !isBackgroundAction(a); }).reverse(); // "Server output" is not a trip
  return resendOrder(ids, (id) => byId[id]?.root.resendOf); // AP: an edited resend sits under the trip it came from
}

export function tripFor(actionId: string): Trip | undefined {
  const view = useActions.getState().byId[actionId];
  return view ? buildTrip(view, useThread.getState().expanded, projectPlaces()) : undefined;
}

export const useThread = create<ThreadState>((set, get) => ({
  focus: { actionId: null, station: 0 },
  dived: false,
  timeMode: false,
  expanded: new Set(),
  arriving: null,
  knit: new Set(),
  probe: null,
  autoDive: true,
  openGroups: new Set(),
  view: "thread", // the Thread is always where a session starts
  outward: 0,
  playing: false,
  setView: (view) => set({ view, outward: 0, playing: false }),
  setOutward: (outward) => set({ outward, dived: false }),
  setPlaying: (playing) => set({ playing }),
  setFocus: (actionId, station = 0) => set({ focus: { actionId, station: Math.max(0, station) }, dived: false, outward: 0 }),
  step(delta) {
    const { focus } = get();
    const order = tripOrder();
    if (!focus.actionId) {
      const last = order[order.length - 1];
      if (last) get().setFocus(last, 0);
      return;
    }
    const trip = tripFor(focus.actionId);
    const n = trip?.stations.length ?? 0;
    const next = focus.station + delta;
    if (next >= 0 && next < n) return get().setFocus(focus.actionId, next);
    const ti = order.indexOf(focus.actionId) + delta;
    const nb = order[ti];
    if (!nb) return;
    const nt = tripFor(nb);
    get().setFocus(nb, delta > 0 ? 0 : Math.max(0, (nt?.stations.length ?? 1) - 1));
  },
  stepTrip(delta) {
    const order = tripOrder();
    const i = order.indexOf(get().focus.actionId ?? "");
    const nb = order[i < 0 ? order.length - 1 : i + delta];
    if (nb) get().setFocus(nb, 0);
  },
  nextFailure() {
    const order = tripOrder();
    const start = order.indexOf(get().focus.actionId ?? "");
    for (let k = 1; k <= order.length; k++) {
      const id = order[(start + k + order.length) % order.length]!;
      const t = tripFor(id);
      if (t && t.status === "error") return get().setFocus(id, firstFailure(t));
    }
  },
  dive: () => set({ dived: true }),
  surface: () => set({ dived: false }),
  toggleTime: () => set((s) => ({ timeMode: !s.timeMode })),
  expand: (id) => set((s) => ({ expanded: new Set(s.expanded).add(id) })),
  arrive: (arriving) => set({ arriving }),
  markKnit: (id) => set((s) => ({ knit: new Set(s.knit).add(id) })),
  setProbe: (probe) => set({ probe }),
  setAutoDive: (autoDive) => set({ autoDive }),
  toggleGroup: (kind) =>
    set((s) => {
      const openGroups = new Set(s.openGroups);
      if (!openGroups.delete(kind)) openGroups.add(kind);
      return { openGroups };
    }),
}));
