import "./system.css";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { SkillEvent, SkillRank, StartReward, StartStep } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { cx } from "../components/ui.tsx";
import { improvedAgo, useSkills } from "../stores/skills.ts";
import { useThread } from "../stores/thread.ts";
import { keyOf, LEAVE_MS, SHOW_MS } from "./queue.ts";
import { RANK_COLOR, rankOf } from "./ranks.ts";
import { chime } from "./sound.ts";
import { asSkillEvent, useSystem } from "./store.ts";
import { ProgressLayer } from "../progress/ResultScreen.tsx";
import { useQuests } from "../quests/store.ts";
import { liveSession, useOptions } from "../options/store.ts";

// SL1 [Skill Acquired], SL2 [Level Up] (with Undo), SL3 Used toast, Not learned line, SL5 QuestWindow, SL6 SkillLog with drafts. SystemLayer mounts once (SkillsOverlay).

/** Calm: reduced motion, or auto-dive turned off. No draw-in, no scan line, no sound. */
export function useCalm(): boolean {
  const autoDive = useThread((s) => s.autoDive);
  const [reduce, setReduce] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduce || !autoDive;
}

function useSystemBridge(): void {
  useEffect(() => {
    const a = api();
    const off = a.on("skill:event", (p) => {
      const e = asSkillEvent(p);
      if (e) useSystem.getState().push(e);
      if (e && (e.kind === "leveled" || e.kind === "not_learned")) void useSystem.getState().loadDrafts();
    });
    void Promise.resolve()
      .then(() => a.getSkillLog())
      .then((log) => Array.isArray(log) && useSystem.getState().addLog(log.map(asSkillEvent).filter((e) => e !== null)), () => {});
    return off;
  }, []);
}

/** A use that crossed a rank line gets the big window. */
export const rankedUp = (e: SkillEvent): boolean => e.kind === "used" && e.proficiency > 0 && rankOf(e.level, e.proficiency - 1).rank !== e.rank;

/** The one System window on screen: queued, auto-dismissed, never modal. Hover holds it; a click sends it away. */
export function SystemLayer() {
  useSystemBridge();
  return (
    <>
      <SystemWindows />
      <ProgressLayer />
    </>
  );
}

function SystemWindows() {
  const current = useSystem((s) => s.current);
  const sound = useSystem((s) => s.sound);
  const calm = useCalm();
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  const key = current ? keyOf(current) : "";
  // The quest and options boards own the stage: a window waits for them to close instead of landing on top (quest complete is theirs).
  const questBoard = useQuests((s) => s.open);
  const optionsBoard = useOptions((s) => !!liveSession(s) || !!s.compare);
  const wait = (questBoard || optionsBoard) && current?.kind !== "quest_complete";

  useEffect(() => {
    if (current && sound && !calm && !wait) chime(rankedUp(current) ? "leveled" : current.kind);
  }, [key, wait]);

  useEffect(() => {
    if (!current || held || wait) return;
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), SHOW_MS[rankedUp(current) ? "leveled" : current.kind]);
    return () => clearTimeout(t);
  }, [key, held, wait]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setLeaving(false);
      setHeld(false);
      useSystem.getState().next();
    }, calm ? 0 : LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, calm]);

  if (!current || wait) return null;
  const hold = { onMouseEnter: () => (setHeld(true), setLeaving(false)), onMouseLeave: () => setHeld(false), onClick: () => setLeaving(true) };
  if ((current.kind === "used" && !rankedUp(current)) || current.kind === "not_learned")
    return (
      <div className="pointer-events-none! absolute top-14 right-4 z-[47]">
        <div className="pointer-events-auto">
          {current.kind === "not_learned" ? <NotLearned key={key} e={current} leaving={leaving} {...hold} /> : <UsedToast key={key} e={current} calm={calm} leaving={leaving} {...hold} />}
        </div>
      </div>
    );
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-14 z-[47] flex justify-center px-4">
      <div className="pointer-events-auto max-w-full">
        <SystemWindow key={key} e={current} calm={calm} leaving={leaving} {...hold} />
      </div>
    </div>
  );
}

