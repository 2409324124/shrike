import { useLayoutEffect, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { X } from "lucide-react";
import type { AgentRunInfo, AgentStep } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";
import { branchFinding } from "@shrike/agent/branches";
import { branchLines, branchState, useAgent } from "../stores/agent.ts";
import { tripFor, useThread } from "../stores/thread.ts";
import { lineDiff } from "../lib/hud.ts";
import { cx, IconButton, Spinner } from "../components/ui.tsx";
import { probeCap, sentence } from "./logic.ts";

// C1–C7 conversation branches: the subway map, the fork and aside inputs, the aside bubble, Compare, and per-branch probes.

const ROW = 14;
const EMPTY: AgentStep[] = [];

export const branchTone = (r?: Pick<AgentRunInfo, "color">): string => (r?.color && r.color in color ? color[r.color as keyof typeof color] : color.violet);

function useLines() {
  const run = useAgent((s) => s.run);
  const runs = useAgent((s) => s.runs);
  return useMemo(() => branchLines({ run, runs }), [run, runs]);
}

function useStepsOf(id: string | undefined): AgentStep[] {
  return useAgent((s) => (!id ? EMPTY : id === s.run?.id ? s.steps : (s.runSteps[id] ?? EMPTY)));
}

const STATE_WORD = { thinking: "thinking", found: "found", fixed: "fixed", stopped: "stopped" } as const;

function Dot({ state, tone }: { state: keyof typeof STATE_WORD; tone: string }) {
  const hollow = state === "stopped";
  return (
    <span
      aria-hidden
      className="inline-block size-[7px] shrink-0 rounded-full border"
      style={{ borderColor: hollow ? color.inkDim : tone, background: hollow ? "transparent" : tone, boxShadow: state === "fixed" ? `0 0 0 2px color-mix(in srgb, ${color.ok} 60%, transparent)` : undefined }}
    />
  );
}

/** C2: main as one line, each branch peeling off at its step, name and state dot. Click a line to show it. Hidden with only main. */
export function BranchMap() {
  const { main, branches } = useLines();
  const viewing = useAgent((s) => s.viewing);
  const forking = useAgent((s) => s.forking);
  const runSteps = useAgent((s) => s.runSteps);
  const head = main[0];
  const mainSteps = useStepsOf(head?.id);
  if (!head || (!branches.length && !forking)) return null;
  const rows = branches.map((b) => b.id);
  const xOf = (b: AgentRunInfo) => {
    const parentRow = rows.indexOf(b.parentRunId ?? "");
    const list = b.parentRunId === head.id ? mainSteps : (runSteps[b.parentRunId ?? ""] ?? []);
    const i = list.findIndex((x) => x.id === b.branchFromStepId);
    return { x: i >= 0 ? 6 + (84 * (i + 1)) / list.length : parentRow >= 0 ? 50 : 12, py: (parentRow + 1) * ROW + ROW / 2 }; // ponytail: older main runs peel off near the start
  };
  const lines = [head, ...branches];
  const h = (lines.length + (forking ? 1 : 0)) * ROW;
  const on = (id: string) => (viewing ?? head.id) === id;
  return (
    <nav aria-label="Branches" className="relative w-full" style={{ height: h }}>
      <svg className="pointer-events-none absolute inset-y-0 left-0 w-[34%]" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" aria-hidden>
        <path d={`M 2 ${ROW / 2} L 100 ${ROW / 2}`} fill="none" stroke={color.inkDim} strokeWidth={on(head.id) ? 2 : 1.2} vectorEffect="non-scaling-stroke" opacity={on(head.id) ? 1 : 0.5} />
        {branches.map((b, i) => {
          const { x, py } = xOf(b);
          const y = (i + 1) * ROW + ROW / 2;
          const tone = branchTone(b);
          return (
            <path
              key={b.id}
              d={`M ${x} ${py} C ${x + 5} ${py}, ${x + 2} ${y}, ${x + 9} ${y} L 100 ${y}`}
              fill="none"
              stroke={tone}
              strokeWidth={on(b.id) ? 2.2 : 1.3}
              vectorEffect="non-scaling-stroke"
              opacity={on(b.id) ? 1 : 0.5}
              style={on(b.id) ? { filter: `drop-shadow(0 0 3px ${tone})` } : undefined}
            />
          );
        })}
      </svg>
      <ul className="m-0 list-none p-0">
        {lines.map((r, i) => {
          const isMain = i === 0;
          const st = branchState(r, isMain ? mainSteps : (runSteps[r.id] ?? []));
          const tone = isMain ? color.inkDim : branchTone(r);
          return (
            <li key={r.id} className="absolute inset-x-0" style={{ top: i * ROW, height: ROW }}>
              <button
                type="button"
                aria-current={on(r.id) || undefined}
                aria-label={`${isMain ? "Main" : `Branch ${r.name ?? ""}`}, ${STATE_WORD[st]}`}
                title={isMain ? "Show main" : `Show this branch: ${r.name ?? ""}`}
                className="flex size-full items-center gap-1.5 pl-[34%] text-left"
                onClick={() => useAgent.getState().view(isMain ? null : r.id)}
              >
                <Dot state={st} tone={tone} />
                <span className={cx("truncate font-mono text-[9.5px] tracking-[0.06em]", on(r.id) ? "text-ink" : "text-faint")}>{isMain ? "main" : (r.name ?? "branch")}</span>
                <span className="lbl text-[8.5px] text-faint">{STATE_WORD[st]}</span>
              </button>
            </li>
          );
        })}
        {forking && (
          <li className="absolute inset-x-0 flex items-center gap-1.5 pl-[34%] text-[9.5px] text-dim" style={{ top: lines.length * ROW, height: ROW }}>
            <Spinner size={8} /> Making a branch…
          </li>
        )}
      </ul>
    </nav>
  );
}

function stopKeys(e: KeyboardEvent): void {
  e.stopPropagation(); // keep Shrike's single-key shortcuts out of the field
}

/** C1: "Ask differently…" under a step: the question, and an optional name. */
export function ForkInput({ runId, stepId, onDone }: { runId: string; stepId: string; onDone(): void }) {
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const busy = useAgent((s) => !!s.forking);
  const go = async () => {
    if (!q.trim() || busy) return;
    if (await useAgent.getState().branch(runId, stepId, q.trim(), name.trim() || undefined)) onDone();
  };
  const keys = (e: KeyboardEvent) => {
    stopKeys(e);
    if (e.key === "Enter") void go();
    else if (e.key === "Escape") onDone();
  };
  return (
    <div className="mt-1 flex gap-1">
      <input autoFocus aria-label="Ask differently" placeholder="Ask differently…" className="field min-w-0 flex-1 rounded-md border border-hair bg-abyss px-2 py-1 font-sans text-[12px] text-ink" value={q} disabled={busy} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} />
      <input aria-label="Branch name (optional)" placeholder="name" maxLength={40} className="field w-16 rounded-md border border-hair bg-abyss px-1.5 py-1 font-sans text-[11px] text-ink" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={keys} />
    </div>
  );
}

