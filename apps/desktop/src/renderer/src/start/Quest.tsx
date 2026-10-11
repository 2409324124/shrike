import { useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Play, RotateCw, Square } from "lucide-react";
import type { StartAsk, StartPlan, StartStep, ToolNeed } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { toast } from "../stores/ui.ts";
import { cx } from "../components/ui.tsx";
import { QuestWindow } from "../system/System.tsx";
import { CATEGORY_LABEL, focusStep, questLive, questTitle, tailLines } from "./logic.ts";
import { answerStart, startWithClaude, stopStart } from "./store.ts";

// R + SL5: the start quest in the dock, in place of "Your app didn't start". Claude drives it; the user answers inline.

export function StartQuest({ plan, name, legacy }: { plan: StartPlan | null; name?: string; legacy?: { error?: string; output?: string } }) {
  if (!plan) return <NotStarted name={name} legacy={legacy} />;
  const focus = focusStep(plan);
  const live = questLive(plan);
  const missing = plan.tools?.some((t) => t.blocking);
  return (
    <QuestWindow
      title={questTitle(plan, name)}
      objectives={plan.steps.map((s) => ({ id: s.id, title: s.title, state: s.state, detail: s.detail, fix: s.fix, command: s.command }))}
      complete={plan.state === "ready"}
      rewards={plan.rewards}
      runId={plan.runId}
      className="quest-dock"
      style={{ width: "100%" }}
    >
      {focus?.ask && live ? <Ask key={focus.ask.id} step={focus} ask={focus.ask} /> : focus?.output && !missing ? <StepDetail step={focus} /> : null}
      {!!plan.tools?.length && <MissingTools tools={plan.tools} />}
      {plan.state === "failed" && (
        <div className="mt-3 flex flex-col gap-2">
          {plan.error && !missing && <p className="m-0 text-[12px] leading-snug text-[var(--fail-ink)]">{plan.error}</p>}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="hud-btn solid" onClick={() => void startWithClaude()}>
              {missing ? <RotateCw size={10} aria-hidden /> : <Play size={9} className="fill-current" aria-hidden />}
              {missing ? "Check again" : "Try again with Claude"}
            </button>
            {plan.runId && (
              <button type="button" className="hud-btn" onClick={() => void stopStart()}>
                Stop what started
              </button>
            )}
          </div>
        </div>
      )}
      {plan.state === "stopped" && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[12px] text-dim">Stopped.</span>
          <button type="button" className="hud-btn solid" onClick={() => void startWithClaude()}>
            <Play size={9} className="fill-current" aria-hidden />
            Run again
          </button>
        </div>
      )}
      <Commands plan={plan} />
      {live && (
        <button type="button" className="btn mt-3" onClick={() => void stopStart()} aria-label="Stop starting the app">
          <Square size={8} className="fill-current" aria-hidden />
          Stop
        </button>
      )}
    </QuestWindow>
  );
}

/** Before Claude has started (or after the old quick start failed): one clear way forward, never a dead end. */
function NotStarted({ name, legacy }: { name?: string; legacy?: { error?: string; output?: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <QuestWindow title={questTitle(null, name)} objectives={[]} className="quest-dock" style={{ width: "100%" }}>
      <p className="sys-line m-0 mt-2 text-[12.5px]">Claude reads how this project starts, runs each step here, fixes what fails, and saves what worked as a skill for next time.</p>
      <button type="button" className="btn go mt-3" onClick={() => void startWithClaude()}>
        <Play size={9} className="fill-current" aria-hidden />
        Start with Claude
      </button>
      {legacy?.error && (
        <div className="mt-3">
          <button type="button" className="hud-btn -ml-2" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
            What the quick start said
          </button>
          {open && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              <p className="m-0 text-[12px] text-[var(--fail-ink)]">{legacy.error}</p>
              {legacy.output && <pre className="selectable m-0 max-h-[160px] overflow-auto font-mono text-[10.5px] leading-4 whitespace-pre-wrap text-dim">{tailLines(legacy.output, 16)}</pre>}
            </div>
          )}
        </div>
      )}
    </QuestWindow>
  );
}

/** The step in focus: its live output (its command already sits under the step). */
function StepDetail({ step }: { step: StartStep }) {
  return <pre className={cx("selectable m-0 mt-2 ml-6 max-h-[120px] overflow-auto font-mono text-[10.5px] leading-4 whitespace-pre-wrap", step.state === "failed" ? "text-[var(--fail-ink)]" : "text-dim")}>{tailLines(step.output, step.state === "failed" ? 10 : 6)}</pre>;
}

