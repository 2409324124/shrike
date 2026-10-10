import { create } from "zustand";
import type { PlaceKind } from "@shrike/schema";
import { useUi } from "../stores/ui.ts";

// I1: which place the left dock shows (null: your app). The Thread publishes its lanes in header order.
export interface InspectLane {
  id: string;
  kind: PlaceKind;
  name: string;
  detail?: string;
}

interface InspectorState {
  placeId: string | null;
  lanes: InspectLane[];
  open(id: string | null): void;
  toggle(id: string): void;
  setLanes(lanes: InspectLane[]): void;
}

const isApp = (l: InspectLane | undefined) => !l || l.kind === "caller" || l.kind === "client"; // SCREEN and PAGE are your app

export const useInspector = create<InspectorState>((set, get) => ({
  placeId: null,
  lanes: [],
  open(id) {
    const lane = get().lanes.find((l) => l.id === id);
    set({ placeId: isApp(lane) ? null : id });
    if (!isApp(lane)) useUi.setState({ appVisible: true });
  },
  toggle(id) {
    get().open(get().placeId === id ? null : id);
  },
  setLanes(lanes) {
    const { lanes: cur, placeId } = get();
    if (lanes.length === cur.length && lanes.every((l, i) => l.id === cur[i]!.id && l.name === cur[i]!.name)) return;
    set({ lanes, placeId: placeId && lanes.some((l) => l.id === placeId) ? placeId : null });
  },
}));
