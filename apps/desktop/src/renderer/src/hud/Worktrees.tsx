import { useEffect } from "react";
import { X } from "lucide-react";
import type { ActionView, Race } from "@shrike/schema";
import { useWorktrees } from "../stores/worktrees.ts";
import { useAgent } from "../stores/agent.ts";
import { cx, IconButton, Spinner } from "../components/ui.tsx";
import { ActivityLine, connectRaceSteps, FileChips, SkillChip, TokensBadge, useRunSteps } from "./Xray.tsx"; // X7

type Cand = Race["candidates"][number];

const WORDS: Record<Cand["state"], string> = {
  thinking: "Thinking",
  patched: "Fix written",
  rerunning: "Re-running",
  green: "Worked",
  red: "Still broken",
  failed: "Didn't finish",
};

const tone = (s: Cand["state"] | undefined) => (s === "green" ? "var(--ok)" : s === "red" || s === "failed" ? "var(--fail)" : s ? "var(--violet)" : undefined);

function Dot({ color, busy }: { color?: string; busy?: boolean }) {
  return (
    <i
      aria-hidden
      className="size-[6px] shrink-0 rounded-full border border-faint"
      style={color ? { background: color, borderColor: color, boxShadow: `0 0 8px ${color}` } : undefined}
    />
  );
}

/** A re-run trip as a small thread: one station per step, the failing one red, then the way back. */
function MiniThread({ view }: { view: ActionView }) {
  const steps = view.summary.steps.slice(0, 7);
  const failed = view.status === "error";
  const h = steps.length * 22 + 26;
  return (
    <svg width="100%" height={h} role="img" aria-label={`Re-run: ${view.summary.headline}`} className="overflow-visible">
      <line x1="7" y1="6" x2="7" y2={h - 18} stroke="var(--signal)" strokeOpacity="0.45" strokeWidth="1.5" />
      {steps.map((s, i) => (
        <g key={s.eventId + i} transform={`translate(0 ${8 + i * 22})`}>
          <circle cx="7" cy="0" r="4.5" fill="var(--abyss)" stroke={s.ok ? "var(--signal)" : "var(--fail)"} strokeWidth="1.5" />
          <text x="20" y="4" fill={s.ok ? "var(--ink-dim)" : "var(--fail-ink)"} fontSize="11.5">
            {s.text.length > 46 ? `${s.text.slice(0, 45)}…` : s.text}
          </text>
        </g>
      ))}
      <line x1="7" y1={h - 12} x2="30" y2={h - 12} stroke={failed ? "var(--fail)" : "var(--ok)"} strokeWidth="1.5" strokeDasharray={failed ? "3 3" : undefined} />
      <text x="38" y={h - 8} fill={failed ? "var(--fail)" : "var(--ok)"} fontSize="10.5" fontFamily="var(--mono)" letterSpacing="0.12em">
        {failed ? "STILL BROKEN" : "WORKED"}
      </text>
    </svg>
  );
}

function Candidate({ r, c, focal }: { r: Race; c: Cand; focal: boolean }) {
  const working = c.state === "thinking" || c.state === "patched" || c.state === "rerunning";
  const sandbox = r.kind === "sandbox";
  const adopted = r.adopted === c.worktree;
  const steps = useRunSteps(c.runId); // X7
  return (
    <section
      aria-label={`${c.worktree}: ${WORDS[c.state]}`}
      className="flex min-w-0 flex-col gap-2.5 rounded-[var(--r-card)] border p-3"
      style={{ borderColor: focal ? "var(--ok)" : "var(--hair)", boxShadow: focal ? "0 0 22px color-mix(in srgb, var(--ok) 18%, transparent)" : undefined }}
    >
      <div className="flex items-center gap-2">
        <Dot color={tone(c.state)} busy={working} />
        <span className="lbl min-w-0 truncate text-ink" title={c.worktree}>
          {c.worktree}
        </span>
        <div className="flex-1" />
        <span className="lbl shrink-0 text-[9.5px] whitespace-nowrap" style={{ color: tone(c.state) }}>
          {adopted ? "In your code" : WORDS[c.state]}
        </span>
      </div>
      <p className="m-0 text-[13px] text-ink">{sandbox ? "Your agent's fix, tried in a sandbox copy" : c.approach[0]!.toUpperCase() + c.approach.slice(1)}</p>
      <div className="min-h-[60px]">
        {c.rerun ? (
          <MiniThread view={c.rerun} />
        ) : c.state === "thinking" && steps.length ? (
          <ActivityLine steps={steps} running quiet />
        ) : (
          <p className="m-0 flex items-center gap-2 text-[12px] text-dim">
            {working && <Spinner size={10} />}
            {c.state === "thinking" ? "Your agent is reading the code…" : c.state === "patched" ? "Fix written. Re-running soon…" : c.state === "rerunning" ? "Clicking through it again…" : (c.summary ?? "No re-run.")}
          </p>
        )}
      </div>
      {steps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <SkillChip steps={steps} />
            <FileChips steps={steps} max={4} />
          </div>
          <TokensBadge steps={steps} />
        </div>
      )}
      {c.files?.length && !steps.length ? <p className="m-0 truncate font-mono text-[11px] text-dim" title={c.files.join(", ")}>{c.files.join(", ")}</p> : null}
      {c.summary && c.rerun && <p className="m-0 text-[12px] text-dim">{c.summary}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={cx("btn", focal && "go")} disabled={!c.files?.length || !!r.adopted || working || c.state === "red" || c.state === "failed"} title={c.state === "red" || c.state === "failed" ? "This fix didn't work, so there's nothing worth bringing over." : undefined} onClick={() => void useWorktrees.getState().adopt(c.worktree)}>
          {sandbox ? "Bring it over" : "Use this fix"}
        </button>
        <button type="button" className="btn" disabled={c.state === "thinking"} onClick={() => void useWorktrees.getState().switchTo(c.worktree)} title="Show this worktree: its code, its app and its trips">
          Open
        </button>
      </div>
    </section>
  );
}

