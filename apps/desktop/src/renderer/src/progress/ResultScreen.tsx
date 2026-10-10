import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { QuestResult, StartReward } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { cx } from "../components/ui.tsx";
import { useActions } from "../stores/actions.ts";
import { useAgent } from "../stores/agent.ts";
import { useSkills } from "../stores/skills.ts";
import { useThread } from "../stores/thread.ts";
import { useUi } from "../stores/ui.ts";
import { RankBadge, SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { rankOf } from "../system/ranks.ts";
import { blip, chime } from "../system/sound.ts";
import { useSystem } from "../system/store.ts";
import { CollectCard, fmtXp, MedalDisc, MetalLetter } from "./parts.tsx";
import { asUpdate, COUNT_MS, LINE_AT, midWork, progressAt, timeline, useProgress, userTrip } from "./store.ts";
import { titleOf } from "./xp.ts";

// XP3 results screen (Storm 2 style) and the small outside-a-quest notice. ProgressLayer mounts once (SystemLayer).

let tripAt = 0;
const busy = () => {
  const ui = useUi.getState();
  const ag = useAgent.getState();
  const open = [useThread.getState().dived, ui.sheet, ui.panel, ui.file, ui.setup, ui.issue, ui.quickOpen, ui.pointing, ui.sdlcOpen, ui.checkpoint, ui.recMenu, ag.open, ag.approvals.length, useProgress.getState().profile, useSystem.getState().current?.kind === "leveled"]; // SL2: [Level Up] and its Undo play first
  return midWork({ tripAgo: Date.now() - tripAt, typing: isTyping(document.activeElement), open });
};

export function ProgressLayer() {
  useEffect(() => {
    const a = api();
    if (typeof a.getProgress !== "function") return;
    const off = a.on("progress:update", (p) => {
      const u = asUpdate(p);
      if (u) useProgress.getState().apply(u, busy());
    });
    // a trip the user makes while the screen auto-opened folds it into the chip
    const seen = new Set(useActions.getState().order);
    const offTrips = useActions.subscribe(({ order, byId }) => {
      let fresh = false;
      const now = Date.now();
      for (const id of order) {
        if (seen.has(id)) continue;
        seen.add(id);
        const t = byId[id];
        if (t && userTrip(t, now)) fresh = true;
      }
      if (!fresh) return;
      tripAt = Date.now();
      const st = useProgress.getState();
      if (st.result && st.open) st.hold();
    });
    void Promise.resolve()
      .then(() => a.getProgress())
      .then((progress) => progress && typeof progress.xp === "number" && !useProgress.getState().progress && useProgress.setState({ progress }), () => {});
    // the level up is done: a result it held opens now, if the user is still idle
    const offSys = useSystem.subscribe((now, was) => {
      if (was.current?.kind !== "leveled" || now.current?.kind === "leveled") return;
      const st = useProgress.getState();
      if (st.result && !st.open && !busy()) useProgress.setState({ open: true });
    });
    return () => (off(), offTrips(), offSys());
  }, []);
  const result = useProgress((s) => (s.open ? s.result : null));
  return (
    <>
      {result && <ResultScreen key={result.id} r={result} onClose={() => useProgress.getState().next(busy())} />}
      <ProgressNotice />
    </>
  );
}

// focus in the docked app (webview) counts: its keys never reach this window
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, .xterm, webview, iframe"));

const REWARD_WORD: Record<StartReward["kind"], string> = { acquired: "Skill acquired", leveled: "Level up", used: "Proficiency +1", proposed: "Improvement" };

/** Time since open; skip jumps to the end. Calm starts at the end and never ticks. */
function useClock(end: number, calm: boolean): [number, () => void] {
  const [t, setT] = useState(calm ? end : 0);
  const skipped = useRef(calm);
  useEffect(() => {
    if (skipped.current) return;
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const now = skipped.current ? end : performance.now() - t0;
      setT(Math.min(end, now));
      if (now < end) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return [t, () => ((skipped.current = true), setT(end))];
}

export function ResultScreen({ r, onClose }: { r: QuestResult; onClose(): void }) {
  const calm = useCalm();
  const sound = useSystem((s) => s.sound) && !calm;
  const tl = timeline(r.lines.length, r.cards.length, !!r.promoted);
  const [t, skip] = useClock(tl.end, calm);
  const done = t >= tl.end;
  const ticked = useRef(-1);
  const [held, setHeld] = useState(false);

  // a tick as each line lands, a thud under the letter
  useEffect(() => {
    if (!sound || done) return;
    const i = r.lines.findLastIndex((_, j) => t >= LINE_AT(j));
    if (i > ticked.current) (ticked.current = i), blip("tick");
    if (t >= tl.slam && ticked.current < 99) (ticked.current = 99), blip("slam");
    if (t >= tl.promo && r.promoted && ticked.current < 100) (ticked.current = 100), chime("leveled");
  }, [t]);

  // any key skips, then closes; Esc closes; app shortcuts and typing (terminal, inputs) pass through
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || isTyping(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" || done) onClose();
      else skip();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [done]);

  // never blocks for long: the end state leaves by itself unless the pointer rests on it
  useEffect(() => {
    if (!done || held) return;
    const id = setTimeout(onClose, 12_000);
    return () => clearTimeout(id);
  }, [done, held]);

  const total = Math.round(r.xp * progressAt(t, tl.total, 420));
  const slammed = t >= tl.slam;
  const slamAge = t - tl.slam;
  return (
    <div
      className={cx("xr-scrim", calm && "calm")}
      role="dialog"
      aria-modal="false"
      aria-label={`Quest complete: ${r.quest}. Rank ${r.grade}, ${r.xp} XP`}
      onClick={() => (done ? onClose() : skip())}
    >
      <div className={cx("xr-stage", slammed && slamAge < 260 && !calm && "shake")} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}>
        <SystemTag>Quest complete</SystemTag>
        <div className="mt-3 flex items-baseline justify-center gap-3">
          <b className="xr-quest truncate" title={r.quest}>
            {r.quest}
          </b>
          {r.project && <span className="sys-chip shrink-0">{r.project}</span>}
        </div>

        <div className="xr-body">
          <ol className="xr-lines" aria-label="Score">
            {r.lines.map((l, i) => {
              const k = progressAt(t, LINE_AT(i), COUNT_MS);
              const shown = t >= LINE_AT(i);
              const numeric = /^\d+$/.test(l.value);
              return (
                <li key={l.id} className={cx("xr-line", shown && "in", l.xp === 0 && "zero")}>
                  <span className="lb">{l.label}</span>
                  <span className="dots" aria-hidden />
                  <span className="vl">{numeric ? Math.round(Number(l.value) * k) : l.value}</span>
                  <span className="xp">+{Math.round(l.xp * k)}</span>
                </li>
              );
            })}
            <li className={cx("xr-line total", t >= tl.total && "in")}>
              <span className="lb">Total</span>
              <span className="dots" aria-hidden />
              <span className="vl">{r.score} pts</span>
              <span className="xp">+{fmtXp(total)} XP</span>
            </li>
          </ol>
          <div className="xr-rank">
            <span className="sys-kind text-[10px]">Rank</span>
            <div className="xr-letter-wrap">
              {slammed ? <MetalLetter grade={r.grade} className={cx(!calm && slamAge < 1400 && "slam")} /> : <span className="xr-letter-ghost" aria-hidden />}
            </div>
          </div>
        </div>

        <XpFill r={r} k={progressAt(t, tl.bar, 900)} />

        <div className={cx("xr-rewards", t >= tl.rewards && "in")}>
          {r.medal && <Drop at={0} on={t >= tl.rewards}><MedalDisc medal={r.medal} size={64} className={cx(r.medal === "gold" && !calm && "shimmer")} /></Drop>}
          {r.rewards.filter((x) => x.kind !== "proposed").slice(0, 3).map((x, i) => (
            <Drop key={`${x.kind}:${x.skillId}`} at={i + 1} on={t >= tl.rewards}>
              <SkillReward x={x} />
            </Drop>
          ))}
          {r.cards.map((c, i) => (
            <Drop key={c.id} at={i + 4} on={t >= tl.flip}>
              <CollectCard card={c} flip={!calm && t - tl.flip < 2200} />
            </Drop>
          ))}
          {!r.medal && !r.cards.length && !r.rewards.some((x) => x.kind !== "proposed") && <span className="sys-line">Every quest makes you stronger.</span>}
        </div>

        {r.promoted && t >= tl.promo && (
          <div className="mt-4 flex justify-center">
            <Promotion from={r.promoted.from} to={r.promoted.to} calm={calm} />
          </div>
        )}

        <p className="xr-hint">{done ? "Click or press any key to go on" : "Any key skips · Esc closes"}</p>
      </div>
    </div>
  );
}

function Drop({ at, on, children }: { at: number; on: boolean; children: ReactNode }) {
  return (
    <div className={cx("xr-drop", on && "in")} style={{ "--d": `${at * 110}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

function SkillReward({ x }: { x: StartReward }) {
  const s = useSkills((st) => st.list.find((k) => k.id === x.skillId));
  const info = rankOf(x.level ?? s?.version, s?.proficiency);
  return (
    <div className="xr-skill">
      <span className="sys-kind text-[9px]">{REWARD_WORD[x.kind]}</span>
      <b className="mt-1 block truncate font-display text-[14px] text-[var(--c-core)]" title={x.name}>
        {x.name}
      </b>
      <span className="mt-1.5 flex items-center gap-1.5">
        <span className="sys-chip h-[18px] px-1.5 text-[9.5px]">
          {x.kind === "leveled" && info.level > 1 ? `Lv.${info.level - 1} → ${info.level}` : `Lv.${info.level}`}
        </span>
        <RankBadge rank={info.rank} small />
      </span>
    </div>
  );
}

/** The XP bar fills toward the next title; across a promotion it fills the old one, then starts the new one. */
function XpFill({ r, k }: { r: QuestResult; k: number }) {
  const xp = r.before + (r.after - r.before) * k;
  const a = titleOf(r.before);
  const b = titleOf(r.after);
  const first = a.index !== b.index && k < 0.5; // ponytail: a jump of two titles fills the old one, then the newest
  const now = first ? a : b;
  const fill = first ? a.progress + (1 - a.progress) * (k / 0.5) : a.index !== b.index ? b.progress * ((k - 0.5) / 0.5) : a.progress + (b.progress - a.progress) * k;
  return (
    <div className="xr-xp">
      <div className="flex items-baseline gap-2">
        <b className="xr-title">{now.title}</b>
        <span className="font-mono text-[11px] text-dim">{fmtXp(xp)} XP</span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-faint">{now.next ? `${fmtXp(Math.max(0, (now.nextAt ?? 0) - xp))} to ${now.next}` : "Top of the ladder"}</span>
      </div>
      <div className="xr-bar" role="progressbar" aria-label={`XP toward ${now.next ?? "the top"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
        <i style={{ width: `${Math.min(1, fill) * 100}%` }} />
      </div>
    </div>
  );
}

export function Promotion({ from, to, calm, onClick }: { from: string; to: string; calm: boolean; onClick?(): void }) {
  return (
    <SystemFrame calm={calm} label={`Promoted from ${from} to ${to}`} className="xr-promo" style={{ width: 420 }} {...(onClick ? { onClick } : {})}>
      <SystemTag>Promoted</SystemTag>
      <div className="mt-3 flex items-center justify-center gap-3 text-center">
        <span className="font-display text-[17px] text-dim">{from}</span>
        <span className="text-signal" aria-hidden>
          →
        </span>
        <b className="sys-title text-[22px]">{to}</b>
      </div>
      <p className="sys-line m-0 mt-1.5 text-center">New title unlocked.</p>
    </SystemFrame>
  );
}

/** Promoted or a card unlocked outside a quest: one small System window, 3.5s, click to dismiss, queued with the System windows. Sits above a results screen so it never replays. */
function ProgressNotice() {
  const waiting = useSystem((s) => !!s.current); // never over a System window: it plays when that one leaves
  const notice = useProgress((s) => (waiting ? null : s.notice));
  const calm = useCalm();
  const sound = useSystem((s) => s.sound) && !calm;
  const close = () => (useProgress.setState({ notice: null }), useSystem.getState().current || useSystem.getState().next());
  useEffect(() => {
    if (!notice) return;
    if (sound) chime(notice.promoted ? "leveled" : "acquired");
    const id = setTimeout(close, notice.cards.length ? 5000 : 3500);
    return () => clearTimeout(id);
  }, [notice?.id]);
  if (!notice) return null;
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-[140px] z-[60] flex justify-center px-4">
      <div className="pointer-events-auto flex flex-col items-center gap-3">
        {notice.promoted && <Promotion from={notice.promoted.from} to={notice.promoted.to} calm={calm} onClick={close} />}
        {!!notice.cards.length && (
          <SystemFrame calm={calm} label="Card unlocked" style={{ width: 300 }} onClick={close}>
            <SystemTag>Card unlocked</SystemTag>
            <div className="mt-3 flex justify-center gap-2">
              {notice.cards.slice(0, 2).map((c) => (
                <CollectCard key={c.id} card={c} flip={!calm} small />
              ))}
            </div>
          </SystemFrame>
        )}
      </div>
    </div>
  );
}
