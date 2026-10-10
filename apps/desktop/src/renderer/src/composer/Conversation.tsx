import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, GitBranch, X } from "lucide-react";
import type { AgentStep } from "@shrike/schema";
import { useAgent } from "../stores/agent.ts";
import { useWorktrees } from "../stores/worktrees.ts";
import { useProject } from "../stores/project.ts";
import { cx, IconButton } from "../components/ui.tsx";
import { Dot, Elapsed } from "../components/Activity.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { branchTone } from "../hud/Branches.tsx";
import { turns, type Turn } from "./logic.ts";

// Q2: this worktree's conversation. Your words, the agent's answers, the work in between folded away.

const MAX_TURNS = 30;

export function useTurnCount(): number {
  return useAgent((s) => Object.values(s.runs).filter((r) => !r.aside).length);
}

function useTurns(): Turn[] {
  const runs = useAgent((s) => s.runs);
  const current = useAgent((s) => s.run);
  const steps = useAgent((s) => s.steps);
  const runSteps = useAgent((s) => s.runSteps);
  return useMemo(() => {
    const list = Object.values(runs);
    if (current && !runs[current.id]) list.push(current);
    return turns(list, (id) => (id === current?.id ? steps : runSteps[id])).slice(-MAX_TURNS);
  }, [runs, current, steps, runSteps]);
}

function Steps({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="mt-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="hud-btn -ml-2 h-5 px-2 text-[9.5px]">
        <ChevronRight size={10} className={cx("transition-transform", open && "rotate-90")} aria-hidden />
        {steps.length} {steps.length === 1 ? "step" : "steps"}
      </button>
      {open && (
        <ol className="mt-1 ml-1 flex flex-col gap-0.5 border-l border-hair pl-3">
          {steps.map((s) => (
            <li key={s.id} className={cx("truncate font-mono text-[11px]", s.kind === "error" ? "text-fail" : "text-dim")} title={s.text}>
              {s.tool && <span className="mr-1.5 text-faint">{s.tool}</span>}
              {s.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TurnView({ t }: { t: Turn }) {
  const viewing = useAgent((s) => s.viewing);
  const tone = t.branch ? branchTone(t.run) : undefined;
  return (
    <li className="flex flex-col gap-2" aria-label={t.branch ? `Branch ${t.branch.name}` : "Turn"}>
      {t.branch && (
        <p className="micro flex items-center gap-1.5 text-[9.5px]" style={{ color: tone }}>
          <GitBranch size={10} aria-hidden /> Branch · {t.branch.name}
          <button type="button" className="hud-btn h-5 px-1.5 text-[9px]" aria-pressed={viewing === t.run.id} onClick={() => useAgent.getState().view(viewing === t.run.id ? null : t.run.id)}>
            {viewing === t.run.id ? "Back to main" : "Show"}
          </button>
        </p>
      )}
      <div className="ml-auto max-w-[78%] rounded-[12px] rounded-br-[4px] border border-hair bg-glass px-3 py-2" style={tone ? { borderColor: `color-mix(in srgb, ${tone} 50%, transparent)` } : undefined}>
        <p className="micro mb-1 text-[9px] text-faint">You</p>
        <p className="selectable m-0 text-[13px] whitespace-pre-wrap text-ink">{t.prompt || "Look at this"}</p>
        {t.context.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {t.context.map((c) => (
              <span key={c} className="max-w-full truncate rounded-[5px] border border-violet/30 bg-violet/10 px-1.5 py-px font-mono text-[10.5px] text-dim">
                {c}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="max-w-[86%] border-l-2 pl-3" style={{ borderColor: tone ?? "var(--violet)" }}>
        <p className="micro mb-1 flex items-center gap-1.5 text-[9px] text-violet">
          ✦ Agent
          {t.state === "working" && (
            <span className="inline-flex items-center gap-1 text-dim">
              <Dot on /> working · <Elapsed />
            </span>
          )}
          {t.state === "failed" && <span className="text-fail">· didn't finish</span>}
          {t.state === "stopped" && <span className="text-faint">· stopped</span>}
        </p>
        {t.answer ? <div className="selectable conv-md text-[13px] text-ink"><Markdown text={t.answer} path="" /></div> : <p className="m-0 text-[12.5px] text-dim">{t.state === "working" ? "On it…" : "No answer recorded."}</p>}
        <Steps steps={t.steps} />
      </div>
    </li>
  );
}

/** Opens above the composer. Loads older runs' steps when shown. */
export function Conversation({ onClose }: { onClose(): void }) {
  const list = useTurns();
  const tree = useWorktrees((s) => s.list?.find((w) => w.current)?.name);
  const project = useProject((s) => s.project?.name);
  const box = useRef<HTMLDivElement>(null);
  const ids = list.map((t) => t.run.id).join(",");

  useEffect(() => void useAgent.getState().loadRuns(), []);
  useEffect(() => {
    for (const t of list) useAgent.getState().loadSteps(t.run.id);
  }, [ids]);
  useLayoutEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [ids, list.at(-1)?.answer]);

  return (
    <section aria-label="Conversation" className="glass solid rise mx-auto flex max-h-[min(520px,56vh)] w-[min(820px,100%)] flex-col rounded-[var(--r-card)] shadow-[0_24px_60px_-20px_var(--shade)]">
      <header className="flex items-center gap-2 border-b border-hair py-2 pr-1.5 pl-4">
        <span className="lbl text-ink">Conversation</span>
        <span className="micro text-[9.5px] text-faint">
          {tree ?? project} · {list.length} {list.length === 1 ? "ask" : "asks"}
        </span>
        <span className="flex-1" />
        <IconButton label="Close conversation" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </header>
      <div ref={box} className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {list.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-dim">Nothing said yet. Type below to ask your agent about your app.</p>
        ) : (
          <ol className="flex flex-col gap-5">
            {list.map((t) => (
              <TurnView key={t.run.id} t={t} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