interface FrameProps {
  calm?: boolean;
  leaving?: boolean;
  label: string;
  className?: string;
  style?: CSSProperties;
  pad?: string;
  live?: boolean;
  children: ReactNode;
  onMouseEnter?(): void;
  onMouseMove?(): void;
  onMouseLeave?(): void;
  onClick?(): void;
}

/** The System's glass: cyan edge glow, bracket corners that draw in, one scan line top to bottom. */
export function SystemFrame({ calm, leaving, label, className, style, pad = "px-6 pt-3.5 pb-4", live = true, children, ...on }: FrameProps) {
  return (
    <div role={live ? "status" : "group"} aria-label={label} className={cx("sys", calm && "sys-calm", leaving && "sys-leave", className)} style={{ maxWidth: "100%", ...style }} {...on}>
      <div className={cx("sys-panel", pad)}>{children}</div>
      {!calm && <span className="sys-scan" aria-hidden />}
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <span key={c} className={`sys-corner ${c}`} aria-hidden />
      ))}
    </div>
  );
}

export function SystemTag({ children }: { children: ReactNode }) {
  return (
    <div className="sys-tag">
      <span>{children}</span>
    </div>
  );
}

export function RankBadge({ rank, small, className }: { rank: SkillRank; small?: boolean; className?: string }) {
  return (
    <span className={cx("sys-rank", small && "sm", rank === "S" && "s", className)} style={{ "--rank": RANK_COLOR[rank] } as CSSProperties} title={`Rank ${rank}`} aria-label={`Rank ${rank}`}>
      {rank}
    </span>
  );
}

/** Proficiency toward the next rank. With `from`, it fills from there (the toast's +1). */
export function ProficiencyBar({ level, proficiency, from, calm, className }: { level?: number; proficiency?: number; from?: number; calm?: boolean; className?: string }) {
  const to = rankOf(level, proficiency).progress;
  const start = from === undefined || calm ? to : rankOf(level, from).rank === rankOf(level, proficiency).rank ? rankOf(level, from).progress : 0;
  const [w, setW] = useState(start);
  useEffect(() => {
    const r = requestAnimationFrame(() => setW(to));
    return () => cancelAnimationFrame(r);
  }, [to]);
  return (
    <div className={cx("sys-bar", className)} role="progressbar" aria-label="Proficiency toward the next rank" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(to * 100)}>
      <i style={{ width: `${w * 100}%`, ...(calm ? { transition: "none" } : {}) }} />
    </div>
  );
}

const lv = (n: number) => `Lv.${Math.max(1, n)}`;

function SystemWindow({ e, calm, leaving, ...on }: { e: SkillEvent; calm: boolean; leaving: boolean; onMouseEnter(): void; onMouseLeave(): void; onClick(): void }) {
  if (e.kind === "quest_complete") return <QuestCompleteWindow e={e} calm={calm} leaving={leaving} {...on} />;
  const up = rankedUp(e);
  const label = e.kind === "acquired" ? `Skill acquired: ${e.name}` : e.kind === "leveled" ? `${e.name} leveled up to level ${e.level}` : `${e.name} reached rank ${e.rank}`;
  return (
    <SystemFrame calm={calm} leaving={leaving} label={label} style={{ width: 440 }} {...on}>
      <SystemTag>System</SystemTag>
      <div className="mt-3 flex flex-col items-center gap-2 text-center">
        <span className="sys-kind">{e.kind === "acquired" ? "◆ Skill acquired" : e.kind === "leveled" ? "▲ Level up" : "▲ Rank up"}</span>
        <b className="sys-title max-w-full truncate" title={e.name}>
          {e.kind === "leveled" ? `${e.name} leveled up!` : up ? `${e.name} is now Rank ${e.rank}` : e.name}
        </b>
        <div className="flex items-center gap-1.5">
          {e.kind === "leveled" ? (
            <span className="sys-chip">
              <span className="text-dim">{lv(e.level - 1)}</span>
              <span className="text-signal">→</span>
              {lv(e.level)}
            </span>
          ) : (
            <span className="sys-chip">{lv(e.level)}</span>
          )}
          <span className="sys-chip pr-1">
            Rank
            <RankBadge rank={e.rank} small />
          </span>
          {up && <span className="sys-chip">{e.proficiency} uses</span>}
        </div>
        {e.kind === "acquired" && e.when && <p className="sys-line m-0 line-clamp-2 max-w-[380px]">{e.when}</p>}
        {e.kind === "leveled" && e.learned && (
          <p className="sys-line m-0 max-w-[380px]">
            <span className="text-signal">Learned:</span> {e.learned}
          </p>
        )}
        {e.kind === "leveled" && e.draftId && <UndoLevel draftId={e.draftId} />}
        {up && <p className="sys-line m-0">Every good run makes it stronger.</p>}
      </div>
    </SystemFrame>
  );
}

