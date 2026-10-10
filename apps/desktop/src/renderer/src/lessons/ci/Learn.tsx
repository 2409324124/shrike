import { useState } from "react";
import { GraduationCap, PlaneTakeoff } from "lucide-react";
import type { PrCheck } from "@shrike/schema";
import { openChanges } from "../../dock/store.ts";
import { Spinner } from "../../components/ui.tsx";
import { useCi } from "./store.ts";

// CI8 on the PR panel's checks: Learn from this (a failing check becomes a lesson draft), and the way into pre-flight.

export function LearnFromCheck({ check }: { check: PrCheck }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const busy = useCi((s) => !!s.busy && s.busy !== "load");
  if (state === "done") return <span className="text-[11.5px] text-dim">Saved as a lesson. The next pre-flight tries it.</span>;
  return (
    <button
      type="button"
      className="hud-btn"
      disabled={busy || state === "busy"}
      title="Shrike reads this check's log, names the kind of failure and the job, and adds it to this project's CI lessons, so pre-flight catches it before CI next time"
      onClick={async () => {
        setState("busy");
        await useCi.getState().learn({ check: check.name, ...(check.url ? { url: check.url } : {}) });
        setState(useCi.getState().note?.tone === "error" ? "idle" : "done");
      }}
    >
      {state === "busy" ? <Spinner size={10} /> : <GraduationCap size={12} className="text-violet" aria-hidden />}
      Learn from this
    </button>
  );
}

/** Pre-flight from the checks header: run this change's CI jobs here, in the Changes dock. */
export function PreflightEntry() {
  const ready = useCi((s) => s.state?.ready);
  const running = useCi((s) => s.state?.run?.state === "running");
  if (ready === false) return null;
  return (
    <button
      type="button"
      className="hud-btn"
      title="Run the CI jobs your change touches on this computer first, the way CI runs them"
      onClick={() => {
        openChanges();
        if (!running) void useCi.getState().run();
      }}
    >
      <PlaneTakeoff size={11} aria-hidden />
      Pre-flight
    </button>
  );
}