/** R6 inline: approve a command (once, or always for this kind), or fill a small settings form. */
function Ask({ step, ask }: { step: StartStep; ask: StartAsk }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const send = (allow: boolean, always?: boolean) => {
    setBusy(true);
    void answerStart(ask.id, { allow, ...(always ? { always } : {}), ...(ask.kind === "env" && allow ? { values } : {}) }).finally(() => setBusy(false));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(true);
  };
  return (
    <form onSubmit={submit} aria-label={ask.title} className="mt-2.5 rounded-[3px] border border-[color-mix(in_srgb,var(--slow)_55%,transparent)] bg-[color-mix(in_srgb,var(--slow)_7%,transparent)] px-2.5 py-2">
      <p className="micro m-0 text-[9.5px] text-slow">Your turn</p>
      <p className="m-0 mt-1 text-[13px] font-medium text-ink">{ask.title}</p>
      {ask.reason && <p className="m-0 mt-0.5 text-[12px] leading-snug text-dim">{ask.reason}</p>}
      {ask.command && (
        <code className="selectable mt-1.5 block font-mono text-[11px] leading-4 break-all text-ink">
          <span className="text-faint">$ </span>
          {ask.command}
        </code>
      )}
      {ask.kind === "env" && !!ask.keys?.length && (
        <div className="mt-2 flex flex-col gap-1.5">
          {ask.keys.map((k, i) => (
            <label key={k} className="flex flex-col gap-0.5">
              <span className="font-mono text-[10.5px] text-dim">{k}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus={i === 0}
                className="field h-7 font-mono text-[12px]"
                value={values[k] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
              />
            </label>
          ))}
          <span className="text-[11px] text-faint">Saved into {ask.file ?? "the env file"} on this computer. Claude never sees what you type.</span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="submit" className="hud-btn solid" disabled={busy} autoFocus={ask.kind !== "env"}>
          {ask.kind === "env" ? "Save" : "Allow"}
        </button>
        {ask.kind === "approve" && ask.category && (
          <button type="button" className="hud-btn" disabled={busy} onClick={() => send(true, true)} title={`Don't ask again in this project for: ${CATEGORY_LABEL[ask.category]}`}>
            Always allow · {CATEGORY_LABEL[ask.category]}
          </button>
        )}
        <button type="button" className="hud-btn" disabled={busy} onClick={() => send(false)}>
          No
        </button>
      </div>
      <span className="sr-only">For the step: {step.title}</span>
    </form>
  );
}

/** R-tools: what this computer is missing and how to get it. Shrike never installs it. */
function MissingTools({ tools }: { tools: ToolNeed[] }) {
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied. Paste it into a terminal.", "ok");
    } catch {
      toast("Couldn't copy to the clipboard.", "error");
    }
  };
  return (
    <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0" aria-label="Missing on this computer">
      {tools.map((t) => (
        <li key={t.tool} className={cx("rounded-[3px] border px-2.5 py-2", t.blocking ? "border-[color-mix(in_srgb,var(--fail)_55%,transparent)] bg-[color-mix(in_srgb,var(--fail)_7%,transparent)]" : "border-[color-mix(in_srgb,var(--slow)_55%,transparent)] bg-[color-mix(in_srgb,var(--slow)_7%,transparent)]")}>
          <p className={cx("micro m-0 text-[9.5px]", t.blocking ? "text-[var(--fail-ink)]" : "text-slow")}>{t.blocking ? "Missing on this computer" : "Runs with less"}</p>
          <p className="m-0 mt-1 text-[13px] font-medium text-ink">
            {t.name}
            {t.found && <span className="ml-1.5 font-mono text-[11px] font-normal text-dim">{t.found}</span>}
          </p>
          <p className="m-0 mt-0.5 text-[12px] leading-snug text-dim">{t.message}</p>
          {t.command && (
            <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
              <code className="selectable min-w-0 flex-1 font-mono text-[11px] leading-4 break-all text-ink">
                <span className="text-faint">$ </span>
                {t.command}
              </code>
              <button type="button" className="hud-btn shrink-0" onClick={() => void copy(t.command!)} aria-label={`Copy ${t.command}`}>
                <Copy size={10} aria-hidden />
                Copy
              </button>
            </div>
          )}
          <button type="button" className="hud-btn -ml-2 mt-1" onClick={() => void call((a) => a.openLink(t.url), "Couldn't open the download page")}>
            <ExternalLink size={10} aria-hidden />
            {t.command ? "Or get it from the download page" : "Get it from the download page"}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Every command, on expand: plain words next to the exact text. */
function Commands({ plan }: { plan: StartPlan }) {
  const [open, setOpen] = useState(false);
  const withCmd = plan.steps.filter((s) => s.command);
  if (!withCmd.length) return null;
  return (
    <div className="mt-2">
      <button type="button" className="hud-btn -ml-2" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
        Every command ({withCmd.length})
      </button>
      {open && (
        <ol className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">
          {withCmd.map((s) => (
            <li key={s.id} className="min-w-0">
              <span className="block truncate text-[12px] text-dim">{s.title}</span>
              <code className="selectable block font-mono text-[10.5px] leading-4 break-all text-ink">
                <span className="text-faint">{s.cwd ? `${s.cwd} $ ` : "$ "}</span>
                {s.command}
              </code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