/** C3: a side question (like /btw). */
export function AsideInput({ onDone }: { onDone(): void }) {
  const [q, setQ] = useState("");
  return (
    <input
      autoFocus
      aria-label="Ask on the side"
      placeholder="Ask on the side… (main won't see it)"
      className="field w-full rounded-md border border-hair bg-abyss px-2 py-1 font-sans text-[12px] text-ink"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => {
        stopKeys(e);
        if (e.key === "Enter" && q.trim()) void useAgent.getState().askAside(q.trim()).then((ok) => ok && onDone());
        else if (e.key === "Escape") onDone();
      }}
    />
  );
}

/** C3: the aside's answer, in a bubble under the agent column. Keep it as a branch, or dismiss it (main never sees it). */
export function AsideBubble() {
  const id = useAgent((s) => s.aside);
  const r = useAgent((s) => (s.aside ? s.runs[s.aside] : undefined));
  const q = useAgent((s) => s.asideQ);
  const steps = useStepsOf(id ?? undefined);
  if (!id || !r) return null;
  const busy = r.status === "running";
  const answer = branchFinding(steps);
  const failed = steps.findLast((x) => x.kind === "error");
  return (
    <section aria-label="Side question" className="fade-in mt-1 rounded-[10px] border border-hair bg-[color-mix(in_srgb,var(--abyss)_92%,transparent)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="lbl flex-1 text-[9px]">On the side</span>
        <IconButton label="Dismiss" className="size-5" onClick={() => useAgent.getState().dismissAside()}>
          <X size={11} />
        </IconButton>
      </div>
      <p className="m-0 mt-0.5 text-[11.5px] text-dim">{sentence(q || r.name || "", 140, true)}</p>
      <p className={cx("m-0 mt-1 text-[12.5px] leading-snug", failed && !answer ? "text-fail" : "text-ink")}>
        {answer ? sentence(answer, 400, true) : failed ? sentence(failed.text) : busy ? (
          <span className="inline-flex items-center gap-1.5 text-dim">
            <Spinner size={9} /> Thinking…
          </span>
        ) : (
          "No answer."
        )}
      </p>
      {!busy && answer && (
        <button type="button" className="btn mt-1.5 h-6 px-2 text-[11px]" onClick={() => void useAgent.getState().keepAside()}>
          Keep as a branch
        </button>
      )}
    </section>
  );
}

