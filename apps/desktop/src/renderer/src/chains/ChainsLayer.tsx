import "./chains.css";
import { useEffect, useState } from "react";
import { mainHead, useAgent } from "../stores/agent.ts";
import { SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { useSystem } from "../system/store.ts";
import { ChainPanel } from "./ChainPanel.tsx";
import { isOpenItem, TOAST_MS } from "./logic.ts";
import { useChains, useChainsBridge } from "./store.ts";
import { UpNextStack } from "./UpNext.tsx";

// P5: the System speaks for chains, one window at a time. It waits while a skill window (SL) is up, so there is one focal point.

const TAG: Record<string, string> = { saved: "Chain saved", queued: "Queued", next: "Next up", skipped: "Skipped", paused: "Paused", critique: "Critique", complete: "Chain complete", stopped: "Chain stopped", missed: "Missed" };

/** Over the stage below the lane header; while the chain panel is open it sits inside the panel, so it never covers it. Hover holds it only on a real move: closing the panel can drop it under a still cursor. */
function ChainToast({ inPanel }: { inPanel: boolean }) {
  const e = useChains((s) => s.toast);
  const panel = useChains((s) => s.open && s.mode === "run");
  const system = useSystem((s) => !!s.current);
  const calm = useCalm();
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!e || held || system) return;
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), TOAST_MS[e.kind] ?? 2200);
    return () => clearTimeout(t);
  }, [e, held, system]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => (setLeaving(false), setHeld(false), useChains.getState().next()), calm ? 0 : 220);
    return () => clearTimeout(t);
  }, [leaving, calm]);
  // the open chain panel already shows the score; the critique toast would be a second focal point
  useEffect(() => void (e?.kind === "critique" && panel && useChains.getState().next()), [e, panel]);
  if (!e || system) return null;
  const [head = "", tail = ""] = e.kind === "critique" ? e.text.replace(/^Critique\s*/, "").split(" → ") : [e.text.replace(/^(Queued|Next up|Skipped|Missed|Chain complete)[:.]\s*/, "") || "Every step ran."];
  const tag = TAG[e.kind] ?? "Chain";
  const frame = (
    <SystemFrame calm={calm} leaving={leaving} label={`${tag}: ${head}${tail ? ` → ${tail}` : ""}`} pad="px-5 pt-2.5 pb-3" onMouseMove={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onClick={() => setLeaving(true)}>
      <SystemTag>{tag}</SystemTag>
      <p className={cx2(e)}>
        {e.kind === "critique" ? (
          <>
            <span className="ch-toast-score">{head}</span>
            {tail && <span className="text-dim"> → {tail}</span>}
          </>
        ) : (
          head
        )}
      </p>
    </SystemFrame>
  );
  return inPanel ? (
    <div className="ch-toast-in">{frame}</div>
  ) : (
    <div className="pointer-events-none! absolute inset-x-0 top-14 z-[47] flex justify-center px-4">
      <div className="pointer-events-auto max-w-[min(520px,100%)]">{frame}</div>
    </div>
  );
}

const cx2 = (e: { kind: string; ok?: boolean }) => `ch-toast-text ${e.kind === "stopped" || e.kind === "skipped" || (e.kind === "complete" && e.ok === false) ? "warn" : e.kind === "complete" || e.kind === "saved" ? "ok" : ""}`;

/** Mount once in the Shell's stage: the bridge, the toasts, the chain panel, and up next when there's no agent pill to hold it. */
export function ChainsLayer() {
  useChainsBridge();
  const noRun = useAgent((s) => !mainHead(s));
  const queued = useChains((s) => s.items.some(isOpenItem));
  const open = useChains((s) => s.open);
  const asking = useAgent((s) => s.approvals.some((a) => !s.inline.includes(a.id)));
  const toast = <ChainToast inPanel={open} />;
  return (
    <>
      {noRun && queued && (
        <div className="glass solid absolute top-14 right-4 z-10 w-[300px] rounded-[var(--r-card)] px-2.5 py-2">
          <UpNextStack />
        </div>
      )}
      {open && !asking && <div className="ch-dim" aria-hidden />}
      <ChainPanel toast={open && toast} asking={asking} />
      {!open && toast}
    </>
  );
}
