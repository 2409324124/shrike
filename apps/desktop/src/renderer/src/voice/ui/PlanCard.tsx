import { useEffect } from "react";
import { ArrowUpRight, Check, CircleDot, FileText, GitBranch, GitCommitHorizontal, GitPullRequest, Layers, PanelTop, Play, RefreshCw, Sparkles, Square, Undo2, Upload, X, type LucideIcon } from "lucide-react";
import type { VoicePlanStep } from "@shrike/schema";
import { cx, IconButton } from "../../components/ui.tsx";
import { Dot } from "../../components/Activity.tsx";
import { useAgent } from "../../stores/agent.ts";
import { planControls, runUndo, showPlan, useVoiceStore } from "../store.ts";
import { cardShown, leavesMac, progress, stepIcon, type StepIcon } from "./logic.ts";

// V-ui3 plan card: a spoken multi-step command as numbered steps. Outward steps wait for "yes" / "haan" or a click.

const ICON: Record<StepIcon, LucideIcon> = {
  stage: Layers, commit: GitCommitHorizontal, push: Upload, pr: GitPullRequest, ci: RefreshCw, run: Play, stop: Square,
  file: FileText, panel: PanelTop, branch: GitBranch, agent: Sparkles, undo: Undo2, step: CircleDot,
};

const DONE_MS = 4000; // a finished card stays this long, then the strip's echo carries on

function Mark({ s, n }: { s: VoicePlanStep; n: number }) {
  if (s.state === "running") return <Dot on tone="var(--signal)" size={9} />;
  if (s.state === "done") return <Check size={13} className="text-ok" aria-hidden />;
  if (s.state === "failed") return <X size={13} className="text-fail" aria-hidden />;
  return <span className={cx("v-num", s.state === "needs_yes" && "ask", s.state === "skipped" && "opacity-50")}>{n}</span>;
}

const WORD: Record<VoicePlanStep["state"], string> = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", needs_yes: "Needs your yes", skipped: "Skipped" };

