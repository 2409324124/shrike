import { useEffect } from "react";
import { create } from "zustand";
import type { LearnComment, ReviewLessonsView, ShrikeEvents } from "@shrike/schema";
import { api, errorMessage } from "../../lib/api.ts";

// RL: the Lessons tab, the PR panel's chips and Ship's self-check share this. Main mines and clusters; this only shows.

type Mastered = ShrikeEvents["lessons:mastered"];

interface LessonsStore {
  view: ReviewLessonsView | null;
  note: string | null;
  open: string | null; // the lesson card that's open (a chip click opens it)
  learning: string | null; // the comment Learn from this is working on
  mastered: Mastered[]; // RL9 windows waiting their turn
  load(): Promise<void>;
  refresh(limit?: number): Promise<void>;
  learn(c: LearnComment): Promise<void>;
  check(force?: boolean): Promise<void>;
  fix(): Promise<void>;
}

const valid = (v: unknown): v is ReviewLessonsView => !!v && typeof v === "object" && Array.isArray((v as ReviewLessonsView).lessons) && Array.isArray((v as ReviewLessonsView).reviewers);

export const useLessons = create<LessonsStore>((set, get) => ({
  view: null,
  note: null,
  open: null,
  learning: null,
  mastered: [],
  async load() {
    try {
      const v = await api().reviewLessons();
      if (valid(v)) set({ view: v });
    } catch (e) {
      set({ note: errorMessage(e) });
    }
  },
  async refresh(limit) {
    set({ note: null });
    try {
      const v = await api().refreshReviewLessons(...(limit ? [{ limit }] : []));
      if (valid(v)) set({ view: v });
    } catch (e) {
      set({ note: errorMessage(e) });
    }
  },
  async learn(c) {
    set({ learning: c.commentId, note: null });
    try {
      const v = await api().learnFromComment(c);
      if (valid(v)) set({ view: v, ...(v.byComment[c.commentId] ? { open: v.byComment[c.commentId]!.lessonId } : {}) });
    } catch (e) {
      set({ note: errorMessage(e) });
    } finally {
      set({ learning: null });
    }
  },
  async check(force) {
    try {
      const c = await api().selfCheck(...(force ? [{ force }] : []));
      const v = get().view;
      if (v) set({ view: { ...v, ...(c ? { check: c } : {}) } });
    } catch (e) {
      set({ note: errorMessage(e) });
    }
  },
  async fix() {
    try {
      await api().fixSelfCheck();
    } catch (e) {
      set({ note: errorMessage(e) });
    }
  },
}));

/** Mount once (LessonsLayer in the Shell): main's pushes keep every surface in step. */
export function useLessonsBridge(): void {
  useEffect(() => {
    const a = api();
    if (!useLessons.getState().view) void useLessons.getState().load();
    const offs = [
      a.on("lessons:update", (v) => valid(v) && useLessons.setState({ view: v })),
      a.on("lessons:mastered", (m) => m && typeof m.title === "string" && useLessons.setState((s) => ({ mastered: [...s.mastered, m].slice(-4) }))),
      a.on("project:opened", () => void useLessons.getState().load()),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
