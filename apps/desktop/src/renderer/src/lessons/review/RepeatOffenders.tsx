import "./review.css";
import { useEffect, useRef, type CSSProperties } from "react";
import { GraduationCap, RefreshCw } from "lucide-react";
import type { ReviewLesson, ReviewerProfile, ReviewLessonsView } from "@shrike/schema";
import { api } from "../../lib/api.ts";
import { cx, IconButton, Spinner } from "../../components/ui.tsx";
import { RankBadge } from "../../system/System.tsx";
import { burnSummary, sparkPath } from "./logic.ts";
import { useLessons } from "./store.ts";

// RL7: Repeat offenders, the right dock's Lessons tab. One focal number (the burn-down), then lessons, then reviewers.

const LIMITS = [20, 50, 100] as const;
const STALE_MS = 6 * 3600_000;

export function RepeatOffenders() {
  const view = useLessons((s) => s.view);
  const note = useLessons((s) => s.note);
  useEffect(() => {
    const v = useLessons.getState().view;
    if (v?.ready && v.minedAt && Date.now() - v.minedAt > STALE_MS) void useLessons.getState().refresh(); // a known repo, gone stale: read what's new
  }, [view?.repo]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Review lessons" data-lessons-panel>
      <Header view={view} />
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-16">
        {note && (
          <p role="status" className="mb-2 text-[12px] leading-snug text-fail">
            {note}
          </p>
        )}
        {!view ? (
          <p className="lbl flex items-center gap-2 py-6">
            <Spinner size={11} /> Reading your lessons
          </p>
        ) : !view.ready ? (
          <section className="py-4">
            <p className="font-display text-[15px] font-semibold text-ink">No reviews to learn from here</p>
            <p className="mt-1 text-[12.5px] text-dim">{view.problem ?? "Open a project that lives on GitHub."}</p>
          </section>
        ) : (
          <Body view={view} />
        )}
      </div>
    </div>
  );
}

function Header({ view }: { view: ReviewLessonsView | null }) {
  const busy = view?.busy;
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-hair pr-2 pl-4">
      <GraduationCap size={13} className="text-violet" aria-hidden />
      <span className="lbl text-ink">Review lessons</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{view?.repo ?? ""}</span>
      {view?.ready && (
        <>
          <select aria-label="How many of your pull requests to read" className="rl-select" value={view.limit} disabled={!!busy} onChange={(e) => void useLessons.getState().refresh(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                Last {n} PRs
              </option>
            ))}
          </select>
          <IconButton label="Refresh: read new review activity" disabled={!!busy} onClick={() => void useLessons.getState().refresh()}>
            {busy ? <Spinner size={11} /> : <RefreshCw size={12} />}
          </IconButton>
        </>
      )}
    </header>
  );
}

const BUSY: Record<NonNullable<ReviewLessonsView["busy"]>, string> = { mining: "Reading your pull requests' reviews", thinking: "Your agent is grouping what reviewers keep saying" };

