import { create } from "zustand";
import type { ActionView, Progress, ProgressCard, QuestResult, ShrikeEvents } from "@shrike/schema";

// XP: the ledger as main last sent it, the results screen queue (one at a time) and the small outside-a-quest notices.
// Never block: a result that lands mid-work waits as the top bar's "Quest result" chip (open false) until clicked.

export interface Notice {
  id: number;
  promoted?: { from: string; to: string };
  cards: ProgressCard[];
}

interface ProgressState {
  progress: Progress | null;
  result: QuestResult | null; // XP3 on screen, or held as the chip
  open: boolean; // false: held as the chip
  asked: boolean; // opened from the chip: stays until closed
  queue: QuestResult[];
  notice: Notice | null; // promoted or a card unlocked outside a quest
  profile: boolean; // XP7 open
  apply(p: ShrikeEvents["progress:update"], busy?: boolean): void;
  next(busy?: boolean): void;
  hold(): void;
  show(): void;
  setProfile(open: boolean): void;
}

let n = 0;

export const useProgress = create<ProgressState>((set, get) => ({
  progress: null,
  result: null,
  open: false,
  asked: false,
  queue: [],
  notice: null,
  profile: false,
  apply({ progress, result, promoted, cards }, busy = false) {
    set({ progress });
    if (result) {
      if (get().result?.id === result.id || get().queue.some((q) => q.id === result.id)) return;
      if (get().result) set((s) => ({ queue: [...s.queue, result].slice(-3) }));
      else set({ result, open: !busy, asked: false });
    }
    if (promoted || cards?.length) set({ notice: { id: ++n, ...(promoted ? { promoted } : {}), cards: cards ?? [] } });
  },
  next(busy = false) {
    set((s) => ({ result: s.queue[0] ?? null, open: !busy, asked: false, queue: s.queue.slice(1) }));
  },
  hold: () => set((s) => (s.asked ? s : { open: false })),
  show: () => set({ open: true, asked: true }),
  setProfile(open) {
    set({ profile: open });
  },
}));

/** A trip this recent still counts as mid-work. */
export const TRIP_QUIET_MS = 4000;

/** Mid-work: a trip just arrived, something is open (dive, sheet, dialog, Ship sheet, file view) or the user is typing. */
/** A trip the user just made: a click or submit on a real element, a page load, or an explorer request. Not polling (implicit, no target), the server or the agent; not an old one loaded from disk. */
export const userTrip = (a: ActionView, now: number): boolean =>
  now - a.startMs < TRIP_QUIET_MS && (a.trigger === "click" || a.trigger === "submit" ? !!a.root.target : a.trigger === "navigation" || a.trigger === "explorer");

export const midWork = (s: { tripAgo: number; typing: boolean; open: readonly unknown[] }): boolean => s.tripAgo < TRIP_QUIET_MS || s.typing || s.open.some(Boolean);

/** A valid progress:update from main, or null. */
export function asUpdate(p: unknown): ShrikeEvents["progress:update"] | null {
  const u = p as ShrikeEvents["progress:update"] | null;
  return u && typeof u === "object" && u.progress && typeof u.progress.xp === "number" && (!u.result || Array.isArray(u.result.lines)) ? u : null;
}

/** XP3 timeline, ms from the screen opening. Pure so the tests and the screen agree. */
export const LINE_AT = (i: number) => 380 + i * 300;
export const COUNT_MS = 260;
export function timeline(lines: number, cards: number, promoted: boolean) {
  const total = LINE_AT(lines) + 120;
  const slam = total + 520;
  const bar = slam + 620;
  const rewards = bar + 900;
  const flip = rewards + 300;
  const promo = flip + (cards ? 900 : 200);
  const end = promoted ? promo + 600 : promo;
  return { total, slam, bar, rewards, flip, promo, end };
}

/** How far a counter is at time t: 0 before it starts, 1 once done. */
export const progressAt = (t: number, start: number, ms: number) => Math.min(1, Math.max(0, (t - start) / ms));