/** C4/C5: what to do with the branch on show. */
export function BranchActions({ id, compare = true }: { id: string; compare?: boolean }) {
  const r = useAgent((s) => s.runs[id]);
  const steps = useStepsOf(id);
  const head = useLines().main[0];
  if (!r || !head) return null;
  const busy = r.status === "running";
  const finding = branchFinding(steps);
  const fixed = steps.some((x) => x.tool === "worktree_diff");
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={cx("btn h-6 px-2 text-[11px]", !fixed && "go")} disabled={busy || !finding} title={finding ? `Tell main: ${finding}` : "Nothing found yet"} onClick={() => void useAgent.getState().bringBack(id, "summary")}>
        Bring it back
      </button>
      {fixed && (
        <button type="button" className="btn go h-6 px-2 text-[11px]" disabled={busy} onClick={() => void useAgent.getState().bringBack(id, "fix")}>
          Use its fix
        </button>
      )}
      {compare && (
        <button type="button" className="btn h-6 px-2 text-[11px]" onClick={() => useAgent.setState({ compare: [head.id, id] })}>
          Compare
        </button>
      )}
    </div>
  );
}

type Row = { kind: "add" | "del"; text: string };

/** A branch's worktree diff (unified) or main's proposed patch, as changed lines only. */
function changedRows(steps: AgentStep[], patches: ReturnType<typeof useAgent.getState>["patches"]): Row[] {
  const wt = steps.findLast((x) => x.tool === "worktree_diff")?.detail;
  if (wt) {
    return wt
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => ({ kind: l[0] === "+" ? "add" : "del", text: l.slice(1) }));
  }
  const id = steps.findLast((x) => x.kind === "patch" && x.patchId)?.patchId;
  const p = id ? patches[id] : undefined;
  return (p?.files ?? []).flatMap((f) => lineDiff(f.before, f.after, 0).filter((l) => l.kind !== "ctx").map((l) => ({ kind: l.kind as Row["kind"], text: l.text })));
}

function rerunOf(steps: AgentStep[]): "passed" | "failed" | undefined {
  const t = steps.findLast((x) => x.kind === "tool_result" && (x.tool === "run_scenario" || x.tool === "compare_actions"))?.detail ?? "";
  return /Result: PASS|Verdict: fixed/.test(t) ? "passed" : /Result: FAIL|Verdict: (not fixed|regressed)/.test(t) ? "failed" : undefined;
}

