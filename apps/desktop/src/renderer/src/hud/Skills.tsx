import { useEffect, useMemo, useRef, useState } from "react";
import { Check, History, ListChecks, Pencil, Play, Search, X } from "lucide-react";
import type { Skill, SkillProposal } from "@shrike/schema";
import { lineDiff } from "../lib/hud.ts";
import { cx, IconButton, Kbd } from "../components/ui.tsx";
import { useAgent } from "../stores/agent.ts";
import { checklist, filterSkills, improvedAgo, sourceLabel, useSkills, useSkillsBridge } from "../stores/skills.ts";
import { ProficiencyBar, RankBadge, SkillLog, SystemLayer } from "../system/System.tsx";
import { rankOf } from "../system/ranks.ts";
import { Recipes } from "../recipes/Recipes.tsx";
import { useRecipes } from "../recipes/store.ts";
import { Glyph } from "../mcp/ToolsPanel.tsx"; // mcp: MCP7
import { useMcp } from "../mcp/store.ts";

// S1 shelf, S2 Claude offer, S3 checklist, S4 "Learned something" card.
// Shell finds these by export name (hud/Sdlc.tsx): SkillShelf is the K panel, SkillsOverlay sits over the Thread.

export function SkillsOverlay() {
  useSkillsBridge();
  return (
    <>
      <SkillChecklist />
      <SkillProposalCard />
      <SystemLayer />
    </>
  );
}

const SOURCES = [
  { id: "all", word: "All" },
  { id: "project", word: "This project" },
  { id: "shrike", word: "Shrike" },
  { id: "claude", word: "From Claude Code" },
] as const;
type SourceId = (typeof SOURCES)[number]["id"];
const inSource = (s: Skill, f: SourceId) => f === "all" || (f === "shrike" ? s.source !== "project" && s.source !== "claude" : s.source === f);

/** S1: a summoned sheet (K). Your own skills first (this project, yours, Claude Code's), Shrike's built-in ones last. Esc closes (commands.ts). */
export function SkillShelf({ open, onClose }: { open: boolean; onClose(): void }) {
  const list = useSkills((s) => s.list);
  const offer = useSkills((s) => s.offer);
  const query = useSkills((s) => s.query);
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<SourceId>("all");
  const [history, setHistory] = useState<string | true | null>(null); // SL6: true = every skill, an id = that skill
  const recipes = useRecipes((s) => s.open); // S8
  const shown = useMemo(() => filterSkills(list, query).filter((s) => inSource(s, source)), [list, query, source]);
  const own = shown.filter((s) => s.source === "project" || s.source === "personal");
  const claude = shown.filter((s) => s.source === "claude");
  const builtin = shown.filter((s) => !s.source || s.source === "builtin");

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    void useSkills.getState().load();
    return () => (useSkills.setState({ query: "" }), setHistory(null), useRecipes.setState({ open: false }));
  }, [open]);

  if (!open) return null;
  const first = [...own, ...claude, ...builtin][0];
  return (
    <section aria-label="Skills" className="glass solid @container sheet-in absolute inset-x-2 bottom-0 z-30 flex h-[52%] min-h-[280px] flex-col rounded-t-[var(--r-card)] border-b-0 shadow-[0_-20px_60px_var(--void)]">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 py-1.5 pr-2 pl-4">
        <span className="lbl text-ink">Skills</span>
        <Kbd>K</Kbd>
        <label className="ml-3 flex h-7 max-w-[320px] min-w-0 flex-1 items-center gap-2 rounded-md border border-hair px-2 focus-within:border-[color-mix(in_srgb,var(--signal)_50%,transparent)]">
          <Search size={12} className="text-faint" aria-hidden />
          <input
            ref={input}
            aria-label="Find a skill"
            value={query}
            placeholder="Find a skill"
            onChange={(e) => useSkills.setState({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && first && void useSkills.getState().run(first)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2.5 @max-4xl:order-last @max-4xl:basis-full">
        <span role="radiogroup" aria-label="Where the skills come from" className="inline-flex h-7 max-w-full items-center overflow-x-auto rounded-[8px] border border-hair">
          {SOURCES.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={source === f.id}
              onClick={() => setSource(f.id)}
              className={cx("micro h-full shrink-0 px-2 text-[9.5px] whitespace-nowrap", source === f.id ? "bg-glass text-ink" : "text-dim hover:text-ink")}
            >
              {f.word}
            </button>
          ))}
        </span>
        <button type="button" className={cx("hud-btn", history && "text-signal")} aria-pressed={!!history} onClick={() => (setHistory(history ? null : true), useRecipes.setState({ open: false }))}>
          <History size={10} />
          History
        </button>
        <button type="button" className={cx("hud-btn", recipes && "text-signal")} aria-pressed={recipes} title="What Shrike tells your agent for each action" onClick={() => (useRecipes.setState({ open: !recipes }), setHistory(null))}>
          <ListChecks size={10} />
          Recipes
        </button>
        </div>
        <div className="flex-1" />
        <span className="micro hidden text-[9.5px] whitespace-nowrap text-faint @6xl:inline">Enter runs the first · Esc closes</span>
        <IconButton label="Close skills" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {recipes ? (
          <Recipes />
        ) : history ? (
          <SkillLog skillId={history === true ? undefined : history} onAll={() => setHistory(true)} />
        ) : (
          <>
            {offer != null && <ClaudeOffer count={offer} />}
            {own.length > 0 && <Cards list={own} onHistory={setHistory} />}
            {claude.length > 0 && (
              <>
                <h4 className={cx("micro mb-2 text-faint", own.length > 0 && "mt-4")}>From Claude Code · Shrike only reads these</h4>
                <Cards list={claude} onHistory={setHistory} />
              </>
            )}
            {builtin.length > 0 && (
              <>
                {(own.length > 0 || claude.length > 0) && <h4 className="micro mt-4 mb-2 text-faint">Built into Shrike</h4>}
                <Cards list={builtin} onHistory={setHistory} />
              </>
            )}
            {!shown.length && <p className="pt-6 text-center text-[12.5px] text-dim">{query ? `No skill matches "${query}".` : "No skills yet. Save one after a fix that worked."}</p>}
          </>
        )}
      </div>
    </section>
  );
}

