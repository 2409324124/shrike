import { useEffect } from "react";
import { create } from "zustand";
import type { OptionsAnswer, OptionsSession } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { toast } from "../stores/ui.ts";
import { joinCards, toggleCard } from "./logic.ts";

// M: the cards in the renderer. main/options.ts holds the sessions; this mirrors them and keeps what is only on screen
// (which round you look at, the focused card, pins, combine picks, phone or desktop).

export type View = "phone" | "desktop";

interface OptionsUi {
  sessions: OptionsSession[];
  round: Record<string, number>; // session -> round on show
  focus: string | null; // card
  enlarged: string | null; // card filling the stage
  compare: boolean; // the approved mockup enlarged, next to the built app
  view: Record<string, View>; // card -> width
  pins: Record<string, string[]>; // session -> pinned cards
  picks: string[]; // combine picks, across rounds
  hidden: string | null; // the session put away with ×
  askMode: boolean; // M6: the Ask pill's "Show me options"
  sending: boolean;
  apply(s: OptionsSession): void;
  load(): Promise<void>;
  send(id: string, a: OptionsAnswer): Promise<boolean>;
  setRound(id: string, n: number): void;
  setFocus(card: string | null): void;
  togglePin(id: string, card: string): void;
  togglePick(card: string): void;
}

export const useOptions = create<OptionsUi>((set, get) => ({
  sessions: [],
  round: {},
  focus: null,
  enlarged: null,
  compare: false,
  view: {},
  pins: {},
  picks: [],
  hidden: null,
  askMode: false,
  sending: false,
  apply(s) {
    if (!s || typeof s.id !== "string" || !Array.isArray(s.rounds)) return;
    const prev = get().sessions.find((x) => x.id === s.id);
    const grew = s.rounds.length > (prev?.rounds.length ?? 0);
    const newest = s.rounds.at(-1);
    set((st) => ({
      sessions: [...st.sessions.filter((x) => x.id !== s.id), s].slice(-20),
      ...(grew && newest ? { round: { ...st.round, [s.id]: newest.n }, focus: newest.cards[0] ?? null, enlarged: null } : {}), // a new round arrives in view
      ...(grew && st.hidden === s.id ? { hidden: null } : {}),
    }));
  },
  async load() {
    const list = await api().getOptions?.().catch(() => undefined);
    if (Array.isArray(list)) for (const s of list) get().apply(s);
  },
  async send(id, a) {
    set({ sending: true });
    const s = await call((x) => x.answerOptions(id, a), "Couldn't send your pick");
    set({ sending: false });
    if (!s) return false;
    get().apply(s);
    if (a.action === "combine") set({ picks: [] });
    if (a.action === "approve") (set({ enlarged: null, picks: [] }), toast(`Approved ${joinCards(a.cards)}. Your agent is building it.`, "ok"));
    return true;
  },
  setRound: (id, n) => set((st) => ({ round: { ...st.round, [id]: n }, enlarged: null, focus: st.sessions.find((x) => x.id === id)?.rounds[n - 1]?.cards[0] ?? null })),
  setFocus: (focus) => set({ focus }),
  togglePin: (id, card) => set((st) => ({ pins: { ...st.pins, [id]: toggleCard(st.pins[id] ?? [], card) } })),
  togglePick: (card) => set((st) => ({ picks: toggleCard(st.picks, card) })),
}));

/** The one session on screen: the newest still asking or working. One question at a time. */
export const liveSession = (s: Pick<OptionsUi, "sessions" | "hidden">): OptionsSession | undefined =>
  s.sessions.findLast((x) => (x.state === "asking" || x.state === "working") && x.id !== s.hidden);

export function useOptionsBridge(): void {
  useEffect(() => {
    void useOptions.getState().load();
    return api().on("options:update", (s) => useOptions.getState().apply(s));
  }, []);
}
