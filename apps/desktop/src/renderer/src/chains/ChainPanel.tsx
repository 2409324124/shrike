import "./chains.css";
import { useState, type ReactNode } from "react";
import { Repeat, Square, X } from "lucide-react";
import type { ChainDef, ChainRun, ChainStep } from "@shrike/schema";
import { cx } from "../components/ui.tsx";
import { Elapsed } from "../components/Activity.tsx";
import { useCalm } from "../system/System.tsx";
import { blankChain, chainView, repeatUntil, type Branch } from "./logic.ts";
import { useChains } from "./store.ts";

// P-chain3 the chain as a vertical mini-Thread (editor and running), P-chain4 the score dial, P-chain5's loop guard line.

const LIVE = new Set<ChainRun["state"]>(["waiting", "running", "critiquing"]);
const CHECKS: [ChainDef["check"], string][] = [["critique", "Critique score"], ["succeeded", "It worked"], ["verified", "Verified fix"]];

/** P-chain4: the score as a big thin numeral in a ring; the tick marks the threshold. */
export function ScoreDial({ score, threshold, calm }: { score?: number; threshold: number; calm: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pass = score !== undefined && score >= threshold;
  const a = (threshold / 10) * 2 * Math.PI - Math.PI / 2;
  return (
    <div role="img" aria-label={score === undefined ? "Not scored yet" : `Score ${score} of 10`} className={cx("ch-dial", pass ? "pass" : score !== undefined && "below")}>
      <svg viewBox="0 0 72 72" width="72" height="72" aria-hidden>
        <circle cx="36" cy="36" r={r} className="track" />
        <circle cx="36" cy="36" r={r} className="arc" strokeDasharray={`${((score ?? 0) / 10) * c} ${c}`} transform="rotate(-90 36 36)" style={calm ? { transition: "none" } : undefined} />
        {score !== undefined && <line x1={36 + Math.cos(a) * (r - 5)} y1={36 + Math.sin(a) * (r - 5)} x2={36 + Math.cos(a) * (r + 5)} y2={36 + Math.sin(a) * (r + 5)} className="tick" />}
      </svg>
      <span className="num">{score === undefined ? "–" : score}</span>
      <span className="of">/ 10</span>
    </div>
  );
}

/** One node card: click to edit its text (editor), or its live state (running). */
function Node({ kind, title, text, placeholder, active, done, edit, onEdit, children }: { kind: string; title: string; text: string; placeholder: string; active?: boolean; done?: ChainStep; edit: boolean; onEdit?(v: string): void; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx("ch-node", kind, active && "active", done && "done")} aria-label={`${title} step`} role="group">
      <div className="flex items-center gap-2">
        <span className="lbl text-[9px]">{title}</span>
        {active && <Elapsed />}
        {done && !active && <span className={cx("lbl text-[9px]", done.status === "done" ? "text-ok" : "text-fail")}>{done.status === "done" ? "Done" : done.status === "stopped" ? "Stopped" : "Failed"}</span>}
      </div>
      {edit && open ? (
        <textarea autoFocus aria-label={`${title} prompt`} rows={3} className="field mt-1 h-auto w-full resize-none py-1 text-[12px] leading-snug" defaultValue={text} onBlur={(e) => (onEdit?.(e.target.value), setOpen(false))} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))} />
      ) : (
        <button type="button" disabled={!edit} className={cx("mt-0.5 block w-full text-left text-[12px] leading-snug", text.trim() ? "text-ink" : "text-faint")} onClick={() => setOpen(true)} title={edit ? "Click to edit" : undefined}>
          {text.trim() || placeholder}
        </button>
      )}
      {children}
    </div>
  );
}

function BranchRow({ b, label, lit, dim, children }: { b: Branch; label: string; lit: boolean; dim: boolean; children: ReactNode }) {
  return (
    <li className={cx("ch-branch", b, lit && "lit", dim && "dim")} data-branch={b} aria-current={lit ? "step" : undefined}>
      <span className="ch-when lbl">{label}</span>
      {children}
    </li>
  );
}