function Step({ s, n }: { s: VoicePlanStep; n: number }) {
  const Icon = ICON[stepIcon(s.action)];
  return (
    <li className={cx("v-step", `is-${s.state}`)} data-step-state={s.state} aria-label={`Step ${n}: ${s.title}. ${WORD[s.state]}`}>
      <span className="grid size-5 place-items-center">
        <Mark s={s} n={n} />
      </span>
      <Icon size={13} className={cx("shrink-0", s.state === "done" ? "text-ok" : s.state === "needs_yes" ? "v-amber" : "text-dim")} aria-hidden />
      <span className="min-w-0">
        <span className={cx("block truncate text-[13.5px]", s.state === "skipped" ? "text-faint line-through" : "text-ink")}>{s.title}</span>
        {s.detail && <span className="block truncate font-mono text-[11px] text-dim">{s.detail}</span>}
        {s.error && <span className="block v-err text-[12px] leading-snug">{s.error}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {s.added && <span className="v-tag">Added</span>}
        {s.risk === "destructive" ? (
          <span className="v-tag fail">Throws work away</span>
        ) : (
          leavesMac(s) && (
            <span className="v-tag amber">
              <ArrowUpRight size={10} aria-hidden />
              Leaves your Mac
            </span>
          )
        )}
      </span>
    </li>
  );
}

export function PlanCard() {
  const plan = useVoiceStore((s) => s.plan);
  const undo = useVoiceStore((s) => s.undo);
  const asking = useAgent((s) => s.approvals.length > 0); // main's own approval card is up: it speaks for the running step

  useEffect(() => {
    if (plan?.state !== "done" && plan?.state !== "stopped") return;
    const t = setTimeout(() => useVoiceStore.getState().plan?.id === plan.id && showPlan(null), DONE_MS);
    return () => clearTimeout(t);
  }, [plan?.id, plan?.state]);

  // Enter says yes and Esc says no while the card waits, unless you're typing somewhere.
  useEffect(() => {
    if (plan?.state !== "needs_yes" || plan.steps.some((s) => s.state === "needs_yes" && s.risk === "destructive")) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, button, a, [contenteditable='true']") || e.repeat) return;
      if (e.key === "Enter") (e.preventDefault(), planControls()?.yes("click"));
      else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), planControls()?.no());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [plan?.id, plan?.state]);

  if (!cardShown(plan) || (plan.state === "running" && asking)) return null;
  const c = planControls();
  const { done, total } = progress(plan);
  const ask = plan.steps.find((s) => s.state === "needs_yes");
  const failed = plan.steps.find((s) => s.state === "failed");
  const destructive = ask?.risk === "destructive";
  const sayYes = destructive ? `yes, ${ask!.title.toLowerCase()}` : "yes";
  const headline = plan.state === "needs_yes" ? "Waiting for your yes" : plan.state === "running" ? `Step ${Math.min(done + 1, total)} of ${total}` : plan.state === "done" ? "Done" : plan.state === "stopped" ? "Stopped" : "Didn't finish";

  return (
    <section role="group" aria-label={`Plan: ${plan.heard}`} className={cx("v-plan glass solid rise", `is-${plan.state}`)} data-voice-plan data-state={plan.state}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="lbl whitespace-nowrap text-ink">
          Plan · {plan.steps.length} {plan.steps.length === 1 ? "step" : "steps"}
        </span>
        <span className="micro text-[9.5px] whitespace-nowrap text-faint">{plan.source === "planner" ? "Planned on your Mac" : "Understood instantly"}</span>
        <span className="flex-1" />
        <span className={cx("micro text-[9.5px] whitespace-nowrap", plan.state === "needs_yes" ? "v-amber" : plan.state === "done" ? "text-ok" : plan.state === "failed" ? "text-fail" : "text-dim")} aria-live="polite">
          {headline}
        </span>
        {plan.state !== "running" && (
          <IconButton label="Close the plan" onClick={() => (plan.state === "needs_yes" ? c?.no() : undefined, showPlan(null))}>
            <X size={12} />
          </IconButton>
        )}
      </header>
      <p className="m-0 mt-0.5 mb-2 truncate font-display text-[13px] text-dim" title={plan.heard}>
        “{plan.heard}”
      </p>
      <div className="v-bar" aria-hidden>
        <i style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
      <ol className="m-0 mt-2 grid list-none gap-0.5 p-0">
        {plan.steps.map((s, i) => (
          <Step key={s.id} s={s} n={i + 1} />
        ))}
      </ol>
      <footer className="mt-2.5 flex flex-wrap items-center gap-2">
        {plan.state === "needs_yes" && (
          <>
            <span className="mr-auto text-[12.5px] text-dim">
              Say <b className="v-amber font-medium">“{sayYes}”</b>
              {!destructive && (
                <>
                  {" "}or <b className="v-amber font-medium">“haan”</b>
                </>
              )}
              {destructive ? ", then click." : ", or click."}
            </span>
            <button type="button" className="btn" onClick={() => c?.no()}>
              No
            </button>
            <button type="button" className="btn v-yes" onClick={() => c?.yes("click")}>
              Yes, {ask?.title.toLowerCase() ?? "go ahead"}
            </button>
          </>
        )}
        {plan.state === "running" && (
          <>
            <span className="mr-auto text-[12.5px] text-dim">
              Say <b className="font-medium text-ink">“stop”</b> or <b className="font-medium text-ink">“ruko”</b> to stop.
            </span>
            <button type="button" className="hud-btn solid" onClick={() => c?.stop()}>
              <Square size={9} className="fill-current" aria-hidden />
              Stop
            </button>
          </>
        )}
        {(plan.state === "done" || plan.state === "stopped" || plan.state === "failed") && (
          <>
            <span className="mr-auto text-[12.5px] text-dim">
              {failed ? `Stopped at step ${plan.steps.indexOf(failed) + 1}. Nothing after it ran.` : plan.state !== "stopped" ? "All steps done." : done ? "Stopped. Steps already done stay done." : "Cancelled. Nothing was sent."}
            </span>
            {undo && plan.steps.some((s) => s.state === "done" && s.risk === "undoable") && (
              <button type="button" className="hud-btn solid" onClick={() => runUndo()}>
                <Undo2 size={11} aria-hidden />
                Undo
              </button>
            )}
          </>
        )}
      </footer>
    </section>
  );
}