/** [Level Up]'s one-click Undo: the previous version's bytes come back. */
function UndoLevel({ draftId }: { draftId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  if (state === "done") return <span className="micro text-[9.5px] text-dim">Undone. The previous version is back.</span>;
  return (
    <button type="button" className="hud-btn" disabled={state === "busy"} onClick={(ev) => (ev.stopPropagation(), setState("busy"), void useSystem.getState().undo(draftId).then((ok) => setState(ok ? "done" : "idle")))}>
      Undo
    </button>
  );
}

/** Drafts stayed drafts: said once, quietly, in the corner. No draw-in, no sound. */
function NotLearned({ e, leaving, ...on }: { e: SkillEvent; leaving: boolean; onMouseEnter(): void; onMouseLeave(): void; onClick(): void }) {
  return (
    <div role="status" aria-label={`Not learned: ${e.learned ?? ""}`} className={cx("sys sys-calm", leaving && "sys-leave")} style={{ width: 272 }} {...on}>
      <div className="sys-panel px-3.5 pt-2.5 pb-3">
        <span className="micro text-[9.5px] text-dim">{e.name}</span>
        <p className="m-0 mt-1 text-[12.5px] leading-snug text-dim">Not learned: {e.learned}</p>
        <p className="m-0 mt-0.5 text-[11px] text-faint">The skill stays as it was. A later run that works keeps it.</p>
      </div>
    </div>
  );
}

function QuestCompleteWindow({ e, calm, leaving, ...on }: { e: SkillEvent; calm: boolean; leaving: boolean; onMouseEnter(): void; onMouseLeave(): void; onClick(): void }) {
  const quest = e.quest ?? e.name;
  return (
    <SystemFrame calm={calm} leaving={leaving} label={`Quest complete: ${quest}`} style={{ width: 460 }} {...on}>
      <SystemTag>Quest complete</SystemTag>
      <b className="sys-title mt-3 block truncate text-center" title={quest}>
        {quest}
      </b>
      <Rewards rewards={e.rewards ?? []} runId={e.runId} />
    </SystemFrame>
  );
}

const REWARD_WORD: Record<StartReward["kind"], string> = { acquired: "Skill acquired", leveled: "Level up", used: "Proficiency +1", proposed: "Draft" };
const REWARD_MARK: Record<StartReward["kind"], string> = { acquired: "◆", leveled: "▲", used: "+", proposed: "✦" };

/** SL5: what a quest earned. A quest that ran on no skill at all offers to save one: every action ends with a skill. */
export function Rewards({ rewards, runId }: { rewards: StartReward[]; runId?: string }) {
  const list = useSkills((s) => s.list);
  const [saved, setSaved] = useState(false);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="sys-kind text-[9.5px]">Rewards</span>
        <span className="h-px flex-1 bg-[color-mix(in_srgb,var(--c-cyan)_25%,transparent)]" />
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rewards.map((r, i) => {
          const s = list.find((k) => k.id === r.skillId);
          const info = rankOf(r.level ?? s?.version, s?.proficiency);
          return (
            <li key={`${r.kind}:${r.skillId}:${i}`} className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                <span className="w-3 shrink-0 text-center font-mono text-[11px] text-signal" aria-hidden>
                  {REWARD_MARK[r.kind]}
                </span>
                <span className="micro shrink-0 text-[9.5px] text-[color-mix(in_srgb,var(--c-cyan)_75%,var(--c-ink))]">{REWARD_WORD[r.kind]}</span>
                <b className="min-w-0 flex-1 truncate font-medium text-ink" title={r.name}>
                  {r.name}
                </b>
                <span className="sys-chip h-[18px] px-1.5 text-[9.5px]">{lv(info.level)}</span>
                <RankBadge rank={info.rank} small />
              </div>
              {r.learned && <p className="sys-line m-0 pl-5 text-[11.5px] leading-snug">{r.learned}</p>}
            </li>
          );
        })}
        {!rewards.length && runId && (
          <li className="flex items-center gap-2 pt-0.5 text-[12.5px]">
            <span className="w-3 shrink-0 text-center font-mono text-[11px] text-faint" aria-hidden>
              ◇
            </span>
            <span className="min-w-0 flex-1 text-dim">{saved ? "Saved. Check its steps." : "This isn't a skill yet. Keep it for next time."}</span>
            {!saved && (
              <button type="button" className="hud-btn solid" onClick={(ev) => (ev.stopPropagation(), void useSkills.getState().saveAsSkill({ runId }).then((s) => s && setSaved(true)))}>
                Save as skill
              </button>
            )}
          </li>
        )}
        {!rewards.length && !runId && <li className="sys-line text-[12px]">Done.</li>}
      </ul>
    </div>
  );
}

