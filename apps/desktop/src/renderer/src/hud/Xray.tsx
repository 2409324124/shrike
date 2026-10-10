import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { BookOpen, Brain, ChevronRight, Eye, Flame, PenLine, Search, X } from "lucide-react";
import type { AgentStep, ContextMap, ContextSegment } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";
import { api } from "../lib/api.ts";
import { useAgent } from "../stores/agent.ts";
import { useUi } from "../stores/ui.ts";
import { cx, IconButton } from "../components/ui.tsx";
import { Dot } from "../components/Activity.tsx";
import { activeSkill, activityOf, fileTouches, fmtCost, fmtMs, fmtTokens, latestThinking, mcpCall, mcpTimings, mcpUsage, rangeText, turnTokens, type FileTouch, type Turn } from "./xray.ts";
import { Glyph } from "../mcp/ToolsPanel.tsx"; // MCP6
import { useMcp } from "../mcp/store.ts";

// X-ray: what the agent is doing, touching, thinking and spending. Each piece takes the run's steps, so any surface can mount it.

/** X1: the live action in plain words with its target. */
export function ActivityLine({ steps, running, quiet, className }: { steps: AgentStep[]; running: boolean; quiet?: boolean; className?: string }) {
  const text = activityOf(steps);
  if (!text) return null;
  return (
    <p {...(quiet ? {} : { role: "status", "aria-live": "polite" as const })} className={cx("xr-activity m-0 flex min-w-0 items-center gap-2 text-[12.5px]", running ? "text-ink" : "text-dim", className)}>
      <Dot on={running} />
      <span className="truncate" title={text}>
        {text}
      </span>
    </p>
  );
}

const ICON = { read: Eye, search: Search, edit: PenLine } as const;
const VERB = { read: "Read", search: "Searched", edit: "Proposed a change to" } as const;
const PART = { read: "read", search: "searched", edit: "proposed a change" } as const;

/** X2: one chip per file the run touched: icon for read / searched / changed, a count, line ranges on hover; click opens the file view there. */
export function FileChips({ steps, max = 6, className }: { steps: AgentStep[]; max?: number; className?: string }) {
  const touches = useMemo(() => fileTouches(steps), [steps]);
  const [all, setAll] = useState(false);
  if (!touches.length) return null;
  const shown = all ? touches : touches.slice(0, max);
  return (
    <ul aria-label="Files your agent touched" className={cx("xr-files m-0 flex list-none flex-wrap gap-1.5 p-0", className)}>
      {shown.map((t) => (
        <li key={t.path}>
          <FileChip t={t} />
        </li>
      ))}
      {touches.length > shown.length && (
        <li>
          <button type="button" className="h-6 rounded-md px-1.5 font-mono text-[10.5px] text-dim hover:text-ink" onClick={() => setAll(true)}>
            +{touches.length - shown.length} more
          </button>
        </li>
      )}
    </ul>
  );
}

function FileChip({ t }: { t: FileTouch }) {
  const Icon = ICON[t.action];
  const name = t.path.split("/").pop() || t.path;
  const verb = t.action === "edit" && t.applied ? "Changed" : VERB[t.action];
  const where = (a: keyof typeof PART) => {
    const r = t.by[a]?.ranges ?? [];
    return r.length ? ` (${r.slice(0, 3).map(rangeText).join(", ")}${r.length > 3 ? ", …" : ""})` : "";
  };
  const acts = (["read", "search", "edit"] as const).filter((a) => t.by[a]);
  const hint =
    acts.length > 1
      ? `${verb} ${t.path}: ${acts.map((a) => `${a === "edit" && t.applied ? "changed" : PART[a]} ${t.by[a]!.count === 1 ? "once" : `${t.by[a]!.count} times`}${where(a)}`).join(", ")}`
      : `${verb} ${t.path}${where(t.action)}${t.count > 1 ? `, ${t.count} times` : ""}`;
  const tone = t.action === "edit" ? color.magenta : t.action === "read" ? color.violet : color.inkDim;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`${hint}. Open it`}
        onClick={() => useUi.getState().openFile({ path: t.path, line: (t.by.edit ?? t.by.read ?? t.by.search)?.ranges[0]?.[0] ?? t.ranges[0]?.[0] ?? 1 })}
        className="xr-file inline-flex h-6 max-w-[200px] items-center gap-1.5 rounded-md border border-hair px-1.5 font-mono text-[11px] text-dim hover:border-[var(--glass-edge)] hover:text-ink"
      >
        <Icon size={11} aria-hidden style={{ color: tone, flexShrink: 0 }} />
        <span className="truncate">{name}</span>
        {t.count > 1 && <span className="text-faint">×{t.count}</span>}
      </button>
      <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-30 hidden w-max max-w-[280px] rounded-md border border-hair bg-abyss px-2 py-1 text-[11.5px] leading-snug text-ink group-focus-within:block group-hover:block">
        {hint}
      </span>
    </span>
  );
}

