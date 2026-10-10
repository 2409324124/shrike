import { useEffect, useState } from "react";
import { Check, ChevronRight, ExternalLink, Minus, RotateCcw, X } from "lucide-react";
import type { PrCheck, PrView } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { cx, Spinner } from "../components/ui.tsx";
import { useNow } from "../components/Activity.tsx";
import { checkCounts, checkLine, groupChecks, ringParts, seconds, took } from "./logic.ts";
import { usePr } from "./store.ts";
import { LearnFromCheck, PreflightEntry } from "../lessons/ci/Learn.tsx"; // ci-lessons: CI8

// PR2 checks ring, PR3 check rows (steps, failing log tail, Explain, Fix it), Re-run failed.

const TONE: Record<PrCheck["state"], string> = { pass: "var(--ok)", fail: "var(--fail)", pending: "var(--slow)", skipped: "var(--ink-faint)" };
const FIXING = "Your agent is on it. Its fix shows as a change to approve, and you can try it in a sandbox first.";
const WORD: Record<PrCheck["state"], string> = { pass: "passed", fail: "failed", pending: "running", skipped: "skipped" };

export function StateIcon({ state, size = 12 }: { state: PrCheck["state"]; size?: number }) {
  if (state === "pending") return <i aria-label="running" className="inline-block shrink-0 rounded-full border-[1.5px] border-slow" style={{ width: size - 2, height: size - 2 }} />;
  const I = state === "pass" ? Check : state === "fail" ? X : Minus;
  return <I aria-label={WORD[state]} size={size} strokeWidth={2.6} className="shrink-0" style={{ color: TONE[state] }} />;
}

/** PR12: a check's status as a station on the check list's thread. */
function Station({ state }: { state: PrCheck["state"] }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-full bg-abyss">
      <StateIcon state={state} size={10} />
    </span>
  );
}

/** PR2: one ring, a segment per state, passing count in the middle. */
export function CheckRing({ checks, size = 58 }: { checks: PrCheck[]; size?: number }) {
  const n = checkCounts(checks);
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const gap = checks.length > 1 ? 2 : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={checkLine(n)} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hair)" strokeWidth={4} />
      {ringParts(n).map((p) => (
        <circle
          key={p.state}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TONE[p.state]}
          strokeWidth={4}
          strokeLinecap="butt"
          strokeDasharray={`${Math.max(0.5, (p.to - p.from) * c - gap)} ${c}`}
          strokeDashoffset={-p.from * c}
          style={{ filter: p.state === "fail" ? "drop-shadow(0 0 3px var(--fail))" : p.state === "pass" && !n.fail && !n.pending ? "drop-shadow(0 0 3px var(--ok))" : undefined }}
        />
      ))}
      <text x="50%" y="50%" transform={`rotate(90 ${size / 2} ${size / 2})`} textAnchor="middle" dominantBaseline="central" className="font-display" fontSize={size * 0.28} fontWeight={300} fill="var(--ink)">
        {n.pass}
        <tspan fill="var(--ink-faint)" fontSize={size * 0.18}>/{checks.length}</tspan>
      </text>
    </svg>
  );
}

export function Checks({ view }: { view: PrView }) {
  const busy = usePr((s) => s.busy);
  const n = checkCounts(view.checks);
  const groups = groupChecks(view.checks);
  const [passOpen, setPassOpen] = useState(false);
  const failedRuns = [...new Set(view.checks.filter((c) => c.state === "fail" && c.run).map((c) => c.run!))];
  const pr = view.pr;

  if (!view.checks.length)
    return (
      <section aria-label="Checks" className="px-4 py-3">
        <span className="lbl">Checks</span>
        <p className="mt-1.5 text-[12.5px] text-dim">{pr ? "No checks ran on this pull request." : "No checks have run on this branch yet. They start when you send it to GitHub."}</p>
      </section>
    );

  const verdict = n.fail ? `${n.fail === 1 ? "1 check needs" : `${n.fail} checks need`} a look` : n.pending ? "Still running. This updates by itself." : "Everything passed";
  return (
    <section aria-label="Checks" className="px-4 py-3">
      <div className="flex items-center gap-3">
        <CheckRing checks={view.checks} />
        <div className="min-w-0 flex-1">
          <span className="lbl">{pr ? "Checks" : `Checks on ${view.branch ?? "this branch"}`}</span>
          <p className={cx("mt-1 font-display text-[15px] font-semibold", n.fail ? "text-fail" : n.pending ? "text-slow" : "text-ok")}>{verdict}</p>
          <p className="text-[11.5px] text-dim" data-testid="check-line">{checkLine(n)}</p>
          <PreflightEntry />
        {failedRuns.length > 0 && (
          <button
            type="button"
            className="hud-btn solid mt-1.5"
            disabled={!!busy}
            title="Runs only the failed jobs again, on the same commit. Asks you first."
            onClick={async () => {
              for (const run of failedRuns) if (!(await usePr.getState().act({ kind: "rerun", run }, "Re-running the failed jobs. This updates by itself."))) break;
            }}
          >
            {busy?.startsWith("rerun") ? <Spinner size={10} /> : <RotateCcw size={11} />}
            Re-run failed
          </button>
          )}
        </div>
      </div>
      <ul className="relative mt-3 flex list-none flex-col gap-1 p-0">
        {view.checks.length > 1 && <li aria-hidden className="pointer-events-none absolute top-[15px] bottom-[15px] left-[16.25px] w-[1.5px] bg-hair" />}
        {groups.map((g) =>
          g.state === "pass" && (n.fail || n.pending || g.checks.length > 6) && !passOpen ? (
            <li key="pass" className="relative rounded-[8px]">
              <button type="button" className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] text-dim hover:bg-glass hover:text-ink" onClick={() => setPassOpen(true)} aria-expanded={false}>
                <Station state="pass" />
                <span className="flex-1">{g.checks.length} passing</span>
                <ChevronRight size={12} className="text-faint" />
              </button>
            </li>
          ) : (
            g.checks.map((c, i) => <CheckRow key={`${c.name}:${i}`} check={c} n={pr?.number} focal={g.state === "fail" && i === 0} />)
          ),
        )}
      </ul>
    </section>
  );
}

