import "./review.css";
import { useEffect } from "react";
import { cx } from "../../components/ui.tsx";
import { Dot } from "../../components/Activity.tsx";
import { checkLine } from "./logic.ts";
import { openLesson } from "./LessonChip.tsx";
import { useLessons } from "./store.ts";

// RL6: in Ship, above the primary button. Checks the branch against what reviewers keep flagging; never blocks shipping.

export function SelfCheckCard() {
  const lessons = useLessons((s) => s.view?.lessons.filter((l) => l.status !== "mastered" || l.spark.some(Boolean)).length ?? 0);
  const check = useLessons((s) => s.view?.check);
  useEffect(() => void (lessons && useLessons.getState().check()), [lessons > 0]);
  if (!lessons || !check) return null;
  const line = checkLine(check);
  const [head, result] = check.state === "done" ? [line.slice(0, line.indexOf(":") + 1), line.slice(line.indexOf(":") + 1)] : [line, ""];
  const fixed = check.found.length > 0 && check.found.every((f) => f.fixed);
  return (
    <section aria-label="Review self-check" className="rl-check" data-check-state={check.state}>
      <span className="lbl">Review self-check</span>
      <p className="mt-1 mb-0 flex items-baseline gap-1.5 text-[13px] text-ink" data-testid="self-check-line">
        {check.state === "checking" && <Dot on tone="var(--slow)" className="self-center" />}
        <span>
          {head}
          {result && <span className={cx(check.found.length ? (fixed ? "text-ok" : "text-slow") : "text-ok")}>{result}</span>}
        </span>
      </p>
      {check.note && <p className={cx("mt-1 mb-0 text-[12px]", check.state === "failed" ? "text-fail" : "text-dim")}>{check.note}</p>}
      {check.found.length > 0 && (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0">
          {check.found.map((f) => (
            <li key={f.lessonId} className="min-w-0 text-[12px] text-dim">
              <button type="button" className="text-left text-ink hover:underline" onClick={() => openLesson(f.lessonId)}>
                {f.title}
              </button>
              {f.fixed && <span className="micro ml-1.5 text-[9px] text-ok">Fixed</span>}
              {f.where && <span className="block truncate font-mono text-[10.5px] text-faint" title={f.where}>{f.where}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-1.5">
        {check.found.length > 0 && !fixed && (
          <button type="button" className="hud-btn" title="An agent run on what the check found; it ends by saying what it fixed" onClick={() => void useLessons.getState().fix()}>
            <span className="text-violet">✦</span> Fix it first
          </button>
        )}
        {check.state === "failed" && (
          <button type="button" className="hud-btn" onClick={() => void useLessons.getState().check(true)}>
            Check again
          </button>
        )}
      </div>
    </section>
  );
}
