import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { useActions } from "../stores/actions.ts";
import { useUi } from "../stores/ui.ts";
import { useWorktrees } from "../stores/worktrees.ts";
import { viewTrip } from "../hud/commands.ts";
import { cx } from "./ui.tsx";

/** One stack, top of the stage (the window's middle when there is no stage), over everything else on it (design-system README, stage z scale). */
export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  const newTrip = useUi((s) => s.newTrip);
  const box = useStageBox(toasts.length + (newTrip ? 1 : 0));
  return (
    <div aria-live="polite" style={box} className="@container pointer-events-none fixed z-50 flex flex-col items-center gap-2 px-3">
      <NewTripToast />
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="glass solid rise pointer-events-auto flex max-w-[420px] items-start gap-2.5 rounded-[10px] py-2 pr-2 pl-3 text-[12.5px]">
          <span className={cx("mt-[6px] size-[6px] shrink-0 rounded-full", t.tone === "error" ? "bg-fail" : t.tone === "ok" ? "bg-ok" : "bg-signal")} aria-hidden />
          <p className="selectable min-w-0 flex-1 break-words text-ink">{t.text}</p>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 text-dim hover:text-ink">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

const WINDOW: CSSProperties = { left: 0, right: 0, top: 62 };

/** The stage's top edge and width while anything shows, so a toast never straddles the app pane or the dock. */
function useStageBox(count: number): CSSProperties {
  const [box, setBox] = useState<CSSProperties>(WINDOW);
  useLayoutEffect(() => {
    if (!count) return;
    const stage = document.querySelector('section[aria-label="Shrike"]');
    if (!stage) return setBox(WINDOW);
    const place = () => {
      const r = stage.getBoundingClientRect();
      setBox({ left: r.left, width: r.width, top: r.top + 8 }); // --s-2 below the stage's top edge
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [count > 0]);
  return box;
}

/** A trip arrived while you were diving or typing: say so quietly instead of moving you. */
function NewTripToast() {
  const id = useUi((s) => s.newTrip);
  const a = useActions((s) => (id ? s.byId[id] : undefined));
  const raceOpen = useWorktrees((s) => !!s.open); // the race card is the focal point; its verdict wins over a reload trip

  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => useUi.getState().setNewTrip(null), 9000);
    return () => clearTimeout(t);
  }, [id]);

  if (!a || !id || raceOpen) return null;
  const word = a.status === "error" ? "broke" : a.status === "slow" ? "slow" : "worked";
  const tone = a.status === "error" ? "text-fail" : a.status === "slow" ? "text-slow" : "text-ok";
  return (
    <div role="status" className="flex max-w-full">
      <button type="button" onClick={() => viewTrip(id)} title={a.label} className="glass solid rise pointer-events-auto flex min-w-0 items-center gap-2.5 rounded-full py-2 pr-3 pl-4 text-[13px] whitespace-nowrap">
        <span className="lbl shrink-0">New trip</span>
        <span className="min-w-0 truncate text-ink">{a.label}</span>
        <span className={`lbl shrink-0 ${tone}`}>· {word}</span>
        <span className="lbl shrink-0 text-faint @max-[560px]:hidden">· Enter to view</span>
      </button>
    </div>
  );
}