/** The mini-Thread: Ask → Critique (or Check) → the branches. `run` lights the taken branch and dims the others. */
function ChainThread({ def, run, edit, set }: { def: ChainDef; run: ChainRun | null; edit: boolean; set(p: Partial<ChainDef>): void }) {
  const calm = useCalm();
  const v = chainView(run);
  const step = (n: ChainStep["node"]) => run?.steps.findLast((s) => s.node === n);
  const critique = def.check === "critique";
  const dim = (b: Branch) => !!run && !!v.lit && v.lit !== b;
  const end = (t?: string) => t?.trim() || "";
  return (
    <div className={cx("ch-thread", run && "running", calm && "calm")}>
      <Node kind="ask" title="Ask" text={def.prompt} placeholder="The run going now, or the last one" edit={edit} onEdit={(prompt) => set({ prompt })} active={v.active === "prompt"} done={step("prompt")?.status ? step("prompt") : undefined} />
      <div className={cx("ch-link", v.active === "critique" && "live")} aria-hidden />
      {critique ? (
        <Node kind="critique" title={run && (run.round || run.state === "critiquing") ? `Critique · round ${run.round + (run.state === "critiquing" ? 1 : 0)} of ${def.maxRounds}` : "Critique"} text={def.rubric} placeholder="What a 10 looks like" edit={edit} onEdit={(rubric) => set({ rubric })} active={v.active === "critique"}>
          <div className="mt-2 flex items-center gap-3">
            <ScoreDial score={v.score} threshold={def.threshold} calm={calm} />
            <div className="min-w-0 flex-1">
              <label className="lbl flex items-center justify-between text-[9px]">
                Threshold <span className="text-ink">{def.threshold}</span>
              </label>
              <input type="range" min={0} max={10} step={0.5} value={def.threshold} disabled={!edit} aria-label="Threshold" className="ch-range mt-1 w-full" onChange={(e) => set({ threshold: Number(e.target.value) })} />
              {v.reason && <p className="mt-1 text-[11px] leading-snug text-dim">{v.reason}</p>}
            </div>
          </div>
        </Node>
      ) : (
        <Node kind="critique" title={def.check === "verified" ? "Check · verified fix" : "Check · it worked"} text={def.check === "verified" ? "The fix was applied and the re-run passed." : "The run finished without an error."} placeholder="" edit={false} active={false} />
      )}
      <ul className="ch-branches">
        {critique && (
          <BranchRow b="below" label={`Under ${def.threshold}`} lit={v.lit === "below"} dim={dim("below")}>
            <Node kind="below" title={def.loop ? "Polish, then score again" : "Polish"} text={end(def.below)} placeholder="Stop" edit={edit} onEdit={(below) => set({ below })} active={v.active === "below"} done={step("below")?.status ? step("below") : undefined}>
              {def.loop && (
                <span className="ch-loop lbl" aria-label="Loops back to the critique">
                  <Repeat size={9} /> Back to critique
                </span>
              )}
            </Node>
          </BranchRow>
        )}
        <BranchRow b="pass" label={critique ? `${def.threshold} or more` : "It worked"} lit={v.lit === "pass"} dim={dim("pass")}>
          <Node kind="pass" title={end(def.pass) ? "Then" : "Done"} text={end(def.pass)} placeholder="Stop here" edit={edit} onEdit={(pass) => set({ pass })} active={v.active === "pass"} done={step("pass")?.status ? step("pass") : undefined} />
        </BranchRow>
        <BranchRow b="failed" label="Run failed" lit={v.lit === "failed"} dim={dim("failed")}>
          <Node kind="failed" title={end(def.failed) ? "Recover" : "Stop"} text={end(def.failed)} placeholder="Stop and tell me" edit={edit} onEdit={(failed) => set({ failed })} active={v.active === "failed"} done={step("failed")?.status ? step("failed") : undefined} />
        </BranchRow>
      </ul>
    </div>
  );
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The loop guard, always on show: rounds and budget, editable before it starts, counting while it runs. */
function Guard({ def, run, set }: { def: ChainDef; run: ChainRun | null; set(p: Partial<ChainDef>): void }) {
  if (run) {
    const mins = Math.floor(((run.endedAt ?? Date.now()) - run.startedAt) / 60_000);
    return (
      <p className="lbl text-[9.5px] leading-relaxed" aria-label="Loop guard">
        Round {run.round} of {def.maxRounds}
        {def.budget.tokens ? ` · ${k(run.tokens)} of ${k(def.budget.tokens)} tokens` : ""}
        {def.budget.minutes ? ` · ${mins} of ${def.budget.minutes} min` : ""}
      </p>
    );
  }
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Loop guard">
      <label className="lbl flex items-center gap-1 text-[9px]">
        Max rounds
        <input type="number" min={1} max={10} value={def.maxRounds} className="field h-6 w-12 text-[11px]" onChange={(e) => set({ maxRounds: num(e.target.value, 1, 10) })} />
      </label>
      <label className="lbl flex items-center gap-1 text-[9px]">
        Tokens
        <input type="number" min={10} max={50_000} step={50} value={Math.round((def.budget.tokens ?? 0) / 1000)} className="field h-6 w-16 text-[11px]" onChange={(e) => set({ budget: { ...def.budget, tokens: num(e.target.value, 10, 50_000) * 1000 } })} />k
      </label>
      <label className="lbl flex items-center gap-1 text-[9px]">
        Minutes
        <input type="number" min={1} max={1440} value={def.budget.minutes ?? 30} className="field h-6 w-14 text-[11px]" onChange={(e) => set({ budget: { ...def.budget, minutes: num(e.target.value, 1, 1440) } })} />
      </label>
    </div>
  );
}

