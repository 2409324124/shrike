import "./review.css";
import { useEffect, useState } from "react";
import { useProject } from "../../stores/project.ts";
import { RankBadge, SystemFrame, SystemTag, useCalm } from "../../system/System.tsx";
import { useSystem } from "../../system/store.ts";
import { useLessons, useLessonsBridge } from "./store.ts";

// RL9 [Lesson Mastered]: the System's window, one at a time, after any skill window. Mount once in the Shell's stage.

const SHOW_MS = 3200;

export function LessonsLayer() {
  useLessonsBridge();
  const root = useProject((s) => s.project?.root);
  useEffect(() => void (root && useLessons.getState().load()), [root]);
  const m = useLessons((s) => s.mastered[0]);
  const system = useSystem((s) => !!s.current);
  const calm = useCalm();
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!m || held || system) return;
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), SHOW_MS);
    return () => clearTimeout(t);
  }, [m, held, system]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => (setLeaving(false), setHeld(false), useLessons.setState((s) => ({ mastered: s.mastered.slice(1) }))), calm ? 0 : 220);
    return () => clearTimeout(t);
  }, [leaving, calm]);
  if (!m || system) return null;
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-[min(520px,100%)]">
        <SystemFrame calm={calm} leaving={leaving} label={`Lesson mastered: ${m.title}`} pad="px-6 pt-3 pb-3.5" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onClick={() => setLeaving(true)}>
          <SystemTag>Lesson Mastered</SystemTag>
          <p className="rl-m-title">{m.title}</p>
          <p className="rl-m-line">Not flagged in your last {m.clean} reviewed PRs</p>
          <p className="rl-m-xp">
            <span>+{m.xp} XP</span>
            <RankBadge rank="S" small />
          </p>
        </SystemFrame>
      </div>
    </div>
  );
}
