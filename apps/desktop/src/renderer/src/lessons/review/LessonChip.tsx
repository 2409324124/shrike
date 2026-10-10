import "./review.css";
import { GraduationCap } from "lucide-react";
import type { PrComment } from "@shrike/schema";
import { cx, Spinner } from "../../components/ui.tsx";
import { useDock } from "../../dock/store.ts";
import { chipText, nth } from "./logic.ts";
import { useLessons } from "./store.ts";

// RL8: in the PR panel, a comment that belongs to a lesson says how often it came up; any comment can be learned from.

export const openLesson = (id: string): void => {
  useLessons.setState({ open: id });
  useDock.getState().show("lessons");
};

export function LessonChip({ commentId }: { commentId: string }) {
  const hit = useLessons((s) => s.view?.byComment[commentId]);
  if (!hit) return null;
  return (
    <button type="button" className={cx("rl-chip", hit.nth === 1 && "first")} aria-label={chipText(hit.nth, hit.title)} title="Open this lesson" onClick={() => openLesson(hit.lessonId)} data-lesson-chip={hit.lessonId}>
      <span className="rl-chip-n">{nth(hit.nth)} time</span>
      <span className="truncate">{hit.title}</span>
    </button>
  );
}

export function LearnFromThis({ c, pr, path, line }: { c: PrComment; pr: number; path?: string; line?: number }) {
  const busy = useLessons((s) => s.learning === c.id);
  const known = useLessons((s) => !!s.view?.byComment[c.id]);
  const any = useLessons((s) => !!s.learning);
  if (known) return null;
  return (
    <button
      type="button"
      className="hud-btn px-1.5"
      disabled={any}
      title="Your agent turns this into a review lesson with how to fix it, so it doesn't come up again"
      onClick={() => void useLessons.getState().learn({ commentId: c.id, pr, author: c.author, body: c.body, at: c.at, ...(c.url ? { url: c.url } : {}), ...(path ? { path } : {}), ...(line ? { line } : {}) })}
    >
      {busy ? <Spinner size={10} /> : <GraduationCap size={11} className="text-violet" aria-hidden />}
      Learn from this
    </button>
  );
}
