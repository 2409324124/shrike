import { useEffect, useState } from "react";
import { SystemFrame, SystemTag, useCalm } from "../../system/System.tsx";
import { useSystem } from "../../system/store.ts";
import { PipelineView } from "./Pipeline.tsx";
import { useCi, useCiBridge } from "./store.ts";

// Mounted once over the Thread (hud/Sdlc.tsx finds exports named *Overlay in files named *Skill*): the CI bridge,
// the pipeline view and CI7 [Lesson Mastered], which waits while another System window is up (one focal point).

export function CiLessonsOverlay() {
  useCiBridge();
  return (
    <>
      <PipelineView />
      <LessonMastered />
    </>
  );
}

const SHOW_MS = 3200;

function LessonMastered() {
  const m = useCi((s) => s.mastered[0]);
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
    const t = setTimeout(() => (setLeaving(false), setHeld(false), useCi.setState((s) => ({ mastered: s.mastered.slice(1) }))), calm ? 0 : 220);
    return () => clearTimeout(t);
  }, [leaving, calm]);
  if (!m || system) return null;
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-[min(480px,100%)]">
        <SystemFrame calm={calm} leaving={leaving} label={`Lesson mastered: ${m.job}`} pad="px-5 pt-2.5 pb-3" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onClick={() => setLeaving(true)}>
          <SystemTag>Lesson mastered</SystemTag>
          <b className="mt-2 block text-center text-[15px] font-semibold text-ink">{m.job}</b>
          <p className="m-0 mt-1 text-center text-[12px] leading-snug text-dim">
            <span className="text-signal">Learned:</span> {m.learned}
          </p>
        </SystemFrame>
      </div>
    </div>
  );
}