function Body({ view }: { view: ReviewLessonsView }) {
  if (!view.minedAt && !view.lessons.length)
    return (
      <section className="py-3" aria-label="Learn from your reviews">
        <span className="lbl">Repeat offenders</span>
        <h4 className="mt-1 mb-1.5 font-display text-[15px] font-semibold text-ink">See what reviewers keep flagging in your PRs</h4>
        <p className="mb-3 text-[12.5px] leading-snug text-dim">Shrike reads the review threads on your pull requests here (nothing is posted), and your agent groups what keeps coming up into lessons with how to fix each one.</p>
        <button type="button" className="btn go" disabled={!!view.busy} onClick={() => void useLessons.getState().refresh(view.limit)}>
          {view.busy ? <Spinner size={10} /> : null}
          Learn from your last {view.limit} pull requests
        </button>
        {view.busy && <p className="mt-2 text-[12px] text-dim">{BUSY[view.busy]}</p>}
        {view.problem && <p className="mt-2 text-[12px] text-fail">{view.problem}</p>}
      </section>
    );
  return (
    <>
      {view.busy && (
        <p role="status" className="mb-2 flex items-center gap-2 text-[12px] text-dim">
          <Spinner size={10} /> {BUSY[view.busy]}
        </p>
      )}
      {view.problem && <p className="mb-2 text-[12px] leading-snug text-fail">{view.problem}</p>}
      {view.burn.length > 1 && <Burn view={view} />}
      <section aria-label="Repeat offenders" className="mt-4">
        <div className="flex items-baseline gap-2">
          <span className="lbl flex-1">Repeat offenders</span>
          <span className="text-[10.5px] text-faint">
            {view.prs} PRs read · {view.reviewed} reviewed
          </span>
        </div>
        {view.lessons.length ? (
          <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {view.lessons.map((l) => (
              <li key={l.id}>
                <LessonCard l={l} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-[12.5px] text-dim">Nothing comes up again and again yet. Reviews that repeat themselves show here.</p>
        )}
      </section>
      {view.reviewers.length > 0 && (
        <section aria-label="Reviewers" className="mt-5">
          <span className="lbl">How they review</span>
          <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {view.reviewers.map((r) => (
              <li key={r.login}>
                <ReviewerCard r={r} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {view.lessons.some((l) => l.pending) && <p className="mt-4 text-[11.5px] leading-snug text-faint">Lessons waiting for a reviewer join your skill once a reviewer resolves one of their threads or approves your next PR.</p>}
    </>
  );
}

const VERDICT = { fewer: { word: "Fewer than before", tone: "text-ok" }, more: { word: "More than before", tone: "text-slow" }, same: { word: "About the same", tone: "text-dim" } } as const;

/** RL-ui1: the one focal number. */
function Burn({ view }: { view: ReviewLessonsView }) {
  const s = burnSummary(view.burn);
  const max = Math.max(1, ...view.burn.map((b) => b.flagged));
  const v = VERDICT[s.verdict];
  return (
    <section aria-label="Repeat issues per PR" className="rl-burn">
      <span className="lbl">Repeat issues per PR</span>
      <div className="mt-1 flex items-baseline gap-2">
        <b className="rl-num dim" title="Earlier PRs">{s.before}</b>
        <span className="text-faint">→</span>
        <b className="rl-num" title="Your latest PRs">{s.lately}</b>
        <span className={cx("ml-1 text-[12.5px]", v.tone)}>{v.word}</span>
      </div>
      <div className="rl-bars" role="img" aria-label={view.burn.map((b) => `#${b.pr}: ${b.flagged}`).join(", ")}>
        {view.burn.map((b, i) => (
          <i key={b.pr} className={cx(i === view.burn.length - 1 && "now", !b.flagged && "none")} style={{ height: b.flagged ? `${Math.max(12, (b.flagged / max) * 100)}%` : undefined }} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[9.5px] text-faint">
        <span>#{view.burn[0]!.pr}</span>
        <span>#{view.burn.at(-1)!.pr}</span>
      </div>
    </section>
  );
}

const MARK: Record<ReviewLesson["status"], { word: string; cls: string } | null> = { learning: null, "not-working": { word: "Not working yet", cls: "warn" }, mastered: { word: "Mastered", cls: "ok" } };

function Spark({ values, trend }: { values: number[]; trend: ReviewLesson["trend"] }) {
  const d = sparkPath(values, 62, 18);
  const max = Math.max(1, ...values);
  const last = values.at(-1) ?? 0;
  return (
    <svg className="rl-spark" width="64" height="18" viewBox="-1 0 64 18" aria-hidden>
      <path d={d} />
      <circle className={trend} cx={62} cy={17 - (last / max) * 16} r={2.4} />
    </svg>
  );
}

function LessonCard({ l }: { l: ReviewLesson }) {
  const open = useLessons((s) => s.open === l.id);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => void (open && ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })), [open]);
  const mark = l.pending && l.status !== "mastered" ? { word: "Waiting for a reviewer", cls: "wait" } : MARK[l.status];
  return (
    <article ref={ref} className={cx("rl-card", open && "open", l.status === "mastered" && "done")} data-lesson={l.id} data-rank={l.rank}>
      <button type="button" className="rl-card-head" aria-expanded={open} onClick={() => useLessons.setState({ open: open ? null : l.id })}>
        <RankBadge rank={l.rank} small />
        <span className="min-w-0 flex-1">
          <span className="rl-title">{l.title}</span>
          <span className="rl-meta">
            {l.prs.length === 1 ? "1 PR" : `${l.prs.length} PRs`} · {l.reviewers.slice(0, 2).map((r) => `@${r}`).join(" ")} · {l.clean ? `not seen in ${l.clean} PR${l.clean === 1 ? "" : "s"}` : `last in #${l.prs[0]}`}
          </span>
        </span>
        <span className="rl-count" aria-label={`${l.count} times`}>
          {l.count}×
        </span>
        <Spark values={l.spark} trend={l.trend} />
      </button>
      {mark && <span className={cx("rl-mark", mark.cls)}>{mark.word}</span>}
      {open && (
        <div className="rl-card-body">
          {l.spot && (
            <>
              <span className="lbl">Spot it</span>
              <p className="mt-0.5 mb-2 text-[12.5px] leading-snug text-ink">{l.spot}</p>
            </>
          )}
          {l.fix.length > 0 && (
            <>
              <span className="lbl">Fix it</span>
              <ol className="mt-0.5 mb-2 list-decimal pl-4 text-[12.5px] leading-snug text-ink">
                {l.fix.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </>
          )}
          <span className="lbl">Where it came up</span>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {l.examples.map((e) => (
              <li key={e.commentId}>
                <button type="button" className="rl-example" disabled={!e.url} title={e.url ? "Open on GitHub" : undefined} onClick={() => e.url && void api().openLink(e.url)}>
                  <span className="shrink-0 font-mono text-[10.5px] whitespace-nowrap text-signal">
                    #{e.pr}
                    {e.path ? ` ${e.path.split("/").pop()}${e.line ? `:${e.line}` : ""}` : ""}
                  </span>
                  <span className="truncate text-[11.5px] text-dim">
                    @{e.reviewer}: {e.quote}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

const TREND = { down: { word: "trending down", tone: "text-ok" }, up: { word: "trending up", tone: "text-slow" }, flat: null } as const;

function ReviewerCard({ r }: { r: ReviewerProfile }) {
  const total = Math.max(1, r.blocking + r.nits + r.questions + r.notes);
  const per = r.prs ? Math.round((r.comments / r.prs) * 10) / 10 : 0;
  const t = TREND[r.trend];
  const parts = [
    ["blocking", r.blocking],
    ["question", r.questions],
    ["nit", r.nits],
    ["note", r.notes],
  ] as const;
  return (
    <article className="rl-rev" data-reviewer={r.login}>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cx("rl-avatar", r.bot && "bot")}>
          {r.login.replace(/\[bot\]$/, "").slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            @{r.login.replace(/\[bot\]$/, "")}
            {r.bot && <span className="micro ml-1.5 text-[8.5px] text-violet">Bot</span>}
          </span>
          <span className="block text-[11px] text-dim">
            {per} {per === 1 ? "comment" : "comments"} a PR over {r.prs} {r.prs === 1 ? "PR" : "PRs"}{t && <span className={t.tone}> · {t.word}</span>}
          </span>
        </span>
      </div>
      <div className="rl-split" role="img" aria-label={parts.map(([k, n]) => `${n} ${k}`).join(", ")}>
        {parts.map(([k, n]) => (n ? <i key={k} className={k} style={{ width: `${(n / total) * 100}%` } as CSSProperties} /> : null))}
      </div>
      <div className="rl-legend">
        {parts.filter(([, n]) => n).map(([k, n]) => (
          <span key={k} className={k}>
            {n} {k === "blocking" ? "blocking" : `${k}${n === 1 ? "" : "s"}`}
          </span>
        ))}
        {r.approvals > 0 && <span>{r.approvals} approved</span>}
      </div>
      {r.concerns.length > 0 && (
        <ol className="rl-concerns" aria-label="Top concerns">
          {r.concerns.map((c, i) => (
            <li key={c.lessonId}>
              <button type="button" className={cx("rl-concern", i === 0 && "top")} onClick={() => useLessons.setState({ open: c.lessonId })}>
                <b>{c.count}</b>
                {c.title}
              </button>
            </li>
          ))}
        </ol>
      )}
      {(r.style.length > 0 || r.habit) && (
        <ul className="rl-style">
          {r.style.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
          {r.habit && <li>{r.habit}</li>}
        </ul>
      )}
    </article>
  );
}