/** P3: the chain panel. Edit a chain, start it, watch it run; Stop is always there while it runs. A question from the agent comes first: the panel steps behind the agent cards. */
export function ChainPanel({ toast, asking }: { toast?: ReactNode; asking?: boolean }) {
  const open = useChains((s) => s.open);
  const mode = useChains((s) => s.mode);
  const editing = useChains((s) => s.editing);
  const chain = useChains((s) => s.chain);
  const defs = useChains((s) => s.defs);
  const [scope, setScope] = useState<"project" | "personal">("project");
  if (!open) return null;
  const live = !!chain && LIVE.has(chain.state);
  const showing = live || (mode === "run" && chain) ? chain! : null;
  const def = showing?.def ?? editing ?? blankChain();
  const set = (p: Partial<ChainDef>) => useChains.setState({ editing: { ...def, ...p } });
  const st = useChains.getState();

  return (
    <section aria-label="Prompt chain" className={cx("ch-panel rise", asking && "yield")}>
      <header className="flex items-center gap-2">
        <span className="text-[11px] text-violet" aria-hidden>
          ✦
        </span>
        {showing ? (
          <span className="lbl truncate text-[10px] text-ink">{def.name || "Prompt chain"}</span>
        ) : (
          <input aria-label="Chain name" placeholder="Name this chain" value={def.name} onChange={(e) => set({ name: e.target.value })} className="min-w-0 flex-1 bg-transparent font-mono text-[11px] tracking-[0.12em] text-ink uppercase outline-none placeholder:text-faint" />
        )}
        {showing && <span className="flex-1" />}
        {live && (
          <button type="button" className="hud-btn ch-stop h-6 px-2 text-[10px]" onClick={() => void st.stop()}>
            <Square size={8} className="fill-current" /> Stop chain
          </button>
        )}
        <button type="button" className="hud-btn h-6 w-6 justify-center px-0" aria-label="Close the chain panel" onClick={() => st.close()}>
          <X size={11} />
        </button>
      </header>
      {toast}

      {!showing && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select aria-label="Start from a chain" className="upn-when" value="" onChange={(e) => e.target.value && useChains.setState({ editing: { ...defs.find((d) => d.id === e.target.value)!, prompt: def.prompt || defs.find((d) => d.id === e.target.value)!.prompt } })}>
            <option value="">Start from…</option>
            {defs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" className="hud-btn solid h-6 px-2 text-[10px]" title="One click: polish and score again until it reaches the threshold" onClick={() => set(repeatUntil(def, def.threshold || 8))}>
            <Repeat size={9} /> Repeat until score ≥ {def.threshold || 8}
          </button>
        </div>
      )}
      {!showing && (
        <div className="mt-2 flex gap-1" role="radiogroup" aria-label="What decides the branch">
          {CHECKS.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={def.check === id} className={cx("hud-btn h-6 px-2 text-[10px]", def.check === id && "solid")} onClick={() => set({ check: id, ...(id === "critique" ? {} : { loop: false }) })}>
              {label}
            </button>
          ))}
        </div>
      )}

      <ChainThread def={def} run={showing} edit={!showing} set={set} />

      <div className="ch-foot mt-3 border-t border-hair pt-2.5">
        <Guard def={def} run={showing} set={set} />
        {showing && !live && <p className="mt-1.5 text-[12px] text-ink">{showing.why}</p>}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {showing ? (
            !live && (
              <>
                <button type="button" className="btn go" onClick={() => void st.start(showing.def)}>
                  Run again
                </button>
                <button type="button" className="hud-btn h-7 px-2" onClick={() => useChains.setState({ mode: "edit", editing: showing.def })}>
                  Edit
                </button>
              </>
            )
          ) : (
            <>
              <button type="button" className="btn go" onClick={() => void st.start(def)}>
                Start chain
              </button>
              <span className="ml-auto flex items-center gap-1.5">
              <select aria-label="Save it for" className="upn-when" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="project">This project</option>
                <option value="personal">All my projects</option>
              </select>
              <button type="button" className="hud-btn solid h-7 px-2" disabled={!def.name.trim() && !def.prompt.trim()} onClick={() => void st.save(def, scope)}>
                Save as chain
              </button>
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