const norm = (t?: string) => (t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** C4: two lines side by side: finding, fix diff and re-run, differences lit. */
export function Compare() {
  const pair = useAgent((s) => s.compare);
  const { main, branches } = useLines();
  const [a, b] = pair ?? ["", ""];
  const sa = useStepsOf(a || undefined);
  const sb = useStepsOf(b || undefined);
  const patches = useAgent((s) => s.patches);
  const runs = useAgent((s) => s.runs);
  if (!pair) return null;
  const options = [main[0], ...branches].filter((r): r is AgentRunInfo => !!r);
  const cols = [
    { id: a, steps: sa },
    { id: b, steps: sb },
  ].map((c) => ({ ...c, run: runs[c.id], finding: branchFinding(c.steps), rows: changedRows(c.steps, patches), rerun: rerunOf(c.steps) }));
  const [l, r] = cols as [(typeof cols)[number], (typeof cols)[number]];
  const setCol = (i: 0 | 1, id: string) => {
    useAgent.getState().loadSteps(id);
    useAgent.setState({ compare: i === 0 ? [id, b] : [a, id] });
  };
  return (
    <section aria-label="Compare branches" className="agentcard absolute top-16 left-1/2 z-30 -translate-x-1/2" style={{ width: "min(720px, calc(100% - 80px))" }}>
      <div className="mb-2 flex items-center gap-2">
        <b className="font-semibold">Compare</b>
        <span className="flex-1" />
        <IconButton label="Close" className="size-5" onClick={() => useAgent.setState({ compare: null })}>
          <X size={12} />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {cols.map((c, i) => {
          const other = i === 0 ? r : l;
          const tone = c.run?.parentRunId ? branchTone(c.run) : color.inkDim;
          const diffFinding = norm(c.finding) !== norm(other.finding);
          return (
            <div key={i} className="flex min-w-0 flex-col gap-2" style={{ borderTop: `2px solid ${tone}`, paddingTop: 6 }}>
              <select aria-label={`Line ${i + 1}`} className="field rounded-md border border-hair bg-abyss px-1.5 py-0.5 text-[11.5px] text-ink" value={c.id} onChange={(e) => setCol(i as 0 | 1, e.target.value)}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.parentRunId ? (o.name ?? "branch") : "main"}
                  </option>
                ))}
              </select>
              <div>
                <span className="lbl text-[9px]">Finding</span>
                <p className="m-0 text-[12.5px] leading-snug text-ink" style={diffFinding ? { boxShadow: `inset 2px 0 0 ${color.amber}`, paddingLeft: 6 } : undefined}>
                  {c.finding ? sentence(c.finding, 300, true) : <span className="text-faint">Nothing yet</span>}
                </p>
              </div>
              <div>
                <span className="lbl text-[9px]">Fix</span>
                {c.rows.length ? (
                  <div className="diff selectable">
                    {c.rows.slice(0, 10).map((row, k) => {
                      const unique = !other.rows.some((o) => o.kind === row.kind && o.text.trim() === row.text.trim());
                      return (
                        <div key={k} className={row.kind === "add" ? "a" : "d"} style={unique ? { boxShadow: `inset 2px 0 0 ${color.amber}` } : { opacity: 0.55 }} title={unique ? "Only this side changes this line" : undefined}>
                          <span className="m" aria-hidden>
                            {row.kind === "add" ? "+" : "-"}
                          </span>
                          {row.text.trim()}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="m-0 text-[12px] text-faint">No code change</p>
                )}
              </div>
              <div>
                <span className="lbl text-[9px]">Re-run</span>
                <p className={cx("m-0 text-[12.5px]", c.rerun === "passed" ? "text-ok" : c.rerun === "failed" ? "text-fail" : "text-faint")} style={c.rerun !== other.rerun ? { boxShadow: `inset 2px 0 0 ${color.amber}`, paddingLeft: 6 } : undefined}>
                  <span className="mr-1.5 inline-block size-[7px] rounded-full align-middle" style={{ background: tone }} aria-hidden />
                  {c.rerun === "passed" ? "It works now" : c.rerun === "failed" ? "It still fails" : "Not re-run"}
                </p>
              </div>
              {c.run?.parentRunId && <BranchActions id={c.id} compare={false} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** C7: each running branch's probe walks the Thread in its colour, one station per look (drawn over the Thread, beside main's probe). */
export function BranchProbes({ stage }: { stage: RefObject<HTMLElement | null> }) {
  const { branches } = useLines();
  const runSteps = useAgent((s) => s.runSteps);
  const actionId = useThread((s) => s.probe?.actionId ?? s.focus.actionId);
  const live = branches.filter((b) => b.status === "running");
  const want = useMemo(() => {
    const trip = actionId ? tripFor(actionId) : undefined;
    if (!trip) return [];
    const cap = probeCap(trip);
    return live.map((b, k) => ({ b, k, station: Math.min(cap, (runSteps[b.id] ?? EMPTY).filter((x) => x.kind === "tool_call").length) }));
  }, [actionId, live.map((b) => b.id).join(), runSteps]);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  useLayoutEffect(() => {
    if (!want.length || !actionId) return setPos({});
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const base = stage.current?.getBoundingClientRect();
      if (!base) return;
      const next: Record<string, { x: number; y: number }> = {};
      for (const w of want) {
        const el = document.querySelector(`.th-trip[data-trip="${CSS.escape(actionId)}"] .th-st[data-i="${w.station}"]`)?.getBoundingClientRect();
        if (el) next[w.b.id] = { x: Math.round(el.left + el.width / 2 - base.left + 9 + w.k * 7), y: Math.round(el.top + el.height / 2 - base.top - 9 - w.k * 7) };
      }
      setPos((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [want, actionId, stage]);
  if (!want.length) return null;
  return (
    <div aria-hidden className="branch-probes pointer-events-none absolute inset-0 z-[15]">
      {want.map(({ b }) => {
        const p = pos[b.id];
        const tone = branchTone(b);
        return p ? (
          <i
            key={b.id}
            data-branch={b.id}
            title={b.name}
            className="absolute size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: p.x, top: p.y, background: tone, boxShadow: `0 0 10px ${tone}`, transition: "left .5s var(--ease-out), top .5s var(--ease-out)" }}
          />
        ) : null;
      })}
    </div>
  );
}