function CheckRow({ check: c, n, focal }: { check: PrCheck; n?: number; focal: boolean }) {
  const [open, setOpen] = useState(false);
  const job = usePr((s) => (c.url ? s.jobs[c.url] : undefined));
  const busy = usePr((s) => s.busy);
  const now = useNow(c.state === "pending");
  useEffect(() => void (open && c.url && usePr.getState().job(c.url, c.name)), [open, c.url, c.name]);
  const time = took(c, now);
  const canOpen = !!c.url;
  return (
    <li className={cx("relative rounded-[8px]", open && "bg-abyss")} data-check={c.name} data-state={c.state}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!canOpen && c.state !== "fail"}>
          <Station state={c.state} />
          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", c.state === "fail" ? "font-medium text-fail" : "text-ink")} title={c.name}>
            {c.name}
            {c.workflow && !c.name.startsWith(c.workflow) && <span className="ml-1.5 text-[11px] text-faint">{c.workflow}</span>}
          </span>
          {time && <span className="font-mono text-[10.5px] text-faint tabular-nums" title="How long it took">{time}</span>}
          {canOpen && <ChevronRight size={12} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />}
        </button>
        {c.url && (
          <button type="button" className="shrink-0 text-faint hover:text-ink" aria-label={`Open ${c.name} on GitHub`} title="Open its page in your browser" onClick={() => void api().openLink(c.url!)}>
            <ExternalLink size={11} />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-hair px-2.5 pt-2 pb-2.5">
          {!c.url ? null : job === "loading" || !job ? (
            <p className="lbl flex items-center gap-2 py-1"><Spinner size={10} /> Reading the steps</p>
          ) : "error" in job ? (
            <p className="text-[12px] text-fail">{job.error}</p>
          ) : (
            <>
              {job.steps.length > 0 && (
                <ol className="m-0 mb-2 flex list-none flex-col p-0" aria-label="Steps">
                  {job.steps.map((s, i) => (
                    <li key={i} className="relative flex items-center gap-2 py-[3px] pl-0.5 text-[11.5px]">
                      {i < job.steps.length - 1 && <i aria-hidden className="absolute top-[15px] left-[6px] h-[calc(100%-6px)] w-px bg-hair" />}
                      <StateIcon state={s.state} size={11} />
                      <span className={cx("min-w-0 flex-1 truncate", s.state === "fail" ? "font-medium text-fail" : s.state === "skipped" ? "text-faint" : "text-dim")}>{s.name}</span>
                      {s.seconds !== undefined && <span className="font-mono text-[10px] text-faint tabular-nums">{seconds(s.seconds)}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {job.summary && <p className="mb-1.5 text-[12.5px] leading-snug text-ink">{job.summary}</p>}
              {job.lines.length > 0 && <pre className="selectable mb-2 max-h-[140px] overflow-auto rounded-[6px] border border-hair bg-void/60 p-2 font-mono text-[10.5px] leading-[16px] whitespace-pre-wrap break-all text-dim" aria-label="Failing lines">{job.lines.join("\n")}</pre>}
            </>
          )}
          {c.state === "fail" && (
            <div className="flex flex-wrap items-center gap-2">
              {n && (
                <button type="button" className={cx("btn h-7 px-2.5", focal && "go")} disabled={!!busy} title="Your agent finds the cause and proposes a fix you approve (Explain a failing check skill)" onClick={() => void usePr.getState().agent({ kind: "fix-check", n, name: c.name }, FIXING)}>
                  {busy === "agent:fix-check" ? <Spinner size={10} /> : <span className="text-violet">✦</span>}
                  Fix it
                </button>
              )}
              {n && (
                <button type="button" className="btn h-7 px-2.5" disabled={!!busy} title="Only explain, change nothing" onClick={() => void api().explainCheck(n, c.name).then(() => usePr.setState({ note: { text: "Asked your agent why. Its answer shows in the agent column.", tone: "ok" } }), (e: unknown) => usePr.setState({ note: { text: errorMessage(e), tone: "error" } }))}>
                  <span className="text-violet">✦</span>
                  Explain
                </button>
              )}
              {!n && (
                <button type="button" className={cx("btn h-7 px-2.5", focal && "go")} disabled={!!busy} onClick={() => void usePr.getState().agent({ kind: "fix-check", name: c.name }, FIXING)}>
                  <span className="text-violet">✦</span>
                  Fix it
                </button>
              )}
              <LearnFromCheck check={c} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