/** S2: asked once, in plain words. */
function ClaudeOffer({ count }: { count: number }) {
  return (
    <div role="group" aria-label="Use your Claude Code skills" className="mb-3 flex flex-wrap items-center gap-3 rounded-[10px] border border-[color-mix(in_srgb,var(--violet)_40%,transparent)] px-3 py-2.5">
      <span className="text-violet" aria-hidden>
        ✦
      </span>
      <p className="m-0 min-w-0 flex-1 basis-56 text-[13px] leading-snug text-ink">
        You have {count} Claude Code skill{count === 1 ? "" : "s"}. Use them in Shrike?
        <span className="block text-[11.5px] text-dim">Shrike only reads them. When one improves, it keeps its own copy.</span>
      </p>
      <button type="button" className="btn go" onClick={() => void useSkills.getState().importClaude(true)}>
        Use them
      </button>
      <button type="button" className="btn" onClick={() => void useSkills.getState().importClaude(false)}>
        Not now
      </button>
    </div>
  );
}

function Cards({ list, onHistory }: { list: Skill[]; onHistory(id: string): void }) {
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5 p-0">
      {list.map((s) => (
        <SkillCard key={s.id} s={s} onHistory={() => onHistory(s.id)} />
      ))}
    </ul>
  );
}

function SkillCard({ s, onHistory }: { s: Skill; onHistory(): void }) {
  const r = rankOf(s.version, s.proficiency);
  const meta = [
    s.uses ? `Used ${s.uses} time${s.uses === 1 ? "" : "s"}` : "Not used yet",
    s.improvedAt ? `improved ${improvedAgo(s.improvedAt)}${s.version ? ` · v${s.version}` : ""}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-skill={s.id} className={cx("group flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-hair bg-[color-mix(in_srgb,var(--void)_35%,transparent)] px-3 py-2.5 transition-colors hover:border-[var(--glass-edge)]", r.rank === "S" && "skill-s")}>
      <div className="flex items-center gap-2">
        <RankBadge rank={r.rank} small className="shrink-0" />
        <b className="truncate font-mono text-[12px] font-medium text-ink" title={s.name}>{s.name}</b>
        <span className="shrink-0 font-mono text-[9.5px] text-dim">Lv.{r.level}</span>
        <span className="flex-1" />
        <span className="lbl shrink-0 text-[8.5px] text-faint">{sourceLabel(s)}</span>
      </div>
      <p className="m-0 line-clamp-2 text-[12px] leading-snug text-dim" title={s.when}>
        {s.when}
      </p>
      {s.usesMcp?.length ? <UsesTools names={s.usesMcp} /> : null}
      <div className="flex items-center gap-2" title={r.nextRank ? `Proficiency ${r.proficiency}. Rank ${r.nextRank} at ${r.nextRankAt}.` : "Top rank"}>
        <ProficiencyBar level={r.level} proficiency={r.proficiency} className="flex-1" />
        <span className="shrink-0 font-mono text-[9px] text-faint">{r.nextRank ? `${r.proficiency}/${r.nextRankAt} → ${r.nextRank}` : "Rank S"}</span>
      </div>
      <div className="mt-auto flex items-center gap-1.5 pt-1">
        <span className="lbl min-w-0 flex-1 text-[8.5px] leading-[1.5] text-faint">{meta}</span>
        <button type="button" className="hud-btn px-1.5" aria-label={`${s.name} history`} title="History" onClick={onHistory}>
          <History size={10} />
        </button>
        <button type="button" className="hud-btn px-1.5" aria-label={`Edit ${s.name}`} title={s.source === "project" ? "Edit it here" : "Edit a copy in this project"} onClick={() => void useSkills.getState().edit(s)}>
          <Pencil size={10} />
        </button>
        <button type="button" className="hud-btn solid" onClick={() => void useSkills.getState().run(s)}>
          <Play size={9} className="fill-current" />
          Run
        </button>
      </div>
    </li>
  );
}

/** MCP7: the tool servers a skill uses; dim when this project doesn't have one ready. */
function UsesTools({ names }: { names: string[] }) {
  const servers = useMcp((m) => m.state?.servers);
  return (
    <ul aria-label="Tools it uses" className="m-0 flex list-none flex-wrap gap-1 p-0">
      {names.map((n) => {
        const s = servers?.find((x) => x.name === n);
        const ready = !!s && s.enabled && s.trusted && !s.missing.length;
        return (
          <li key={n} className={cx("mc-used h-5 px-1.5 text-[10px]", !ready && "opacity-50")} title={ready ? `Uses ${n}` : `Uses ${n}, which isn't ready here. Running it offers to add it`}>
            <Glyph name={s?.glyph ?? useMcp.getState().state?.catalog.find((c) => c.id === n)?.glyph ?? "plug"} size={10} />
            {n}
          </li>
        );
      })}
    </ul>
  );
}

