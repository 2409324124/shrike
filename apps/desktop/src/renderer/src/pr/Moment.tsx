import { useEffect, useState } from "react";
import { SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { useSystem } from "../system/store.ts";
import { useProgress } from "../progress/store.ts";
import { prMoment, type PrMoment } from "./moments.ts";
import { usePr } from "./store.ts";

// PR13: [Pull request opened], [All checks green], [Merged]. Waits while a skill or results window is up; 3.2s; a click sends it away.
export function PrMomentWindow() {
  const [m, setM] = useState<(PrMoment & { at: number }) | null>(null);
  const results = useProgress((s) => (s.open && !!s.result) || !!s.notice);
  const skill = useSystem((s) => !!s.current) || results;
  const calm = useCalm();
  useEffect(
    () =>
      usePr.subscribe((s, p) => {
        const x = s.view && s.view !== p.view ? prMoment(p.view, s.view) : null;
        if (x) setM({ ...x, at: Date.now() });
      }),
    [],
  );
  useEffect(() => {
    if (!m || skill) return;
    const t = setTimeout(() => setM(null), 3200);
    return () => clearTimeout(t);
  }, [m?.at, skill]);
  if (!m || skill) return null;
  const [tag, line, sub] =
    m.kind === "opened"
      ? ["Pull request opened", <>Pull request opened: <span className="font-mono">#{m.n}</span></>, "Your checks start on GitHub now. This panel follows them."]
      : m.kind === "merged"
        ? ["Merged", <><span className="text-violet">Merged:</span> <span className="font-mono">#{m.n}</span> is in {m.base}</>, "The branch's work is done. Its workspace can go when you're ready."]
        : ["All checks green", <><span className="text-ok">All checks green:</span> {m.passed} of {m.passed} passed</>, m.n ? `Pull request #${m.n} is ready for a review or a merge.` : "Open a pull request when you're ready."];
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-full" onClick={() => setM(null)}>
        <SystemFrame calm={calm} label={tag}>
          <SystemTag>System</SystemTag>
          <p className="m-0 mt-1 text-[15px] text-ink">{line}</p>
          <p className="m-0 mt-1 text-[12px] text-dim">{sub}</p>
        </SystemFrame>
      </div>
    </div>
  );
}