function UsedToast({ e, calm, leaving, ...on }: { e: SkillEvent; calm: boolean; leaving: boolean; onMouseEnter(): void; onMouseLeave(): void; onClick(): void }) {
  const r = rankOf(e.level, e.proficiency);
  return (
    <SystemFrame calm={calm} leaving={leaving} label={`Used ${e.name}, proficiency ${e.proficiency}`} style={{ width: 272 }} pad="px-3.5 pt-2.5 pb-3" {...on}>
      <div className="flex items-center gap-1.5">
        <span className="sys-kind text-[9.5px]">Used</span>
        <span className="flex-1" />
        <span className="sys-chip h-[18px] px-1.5 text-[9.5px]">{lv(e.level)}</span>
        <RankBadge rank={e.rank} small />
      </div>
      <b className="mt-1 block truncate font-display text-[14px] font-semibold text-[var(--c-core)]" title={e.name}>
        {e.name}
      </b>
      <div className="mt-1.5 mb-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.06em]">
        <span className="text-signal">+1 proficiency</span>
        <span className="flex-1" />
        <span className="text-dim">{r.nextRank ? `${e.proficiency}/${r.nextRankAt} to Rank ${r.nextRank}` : "Top rank"}</span>
      </div>
      <ProficiencyBar level={e.level} proficiency={e.proficiency} from={e.proficiency - 1} calm={calm} />
    </SystemFrame>
  );
}

// ---------- SL5: the quest window (the start agent's live checklist) ----------

export interface QuestObjective {
  id: string;
  title: string;
  state: StartStep["state"];
  detail?: string;
  fix?: string;
  command?: string;
}

const OBJ: Record<StartStep["state"], { g: string; tone: string; word: string }> = {
  pending: { g: "○", tone: "text-faint", word: "Next" },
  running: { g: "◆", tone: "text-ink", word: "Now" },
  done: { g: "✓", tone: "text-dim", word: "Done" },
  fixed: { g: "✓", tone: "text-dim", word: "Fixed" },
  failed: { g: "✕", tone: "text-fail", word: "Stuck" },
  skipped: { g: "–", tone: "text-faint", word: "Skipped" },
  waiting_approval: { g: "!", tone: "text-slow", word: "Waiting for you" },
};