/** X3: the agent's latest reasoning, one dim line until you open it. */
export function ThinkingStrip({ steps, className }: { steps: AgentStep[]; className?: string }) {
  const text = useMemo(() => latestThinking(steps), [steps]);
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const line = text.replace(/\s+/g, " ");
  return (
    <div className={cx("xr-thinking min-w-0", className)}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-center gap-1.5 text-left text-[12px] text-dim hover:text-ink">
        <ChevronRight size={11} aria-hidden className={cx("shrink-0 transition-transform", open && "rotate-90")} />
        <Brain size={11} aria-hidden className="shrink-0" />
        <span className="micro shrink-0 text-[9.5px]">Thinking</span>
        {!open && <span className="truncate opacity-80">{line}</span>}
      </button>
      {open && <p className="m-0 mt-1 max-h-48 overflow-auto pl-[30px] text-[12px] leading-relaxed whitespace-pre-wrap text-dim">{text}</p>}
    </div>
  );
}

/** X4: the loaded skill, lit, with why on hover when the agent said so. */
export function SkillChip({ steps, className }: { steps: AgentStep[]; className?: string }) {
  const skill = useMemo(() => activeSkill(steps), [steps]);
  const name = useAgent((s) => (skill ? s.skills.find((k) => k.id === skill.id)?.name : undefined));
  if (!skill) return null;
  const label = name ?? skill.id.replace(/-/g, " ");
  return (
    <span className={cx("xr-skill group relative inline-flex", className)}>
      <span
        tabIndex={skill.why ? 0 : undefined}
        aria-label={`Using the ${label} skill${skill.why ? `. Why: ${skill.why}` : ""}`}
        className="inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[11.5px] text-ink"
        style={{ border: `1px solid color-mix(in srgb, ${color.violet} 70%, transparent)`, background: `color-mix(in srgb, ${color.violet} 14%, transparent)`, boxShadow: `0 0 10px color-mix(in srgb, ${color.violet} 30%, transparent)` }}
      >
        <BookOpen size={11} aria-hidden style={{ color: color.violet }} />
        {label}
      </span>
      {skill.why && (
        <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-30 hidden w-max max-w-[280px] rounded-md border border-hair bg-abyss px-2 py-1 text-[11.5px] leading-snug text-ink group-focus-within:block group-hover:block">
          Why this skill: {skill.why}
        </span>
      )}
    </span>
  );
}

const usageWords = (t: Omit<Turn, "stepId">) => `${fmtTokens(t.input + t.cacheWrite)} in · ${fmtTokens(t.output)} out${t.cacheRead ? ` · ${fmtTokens(t.cacheRead)} cached` : ""}`;
const usageTitle = (t: Omit<Turn, "stepId">) => `${t.input} new input, ${t.cacheWrite} written to cache, ${t.cacheRead} read from cache, ${t.output} output tokens`;

