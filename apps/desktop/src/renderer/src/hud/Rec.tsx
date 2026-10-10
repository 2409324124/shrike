import { useEffect, useRef, useState } from "react";
import { cx } from "../components/ui.tsx";
import { toast, useUi } from "../stores/ui.ts";
import { useThread } from "../stores/thread.ts";
import { startClip, stopClip, useRecording } from "../capture/recorder.ts";

/** REC: the focused trip as a 9:16 or 16:9 clip (M1 to M4, plus M8 if a fix follows). */
export function Rec() {
  const recording = useRecording();
  const actionId = useThread((s) => s.focus.actionId);
  const open = useUi((s) => s.recMenu);
  const [aspect, setAspect] = useState<"16:9" | "9:16">("9:16");
  const [captions, setCaptions] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const setOpen = (recMenu: boolean) => useUi.setState({ recMenu });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const start = async () => {
    setOpen(false);
    if (!actionId) return;
    try {
      await startClip({ actionId, aspect, captions });
    } catch (e) {
      toast(`Couldn't record: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cx("btn", recording && "on")}
        style={recording ? { borderColor: "var(--fail)", color: "var(--fail)" } : undefined}
        aria-pressed={recording}
        aria-haspopup={!recording}
        disabled={!recording && !actionId}
        title={recording ? "Stop recording" : "Record this trip as a clip (R)"}
        onClick={() => (recording ? stopClip() : setOpen(!open))}
      >
        <i className={cx("size-[7px] rounded-full", recording ? "bg-fail shadow-[0_0_8px_var(--fail)]" : "border border-fail")} aria-hidden />
        {recording ? "Stop" : "Rec"}
      </button>
      {open && !recording && (
        // z-[47]: drops over the SDLC rail (z-40) and the right dock (z-[45])
        <div className="glass solid rise absolute top-10 right-0 z-[47] w-[232px] rounded-[var(--r-card)] p-3" role="dialog" aria-label="Record a clip">
          <p className="lbl mb-2.5">Clip shape</p>
          <div className="mb-3 grid grid-cols-2 gap-1.5">
            {(["9:16", "16:9"] as const).map((a) => (
              <button key={a} type="button" aria-pressed={aspect === a} onClick={() => setAspect(a)} className="btn justify-center">
                <span className={cx("inline-block border border-current", a === "16:9" ? "h-[8px] w-[14px]" : "h-[14px] w-[8px]")} aria-hidden />
                {a}
              </button>
            ))}
          </div>
          <label className="mb-3 flex items-center gap-2 text-[12.5px] text-dim">
            <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="accent-[var(--signal)]" />
            Captions
          </label>
          <button type="button" className="btn go w-full justify-center" onClick={() => void start()}>
            <i className="size-[7px] rounded-full bg-fail" aria-hidden />
            Record trip
          </button>
          <p className="mt-2 text-[11.5px] leading-snug text-faint">Plays the trip from the start, then asks where to save.</p>
        </div>
      )}
    </div>
  );
}