/** `[ QUEST ] Get xyne-spaces running`: objectives ticking live; `[ QUEST COMPLETE ]` with rewards at the end. Place it with className; children go under the list (asks, buttons). */
export function QuestWindow({
  title,
  objectives,
  complete,
  rewards,
  runId,
  say,
  calm: calmProp,
  className,
  style,
  children,
}: {
  title: string;
  objectives: QuestObjective[];
  complete?: boolean;
  rewards?: StartReward[];
  runId?: string;
  say?: string;
  calm?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const calmNow = useCalm();
  const calm = calmProp ?? calmNow;
  const done = objectives.filter((o) => o.state === "done" || o.state === "fixed" || o.state === "skipped").length;
  const n = objectives.length;
  return (
    <SystemFrame calm={calm} label={`${complete ? "Quest complete" : "Quest"}: ${title}`} className={className} style={{ width: 440, ...style }} pad="px-5 pt-3 pb-3.5" live={false}>
      <SystemTag>{complete ? "Quest complete" : "Quest"}</SystemTag>
      <div className="mt-2.5 flex items-baseline gap-3">
        <b className="sys-title min-w-0 flex-1 truncate text-[16px]" title={title}>
          {title}
        </b>
        {n > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-dim">
            {done}/{n}
          </span>
        )}
      </div>
      {n > 0 && <div className="sys-bar mt-2 mb-2.5" aria-hidden><i style={{ width: `${(done / n) * 100}%` }} /></div>}
      <ol aria-live="polite" className="m-0 flex max-h-[300px] list-none flex-col gap-1.5 overflow-y-auto p-0 pr-1">
        {objectives.map((o) => {
          const s = OBJ[o.state];
          return (
            <li key={o.id} className={cx("sys-obj shrink-0", `is-${o.state}`)}>
              <span className={cx("g", s.tone, (o.state === "done" || o.state === "fixed") && "text-ok")} aria-hidden>
                {s.g}
              </span>
              <span className="min-w-0">
                <span className="sr-only">{s.word}: </span>
                <span className={cx(s.tone, o.state === "skipped" && "line-through")}>{o.title}</span>
                {o.state === "fixed" && o.fix && <span className="block truncate text-[11.5px] text-[var(--c-amber)]">Fixed: {o.fix}</span>}
                {(o.state === "running" || o.state === "failed" || o.state === "waiting_approval") && o.detail && <span className={cx("block truncate text-[11.5px]", o.state === "failed" ? "text-[var(--fail-ink)]" : "text-dim")}>{o.detail}</span>}
                {o.state === "running" && o.command && <code className="block truncate font-mono text-[10.5px] text-faint">{o.command}</code>}
              </span>
            </li>
          );
        })}
      </ol>
      {say && !complete && (
        <p className="m-0 mt-2.5 flex gap-2 text-[12.5px] leading-snug text-dim">
          <span className="text-violet" aria-hidden>
            ✦
          </span>
          <span className="min-w-0">{say.replace(/\*\*|`/g, "")}</span>
        </p>
      )}
      {complete && <Rewards rewards={rewards ?? []} runId={runId} />}
      {children}
    </SystemFrame>
  );
}

// ---------- SL6: the skill log ----------

const LOG_WORD: Record<SkillEvent["kind"], string> = { acquired: "Acquired", leveled: "Level up", used: "Used", quest_complete: "Quest", not_learned: "Not learned" };
const LOG_TONE: Record<SkillEvent["kind"], string> = { acquired: "text-signal", leveled: "text-violet", used: "text-dim", quest_complete: "text-[var(--c-amber)]", not_learned: "text-faint" };

/** Every acquired, leveled and used event, newest first; one skill's history when skillId is set. */
export function SkillLog({ skillId, onAll }: { skillId?: string; onAll?(): void }) {
  const log = useSystem((s) => s.log);
  const sound = useSystem((s) => s.sound);
  const allDrafts = useSystem((s) => s.drafts);
  const calm = useCalm();
  useEffect(() => {
    void Promise.resolve()
      .then(() => api().getSkillLog())
      .then((l) => Array.isArray(l) && useSystem.getState().addLog(l.map(asSkillEvent).filter((e) => e !== null)), () => {});
    void useSystem.getState().loadDrafts();
  }, []);
  const drafts = allDrafts.filter((x) => x.status === "pending" && (!skillId || x.skillId === skillId));
  const undoable = new Set(allDrafts.filter((x) => x.status === "applied").map((x) => x.id));
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set()); // the row says so where you clicked (the toast is up top)
  const rows = useMemo(() => [...log].reverse().filter((e) => !skillId || e.skillId === skillId || e.rewards?.some((r) => r.skillId === skillId)), [log, skillId]);
  const name = skillId ? (log.find((e) => e.skillId === skillId)?.name ?? skillId) : undefined;
  return (
    <section aria-label={name ? `${name} history` : "Skill history"}>
      <div className="mb-2 flex items-center gap-2">
        <h4 className="micro m-0 text-faint">{name ? `${name} · history` : "Everything your skills earned"}</h4>
        {name && onAll && (
          <button type="button" className="hud-btn" onClick={onAll}>
            All skills
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          role="switch"
          aria-checked={sound}
          className={cx("hud-btn", sound && "text-signal")}
          title={calm ? "Calm is on, so the System stays quiet" : "A short chime when a System window shows"}
          onClick={() => {
            useSystem.getState().setSound(!sound);
            if (!sound && !calm) chime("acquired");
          }}
        >
          Sound {sound ? "on" : "off"}
        </button>
      </div>
      {!!drafts.length && (
        <ul aria-label="Drafts waiting for a run that works" className="m-0 mb-2 flex list-none flex-col gap-1 border-b border-hair p-0 pb-2">
          {drafts.map((x) => (
            <li key={x.id} className="grid grid-cols-[64px_84px_minmax(0,1fr)_auto] items-baseline gap-3 py-1 text-[12.5px]">
              <time className="font-mono text-[10px] text-faint" dateTime={new Date(x.at).toISOString()} title={new Date(x.at).toLocaleString()}>
                {improvedAgo(x.at)}
              </time>
              <span className="micro text-[9.5px] text-dim">Draft</span>
              <span className="min-w-0">
                <b className="font-medium text-ink">{x.name}</b>
                <span className="block text-[11.5px] leading-snug text-dim">{x.reason}</span>
                <span className="block text-[11px] text-faint">{x.missed ? `Not learned yet: ${x.missed}` : "Kept by itself once a run like this works"}</span>
              </span>
              <button type="button" className="hud-btn" onClick={() => void useSystem.getState().editDraft(x.id)}>
                Edit before keeping
              </button>
            </li>
          ))}
        </ul>
      )}
      {!rows.length ? (
        <p className="pt-4 text-center text-[12.5px] text-dim">{name ? "Nothing yet. Run it once and it starts to grow." : "Nothing yet. When a skill is saved, improved or used, it shows here."}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {rows.map((e) => (
            <li key={keyOf(e)} className="grid grid-cols-[64px_84px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-hair py-1.5 text-[12.5px] last:border-b-0">
              <time className="font-mono text-[10px] text-faint" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                {improvedAgo(e.at)}
              </time>
              <span className={cx("micro text-[9.5px]", LOG_TONE[e.kind])}>{LOG_WORD[e.kind]}</span>
              <span className="min-w-0">
                <b className="font-medium text-ink">{e.kind === "quest_complete" ? (e.quest ?? e.name) : e.name}</b>
                {e.kind === "leveled" && e.learned && <span className="block text-[11.5px] leading-snug text-dim">Learned: {e.learned}</span>}
                {e.kind === "not_learned" && e.learned && <span className="block text-[11.5px] leading-snug text-dim">{e.learned}</span>}
                {e.kind === "acquired" && e.when && <span className="block truncate text-[11.5px] text-dim">{e.when}</span>}
                {e.kind === "used" && <span className="block text-[11.5px] text-dim">Proficiency {e.proficiency}{e.nextRankAt ? ` of ${e.nextRankAt} for the next rank` : ""}</span>}
                {e.kind === "quest_complete" && !!e.rewards?.length && <span className="block truncate text-[11.5px] text-dim">{e.rewards.map((r) => `${REWARD_WORD[r.kind]}: ${r.name}`).join(" · ")}</span>}
              </span>
              <span className="flex items-center gap-1.5">
                {e.kind === "leveled" && e.draftId && undone.has(e.draftId) ? (
                  <span className="micro text-[9.5px] text-dim">Undone</span>
                ) : (
                  e.kind === "leveled" &&
                  e.draftId &&
                  undoable.has(e.draftId) && (
                    <button type="button" className="hud-btn" onClick={() => void useSystem.getState().undo(e.draftId!).then((ok) => ok && setUndone((s) => new Set(s).add(e.draftId!)))}>
                      Undo
                    </button>
                  )
                )}
                {e.level > 0 && <span className="font-mono text-[10px] text-dim">{lv(e.level)}</span>}
                {e.skillId && <RankBadge rank={e.rank} small />}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