const WINDOW = 5; // items shown around the current one

/** S3: the running skill's steps over the caption, ticked as the agent works. Fades a few seconds after the run ends. */
export function SkillChecklist() {
  const active = useSkills((s) => s.active);
  const run = useAgent((s) => s.run);
  const steps = useAgent((s) => s.steps);
  const mine = !!active && run?.id === active.runId;
  const states = useMemo(() => (mine && active ? checklist(active.items, steps, run?.status) : []), [mine, active, steps, run?.status]);
  const ended = mine && run?.status !== "running";

  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => useSkills.setState({ active: null }), 8000);
    return () => clearTimeout(t);
  }, [ended]);

  if (!mine || !active) return null;
  const cur = Math.max(0, states.findIndex((s) => s === "active" || s === "failed"));
  const from = Math.max(0, Math.min(cur - 2, active.items.length - WINDOW));
  const done = states.filter((s) => s === "done").length;
  return (
    <aside
      aria-label={`${active.name} steps`}
      className="pointer-events-none! fade-in absolute bottom-[70px] left-[12px] z-[8] w-[min(420px,56%)] rounded-[10px] px-3 py-2"
      style={{ background: "color-mix(in srgb, var(--void) 88%, transparent)", backdropFilter: "blur(6px)" }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] text-violet" aria-hidden>
          ✦
        </span>
        <span className="lbl truncate text-[9.5px] text-violet">{active.name}</span>
        <span className="lbl text-[9px] text-faint">
          {done}/{active.items.length}
        </span>
      </div>
      <ol aria-live="polite" className="m-0 flex list-none flex-col gap-1 border-l border-[color-mix(in_srgb,var(--violet)_40%,transparent)] p-0 pl-2.5">
        {active.items.slice(from, from + WINDOW).map((t, j) => {
          const st = states[from + j]!;
          return (
            <li key={from + j} title={t} className={cx("flex min-w-0 items-baseline gap-2 text-[12.5px] leading-snug", st === "active" ? "text-ink" : st === "failed" ? "text-fail" : st === "done" ? "text-dim" : "text-faint")}>
              <span aria-hidden className="w-3 shrink-0 text-center text-[10px]">
                {st === "done" ? <Check size={10} className="inline text-violet" /> : st === "failed" ? "✕" : st === "active" ? <span className="inline-block size-[6px] rounded-full bg-[var(--violet)] shadow-[0_0_8px_var(--violet)]" /> : "·"}
              </span>
              <span className="sr-only">{st === "done" ? "Done:" : st === "failed" ? "Stopped at:" : st === "active" ? "Now:" : "Next:"}</span>
              <span className="truncate">{t}</span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/** S4: "Learned something": the change as a diff, Keep or Discard. One at a time. */
export function SkillProposalCard() {
  const p = useSkills((s) => s.proposals[0]);
  const skill = useSkills((s) => (p ? s.list.find((k) => k.id === p.skillId) : undefined));
  if (!p) return null;
  return (
    <section aria-label="Learned something" className="agentcard absolute right-4 bottom-[64px] z-20 w-[min(420px,calc(100%-32px))]">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-violet">✦</span>
        <b className="font-semibold">Learned something</b>
        <span className="flex-1" />
        <span className="lbl truncate">{skill?.name ?? p.skillId}</span>
      </div>
      <p className="m-0 mb-2.5 text-[13.5px] leading-snug text-ink">{p.reason.replace(/^learned( something)?:\s*/i, "").replace(/^./, (c) => c.toUpperCase())}</p>
      <ProposalDiff p={p} />
      {skill?.source === "claude" && skill.readOnly !== false && <p className="m-0 mb-2.5 text-[11.5px] text-dim">Your Claude Code file stays as it is. Shrike keeps the better version as its own copy.</p>}
      <div className="flex gap-2">
        <button type="button" className="btn go" onClick={() => void useSkills.getState().answer(p.id, true)}>
          Keep this improvement
        </button>
        <button type="button" className="btn" onClick={() => void useSkills.getState().answer(p.id, false)}>
          Discard
        </button>
      </div>
    </section>
  );
}

const unnumber = (md: string) => md.replace(/^(\s*)\d+[.)]\s+/gm, "$1");

function ProposalDiff({ p }: { p: SkillProposal }) {
  // step numbers left out, so adding a step 1 reads as one added line, not every step renumbered
  const lines = useMemo(() => lineDiff(unnumber(p.before), unnumber(p.after), 1), [p.before, p.after]);
  const [all, setAll] = useState(false);
  const max = all ? lines.length : 8;
  return (
    <>
      <div className="diff selectable mb-2.5 max-h-[220px] overflow-y-auto">
        {lines.slice(0, max).map((l, i) => (
          <div key={i} className={l.kind === "del" ? "d" : l.kind === "add" ? "a" : "c"}>
            <span className="m" aria-hidden>
              {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
            </span>
            {l.text || " "}
          </div>
        ))}
      </div>
      {lines.length > max && (
        <button type="button" className="hud-btn mb-2 -mt-1" onClick={() => setAll(true)}>
          Show all {lines.length} lines
        </button>
      )}
    </>
  );
}