/** W3/W4: the candidates side by side (stacked when the stage is narrow). The green one is the only thing that glows. Under the agent cards (z-20), so approvals show on top. */
export function RaceView() {
  const r = useWorktrees((s) => (s.open ? s.races[s.open] : undefined));
  useEffect(() => connectRaceSteps(), []); // X7
  if (!r) return null;
  const greens = r.candidates.filter((c) => c.state === "green");
  const lost = !r.adopted && r.candidates.every((c) => c.state === "red" || c.state === "failed");
  const close = () => useWorktrees.setState({ open: null });
  return (
    <section aria-label={r.kind === "sandbox" ? "Sandbox fix" : "Fix race"} className="glass solid rise absolute inset-x-3 top-3 z-10 flex max-h-[calc(100%-24px)] flex-col gap-3 overflow-auto rounded-[var(--r-card)] p-4 shadow-[0_20px_60px_var(--void)]">
      <div className="flex items-center gap-2.5">
        <span className="lbl shrink-0 whitespace-nowrap text-ink">{r.kind === "sandbox" ? "Sandbox" : `Try ${r.candidates.length === 2 ? "both" : "all"}`}</span>
        <span className="micro min-w-0 truncate text-[9.5px] text-faint" title={r.kind === "sandbox" ? "The fix runs in a copy of your code first" : "Each fix runs in its own copy of your code"}>
          {r.kind === "sandbox" ? "the fix runs in a copy of your code first" : "each fix runs in its own copy of your code"}
        </span>
        <div className="flex-1" />
        <IconButton label="Close" onClick={close}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        {r.candidates.map((c) => (
          <Candidate key={c.worktree} r={r} c={c} focal={!r.adopted && greens.length > 0 && greens[0] === c} />
        ))}
      </div>
      {lost && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-hair pt-3">
          <p className="m-0 min-w-[min(100%,14rem)] flex-1 text-[12.5px] text-ink">
            {r.candidates.length === 1 ? "The fix didn't work in the sandbox." : "None of the fixes worked."} Your code wasn't touched.
          </p>
          <button type="button" className="btn" onClick={() => (close(), useAgent.getState().openAndFocus("The fix didn't work when it was re-run. Find the cause again and try a different fix."))}>
            Find another fix
          </button>
          <button type="button" className="btn" onClick={() => void useWorktrees.getState().cleanUp(r.id)}>
            Throw {r.candidates.length === 1 ? "it" : "them"} away
          </button>
        </div>
      )}
      {r.adopted && (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-hair pt-3">
          <p className="m-0 min-w-[min(100%,14rem)] flex-1 text-[12.5px] text-ink">
            The fix from {r.adopted} is in your code. Clean up {r.candidates.length === 1 ? "the sandbox" : `the ${r.candidates.length} worktrees`}?
          </p>
          <button type="button" className="btn" onClick={() => void useWorktrees.getState().cleanUp(r.id)}>
            Clean up
          </button>
          <button type="button" className="btn" onClick={close}>
            Keep them
          </button>
        </div>
      )}
    </section>
  );
}

/** W4 entry: put on the patch card next to Apply. */
export function SandboxButton({ patchId, actionId, className }: { patchId: string; actionId?: string; className?: string }) {
  return (
    <button type="button" className={cx("btn", className)} title="Apply this fix in a copy of your code and re-run it there first" onClick={() => void useWorktrees.getState().sandbox(patchId, actionId)}>
      Try in a sandbox first
    </button>
  );
}