/** X6: tokens and cost. With `stepId`: that agent turn (marked when it's the run's most expensive). Without: the run total. */
export function TokensBadge({ steps, stepId, className }: { steps: AgentStep[]; stepId?: string; className?: string }) {
  const { turns, total, costliest } = useMemo(() => turnTokens(steps), [steps]);
  if (!stepId) {
    if (!turns.length) return null;
    return (
      <p className={cx("xr-tokens m-0 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-faint", className)} title={usageTitle(total)}>
        <span>This run</span>
        <span className="whitespace-nowrap text-dim">{usageWords(total)}</span>
        {total.costUsd != null && <span className="text-ink">{fmtCost(total.costUsd)}</span>}
      </p>
    );
  }
  const t = turns.find((x) => x.stepId === stepId);
  if (!t) return null;
  const top = costliest === stepId;
  return (
    <span className={cx("xr-tokens inline-flex items-center gap-1 font-mono text-[10.5px] whitespace-nowrap", top ? "text-ink" : "text-faint", className)} title={`${usageTitle(t)}${t.costUsd != null ? `, about ${fmtCost(t.costUsd)} (the run's cost shared by tokens)` : ""}${top ? ". The most expensive step in this run" : ""}`}>
      {top && <Flame size={10} aria-label="Most expensive step" style={{ color: color.slow }} />}
      {usageWords(t)}
      {t.costUsd != null && <span>· ~{fmtCost(t.costUsd)}</span>}
    </span>
  );
}

// ---- MCP6: the user's own MCP servers in the X-ray ----

const useGlyphs = () => useMcp((s) => s.state?.servers);
const glyphOf = (servers: ReturnType<typeof useGlyphs>, name: string) => servers?.find((x) => x.name === name)?.glyph ?? "plug";

/** "Tools used this run": one chip per server, with calls and time; the tools it called on hover. */
export function ToolsUsed({ steps, className }: { steps: AgentStep[]; className?: string }) {
  const used = useMemo(() => mcpUsage(steps), [steps]);
  const servers = useGlyphs();
  if (!used.length) return null;
  return (
    <ul aria-label="Tools used this run" className={cx("m-0 flex list-none flex-wrap items-center gap-1.5 p-0", className)}>
      {used.map((u) => {
        const hint = `${u.server}: ${u.tools.join(", ")}. ${u.calls} call${u.calls === 1 ? "" : "s"}, ${fmtMs(u.ms)}${u.failed ? `, ${u.failed} failed` : ""}`;
        return (
          <li key={u.server} className="group relative">
            <span className="mc-used" tabIndex={0} aria-label={hint}>
              <span style={{ color: color.teal }}>
                <Glyph name={glyphOf(servers, u.server)} size={11} />
              </span>
              {u.server}
              <span className="text-faint">
                ×{u.calls} · {fmtMs(u.ms)}
              </span>
              {u.failed > 0 && <i aria-hidden className="size-[5px] rounded-full" style={{ background: color.fail }} />}
            </span>
            <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+4px)] left-0 z-30 hidden w-max max-w-[280px] rounded-md border border-hair bg-abyss px-2 py-1 text-[11.5px] leading-snug text-ink group-focus-within:block group-hover:block">
              {hint}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** On a step row: the server's glyph and how long the call took. */
export function McpMark({ steps, step }: { steps: AgentStep[]; step: AgentStep }) {
  const c = step.kind === "tool_call" ? mcpCall(step.tool) : undefined;
  const timing = useMemo(() => (c ? mcpTimings(steps).get(step.id) : undefined), [steps, step.id, c]);
  const servers = useGlyphs();
  if (!c) return null;
  return (
    <span className="mc-mark" title={`${c.server} · ${c.tool}${timing?.ms != null ? ` · ${fmtMs(timing.ms)}` : ""}`}>
      <Glyph name={glyphOf(servers, c.server)} size={10} />
      {timing?.ms != null && <span className="text-faint">{fmtMs(timing.ms)}</span>}
    </span>
  );
}

// ---- X5: context map, opened from the fuel ring ----

export const useContextMapUi = create<{ open: boolean }>(() => ({ open: false }));
export const toggleContextMap = (open?: boolean) => useContextMapUi.setState((s) => ({ open: open ?? !s.open }));

/** The run's context map, live. */
export function useContextMap(runId: string | undefined): ContextMap | null {
  const [map, setMap] = useState<ContextMap | null>(null);
  useEffect(() => {
    setMap(null);
    if (!runId) return;
    let live = true;
    void api().getContextMap(runId).then((m) => live && m && setMap(m), () => {});
    const off = api().on("agent:context", (m) => m?.runId === runId && setMap(m));
    return () => ((live = false), off());
  }, [runId]);
  return map;
}

const KIND: Record<ContextSegment["kind"], { tone: string; word: string }> = {
  instructions: { tone: color.inkFaint, word: "Instructions" },
  tools: { tone: color.inkFaint, word: "Tools" },
  skill: { tone: color.violet, word: "Skill" },
  memory: { tone: color.magenta, word: "Memory" },
  question: { tone: color.cyan, word: "You" },
  context: { tone: color.teal, word: "Context" },
  file: { tone: color.blue, word: "Code" },
  tool_result: { tone: `color-mix(in srgb, ${color.blue} 45%, ${color.teal})`, word: "Tool" },
  agent: { tone: `color-mix(in srgb, ${color.violet} 45%, ${color.ink})`, word: "Agent" },
};

/** X5: a stacked bar of what fills the agent's context, and a list of tokens per segment with the step that added it. Hidden until opened (toggleContextMap). */
export function ContextMapPanel({ runId, steps = [], forceOpen, className }: { runId: string | undefined; steps?: AgentStep[]; forceOpen?: boolean; className?: string }) {
  const open = useContextMapUi((s) => s.open) || !!forceOpen;
  const map = useContextMap(open ? runId : undefined);
  const run = useAgent((s) => (runId ? s.runs[runId] : undefined));
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!open || forceOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && toggleContextMap(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, forceOpen]);
  if (!open) return null;
  const stepNo = (id?: string) => {
    const i = id ? steps.findIndex((s) => s.id === id) : -1;
    return i >= 0 ? `step ${i + 1}` : undefined;
  };
  const segs = map?.segments ?? [];
  const sorted = [...segs].sort((a, b) => b.tokens - a.tokens);
  const list = all ? sorted : sorted.slice(0, 6);
  const total = map?.totalTokens ?? 0;
  return (
    <section aria-label="What fills your agent's context" className={cx("xr-context glass solid rounded-[var(--r-card)] p-3", className)}>
      <div className="flex items-center gap-2">
        <span className="lbl text-ink">Context</span>
        {map && (
          <span className="micro text-[9.5px] text-faint">
            {fmtTokens(total)}
            {map.limit ? ` of ${fmtTokens(map.limit)} used (${Math.max(1, Math.round((total / map.limit) * 100))}%)` : " used"}
          </span>
        )}
        <div className="flex-1" />
        {!forceOpen && (
          <IconButton label="Close" onClick={() => toggleContextMap(false)}>
            <X size={12} />
          </IconButton>
        )}
      </div>
      {!map || !total ? (
        <p className="m-0 mt-2 text-[12px] text-dim">{run?.brain === "builtin" ? "This brain doesn't report its context yet." : run && run.status !== "running" ? "This run didn't report its context." : "Nothing yet. It fills in after your agent's first reply."}</p>
      ) : (
        <>
          <div role="img" aria-label={sorted.map((s) => `${s.label} ${s.estimated ? "about " : ""}${fmtTokens(s.tokens)}`).join(", ")} className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-[var(--hair)]">
            {segs.map((s, i) => (
              <i key={`${s.kind}:${s.label}`} title={`${s.label}: ${s.estimated ? "about " : ""}${fmtTokens(s.tokens)}`} style={{ width: `${(s.tokens / total) * 100}%`, background: KIND[s.kind].tone, marginLeft: i ? 1 : 0 }} />
            ))}
          </div>
          <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 p-0">
            {list.map((s) => (
              <li key={`${s.kind}:${s.label}`} className="flex min-w-0 items-center gap-2 text-[12px]">
                <i aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: KIND[s.kind].tone }} />
                <span className="w-[78px] shrink-0 font-mono text-[10.5px] text-faint">{KIND[s.kind].word}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={s.label}>
                  {s.label}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-dim">
                  {s.estimated ? "about " : ""}
                  {fmtTokens(s.tokens)}
                </span>
                <span className="w-[50px] shrink-0 text-right font-mono text-[10.5px] text-faint">{stepNo(s.stepId) ?? ""}</span>
              </li>
            ))}
          </ul>
          {sorted.length > list.length && (
            <button type="button" className="mt-1.5 text-[11.5px] text-dim hover:text-ink" onClick={() => setAll(true)}>
              Show {sorted.length - list.length} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---- X7: race candidates' steps (main sends them on "race:step") ----

const MAX_RACE_STEPS = 400;
export const useRaceSteps = create<{ byRun: Record<string, AgentStep[]> }>(() => ({ byRun: {} }));
const NONE: AgentStep[] = [];
export const useRunSteps = (runId: string | undefined) => useRaceSteps((s) => (runId ? (s.byRun[runId] ?? NONE) : NONE));

/** Subscribe once (RaceView does). */
export function connectRaceSteps(): () => void {
  return api().on("race:step", (step) => {
    if (!step?.runId) return;
    useRaceSteps.setState((s) => ({ byRun: { ...s.byRun, [step.runId]: [...(s.byRun[step.runId] ?? NONE).filter((x) => x.id !== step.id), step].slice(-MAX_RACE_STEPS) } }));
  });
}
