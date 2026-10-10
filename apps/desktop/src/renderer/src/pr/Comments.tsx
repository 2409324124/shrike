import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, ExternalLink, FileCode, ListPlus, Reply, SmilePlus } from "lucide-react";
import type { PrComment, PrReview, PrThread, PrView } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { toast, useUi } from "../stores/ui.ts";
import { cx, Spinner } from "../components/ui.tsx";
import { CommentBody } from "./CommentBody.tsx";
import { stripHtml } from "./markdown.ts";
import { ago, emoji, feed, REACTIONS, reviewProgress, whoCounts, type Who } from "./logic.ts";
import { usePr } from "./store.ts";
import { LearnFromThis, LessonChip } from "../lessons/index.ts"; // review-lessons: RL8

// PR4 tabs, PR5 comment cards, PR6 review progress, PR8 submit review, PR9 the agent's reply drafts.

const TABS: { id: Who; word: string }[] = [
  { id: "all", word: "All" },
  { id: "people", word: "People" },
  { id: "bots", word: "Bots" },
];

export function Comments({ view }: { view: PrView & { pr: NonNullable<PrView["pr"]> } }) {
  const who = usePr((s) => s.who);
  const busy = usePr((s) => s.busy);
  const counts = whoCounts(view);
  const items = feed(view, who);
  const p = reviewProgress(view.threads);
  const n = view.pr.number;
  return (
    <section aria-label="Comments and reviews" className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="lbl flex-1">Conversation</span>
        {p.open > 0 && view.pr.state !== "merged" && view.pr.state !== "closed" && (
          <button type="button" className="btn h-7 px-2.5" disabled={!!busy} title="One agent run over every open conversation (Address review comments skill). It drafts a reply for each; you approve every one before it's posted." onClick={() => void usePr.getState().agent({ kind: "fix-all", n }, "Your agent is working through the open comments. Its replies show here as drafts.")}>
            {busy === "agent:fix-all" ? <Spinner size={10} /> : <span className="text-violet">✦</span>}
            Fix all open comments
          </button>
        )}
      </div>
      {p.total > 0 && (
        <div className="mt-2.5" aria-label="Review progress">
          <div className="flex items-baseline justify-between text-[11.5px]">
            <span className="text-dim">
              <b className="font-display text-[15px] font-light text-ink">{p.resolved}</b> of {p.total} conversations resolved
            </span>
            {p.open > 0 && <span className="text-slow">{p.open} open</span>}
          </div>
          <div className="mt-1 h-[5px] overflow-hidden rounded-full bg-hair">
            <div className="h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${(p.resolved / p.total) * 100}%`, boxShadow: p.open ? undefined : "0 0 8px var(--ok)" }} />
          </div>
        </div>
      )}
      <div role="tablist" aria-label="Whose comments" className="mt-3 flex items-center gap-0.5 border-b border-hair">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={who === t.id} onClick={() => usePr.setState({ who: t.id })} className={cx("-mb-px flex items-center gap-1.5 border-b-[1.5px] px-2.5 py-2 text-[12px]", who === t.id ? "border-signal text-ink" : "border-transparent text-faint hover:text-dim")}>
            {t.word}
            <span className={cx("rounded-full px-1.5 py-px text-[9px]", who === t.id ? "bg-signal/15 text-signal" : "bg-glass text-dim")}>{counts[t.id]}</span>
          </button>
        ))}
      </div>
      {items.length ? (
        <ol className="m-0 mt-3 flex list-none flex-col divide-y divide-hair p-0">
          {items.map((it) => (
            <li key={it.kind === "thread" ? it.thread.id : it.kind === "comment" ? it.comment.id : it.review.id} className="py-3 first:pt-0">
              {it.kind === "thread" ? <Thread t={it.thread} view={view} /> : it.kind === "review" ? <ReviewCard r={it.review} /> : <CommentCard c={it.comment} view={view} />}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-[12.5px] text-dim">{who === "bots" ? "No bots said anything." : who === "people" ? "No one has said anything yet." : "No comments yet."}</p>
      )}
      {view.pr.state !== "merged" && view.pr.state !== "closed" && <Compose view={view} />}
    </section>
  );
}

function Avatar({ login, bot }: { login: string; bot: boolean }) {
  return (
    <span aria-hidden className={cx("inline-grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-[10px] font-semibold uppercase", bot ? "border-violet/50 bg-violet/15 text-violet" : "border-hair-strong bg-glass text-ink")}>
      {login.replace(/\[bot\]$/, "").slice(0, 1)}
    </span>
  );
}

function Byline({ login, bot, at, extra }: { login: string; bot: boolean; at?: string; extra?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar login={login} bot={bot} />
      <span className="truncate text-[12.5px] font-medium text-ink">{login.replace(/\[bot\]$/, "")}</span>
      {extra}
      {at && <span className="ml-auto shrink-0 text-[10.5px] text-faint">{ago(at)}</span>}
    </div>
  );
}

const REVIEW_WORD: Record<PrReview["state"], { word: string; tone: string }> = {
  approved: { word: "approved", tone: "text-ok" },
  changes: { word: "asked for changes", tone: "text-slow" },
  commented: { word: "reviewed", tone: "text-dim" },
  dismissed: { word: "review dismissed", tone: "text-faint" },
  pending: { word: "review in progress", tone: "text-faint" },
};

function ReviewCard({ r }: { r: PrReview }) {
  const w = REVIEW_WORD[r.state];
  return (
    <article data-review={r.id}>
      <Byline login={r.author} bot={r.bot} at={r.at} extra={<span className={cx("shrink-0 text-[11px]", w.tone)}>{r.state === "approved" && <Check size={9} className="mr-0.5 inline" />}{w.word}</span>} />
      {r.body.trim() && <div className="mt-1.5 pl-[30px]"><LessonChip commentId={r.id} /><CommentBody text={r.body} /></div>}
    </article>
  );
}

/** Opens the file at the comment's line, with the comment as a chip on that line. */
function openAt(t: PrThread, prefix: string | undefined) {
  const path = prefix && t.path.startsWith(prefix) ? t.path.slice(prefix.length) : t.path;
  const first = t.comments[0];
  useUi.getState().openFile({ path, line: t.line ?? 1, ...(first ? { note: `@${first.author}: ${first.body.replace(/\s+/g, " ").trim()}` } : {}) });
}

function Thread({ t, view }: { t: PrThread; view: PrView & { pr: NonNullable<PrView["pr"]> } }) {
  const [open, setOpen] = useState(!t.resolved);
  const [replying, setReplying] = useState(false);
  const draft = usePr((s) => s.drafts[t.id]);
  const busy = usePr((s) => s.busy);
  const first = t.comments[0];
  const live = view.pr.state === "open" || view.pr.state === "draft";
  return (
    <article className={cx(t.resolved && "opacity-75")} data-thread={t.id} data-resolved={t.resolved}>
      <header className="flex items-center gap-2">
        <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-[5px] border border-hair px-1.5 py-0.5 font-mono text-[10.5px] text-signal hover:border-signal/50" title="Open this line here" onClick={() => openAt(t, view.prefix)}>
          <FileCode size={10} className="shrink-0" />
          <span className="truncate">{t.path.split("/").pop()}{t.line ? `:${t.line}` : ""}</span>
        </button>
        {t.outdated && <span className="text-[11px] text-faint" title="The code changed since this was written">Outdated</span>}
        <span className="flex-1" />
        {t.resolved ? (
          <span className="flex items-center gap-1 text-[11px] text-ok"><Check size={9} />Resolved</span>
        ) : (
          <span className="text-[11px] text-slow">Open</span>
        )}
        <button type="button" className="text-faint hover:text-ink" aria-label={open ? "Fold" : "Unfold"} onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        </button>
      </header>
      {!open ? (
        <button type="button" className="block w-full truncate pt-1 text-left text-[12px] text-faint hover:text-dim" onClick={() => setOpen(true)}>
          {first ? `${first.author.replace(/\[bot\]$/, "")}: ${stripHtml(first.body).replace(/[#*`>_|]|-{3,}|:-+:?/g, " ").replace(/\s+/g, " ").trim()}` : ""}
        </button>
      ) : (
        <div className="pt-2">
          <div className="flex flex-col gap-2.5">
            {t.comments.map((c, i) => (
              <div key={c.id} className={cx(i > 0 && "border-t border-hair pt-2.5")}>
                <CommentCard c={c} view={view} bare />
              </div>
            ))}
          </div>
          {draft !== undefined && live && <Draft t={t} n={view.pr.number} text={draft} />}
          {replying && live && <ReplyBox n={view.pr.number} threadId={t.id} onDone={() => setReplying(false)} />}
          {live && !replying && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <button type="button" className="hud-btn" onClick={() => setReplying(true)}>
                <Reply size={11} />
                Reply
              </button>
              <button type="button" className="hud-btn" disabled={!!busy} onClick={() => void usePr.getState().act({ kind: "resolve", n: view.pr.number, threadId: t.id, resolved: !t.resolved }, t.resolved ? "Reopened." : "Resolved.")}>
                {busy === `resolve:${t.id}` ? <Spinner size={10} /> : <Check size={11} />}
                {t.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function CommentCard({ c, view, bare }: { c: PrComment; view: PrView & { pr: NonNullable<PrView["pr"]> }; bare?: boolean }) {
  const [picking, setPicking] = useState(false);
  const busy = usePr((s) => s.busy);
  const n = view.pr.number;
  const live = view.pr.state === "open" || view.pr.state === "draft";
  const react = (content: (typeof REACTIONS)[number]["content"]) => (setPicking(false), void usePr.getState().act({ kind: "react", n, subjectId: c.id, content }, `Reacted ${emoji(content)}.`));
  const body = (
    <>
      <Byline login={c.author} bot={c.bot} at={c.at} extra={<LessonChip commentId={c.id} />} />
      <div className="mt-1.5 pl-[30px]">
        <CommentBody text={c.body} />
        {c.reactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.reactions.map((r) => (
              <button key={r.content} type="button" disabled={!live || !!busy} onClick={() => react(r.content)} className={cx("rounded-full border px-1.5 py-px text-[11px]", r.mine ? "border-signal/50 bg-signal/10 text-ink" : "border-hair text-dim hover:border-hair-strong")} title={r.mine ? "You reacted. Click to take it back." : "React the same"}>
                {emoji(r.content)} {r.count}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-0.5" aria-label="Comment actions">
          {live && (
            <span className="relative">
              <button type="button" className="hud-btn px-1.5" aria-label="React" title="React" onClick={() => setPicking(!picking)}>
                <SmilePlus size={11} />
              </button>
              {picking && (
                <span role="menu" className="glass solid absolute bottom-7 left-0 z-10 flex gap-0.5 rounded-[8px] p-1 shadow-[0_10px_30px_var(--shade)]">
                  {REACTIONS.map((r) => (
                    <button key={r.content} role="menuitem" type="button" title={r.word} aria-label={r.word} className="rounded-[6px] px-1 py-0.5 text-[14px] hover:bg-glass" onClick={() => react(r.content)}>
                      {r.emoji}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          <button type="button" className="hud-btn px-1.5" aria-label="Copy" title="Copy the comment" onClick={() => void navigator.clipboard.writeText(c.body).then(() => toast("Copied the comment.", "ok"))}>
            <Copy size={11} />
          </button>
          {c.url && (
            <button type="button" className="hud-btn px-1.5" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => void api().openLink(c.url!)}>
              <ExternalLink size={11} />
            </button>
          )}
          <LearnFromThis c={c} pr={n} />
          {live && (
            <button type="button" className="hud-btn ml-auto" disabled={!!busy} title="Add it to your agent's Up next: it works on this after the current run" onClick={() => void usePr.getState().agent({ kind: "queue", n, commentId: c.id }, "Added to Up next. Your agent works on it after the current run.")}>
              {busy === "agent:queue" ? <Spinner size={10} /> : <ListPlus size={11} />}
              Queue for agent
            </button>
          )}
        </div>
      </div>
    </>
  );
  if (bare) return <div data-comment={c.id}>{body}</div>;
  return (
    <article data-comment={c.id}>
      {body}
    </article>
  );
}

function ReplyBox({ n, threadId, onDone, initial = "" }: { n: number; threadId: string; onDone(): void; initial?: string }) {
  const [text, setText] = useState(initial);
  const busy = usePr((s) => s.busy);
  return (
    <div className="mt-2">
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Your reply" placeholder="Write a reply. Markdown works." className="field selectable h-auto w-full resize-y py-1.5 font-display text-[12.5px]" />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" className="btn go h-7 px-2.5" disabled={!text.trim() || !!busy} onClick={async () => (await usePr.getState().act({ kind: "reply", n, threadId, body: text }, "Reply posted.")) && onDone()}>
          {busy === `reply:${threadId}` ? <Spinner size={10} /> : null}
          Post reply
        </button>
        <button type="button" className="hud-btn" onClick={onDone}>Cancel</button>
        <span className="text-[11px] whitespace-nowrap text-faint">Asks you first</span>
      </div>
    </div>
  );
}

function Draft({ t, n, text }: { t: PrThread; n: number; text: string }) {
  const [editing, setEditing] = useState(false);
  const drop = () => usePr.setState((s) => ({ drafts: Object.fromEntries(Object.entries(s.drafts).filter(([k]) => k !== t.id)) }));
  if (editing) return <ReplyBox n={n} threadId={t.id} initial={text} onDone={() => (setEditing(false), drop())} />;
  return (
    <div className="mt-2.5 rounded-[8px] border border-violet/40 bg-violet/[0.06] p-2" aria-label="Your agent's reply">
      <span className="text-[11px] font-medium text-violet">✦ Your agent's reply</span>
      <div className="mt-1"><CommentBody text={text} /></div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button type="button" className="btn go h-7 px-2.5" onClick={async () => (await usePr.getState().act({ kind: "reply", n, threadId: t.id, body: text }, "Reply posted.")) && drop()}>
          Post reply
        </button>
        <button type="button" className="hud-btn" onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="hud-btn" onClick={drop}>Discard</button>
      </div>
    </div>
  );
}

const EVENTS = [
  { id: "COMMENT", word: "Comment" },
  { id: "APPROVE", word: "Approve" },
  { id: "REQUEST_CHANGES", word: "Request changes" },
] as const;

/** PR8: a conversation comment, or a review with a summary. */
function Compose({ view }: { view: PrView & { pr: NonNullable<PrView["pr"]> } }) {
  const [mode, setMode] = useState<null | "comment" | "review">(null);
  const [event, setEvent] = useState<(typeof EVENTS)[number]["id"]>("COMMENT");
  const [text, setText] = useState("");
  const busy = usePr((s) => s.busy);
  const n = view.pr.number;
  const mine = view.viewer && view.viewer === view.pr.author;
  if (!mode)
    return (
      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-hair pt-3">
        <button type="button" className="hud-btn solid" onClick={() => setMode("comment")}>Leave a comment</button>
        <button type="button" className="hud-btn solid" onClick={() => setMode("review")}>Submit a review</button>
      </div>
    );
  const send = async () => {
    const ok = mode === "comment" ? await usePr.getState().act({ kind: "comment", n, body: text }, "Comment posted.") : await usePr.getState().act({ kind: "review", n, event, body: text }, "Review submitted.");
    if (ok) (setText(""), setMode(null));
  };
  return (
    <div className="mt-3 border-t border-hair pt-3" aria-label={mode === "comment" ? "Leave a comment" : "Submit a review"}>
      {mode === "review" && (
        <div role="radiogroup" aria-label="Your review" className="mb-2 inline-flex h-7 overflow-hidden rounded-[8px] border border-hair">
          {EVENTS.map((e) => (
            <button key={e.id} role="radio" type="button" aria-checked={event === e.id} disabled={mine && e.id !== "COMMENT" ? true : undefined} title={mine && e.id !== "COMMENT" ? "GitHub doesn't let you approve or block your own pull request" : undefined} onClick={() => setEvent(e.id)} className={cx("px-2.5 text-[11px] disabled:opacity-40", event === e.id ? (e.id === "APPROVE" ? "bg-ok/15 text-ok" : e.id === "REQUEST_CHANGES" ? "bg-slow/15 text-slow" : "bg-glass text-ink") : "text-dim hover:text-ink")}>
              {e.word}
            </button>
          ))}
        </div>
      )}
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label={mode === "comment" ? "Your comment" : "Review summary"} placeholder={mode === "comment" ? "Write a comment. Markdown works." : event === "APPROVE" ? "Anything to add? (optional)" : "Sum up your review."} className="field selectable h-auto w-full resize-y py-1.5 font-display text-[12.5px]" />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" className="btn go h-7 px-2.5" disabled={(!text.trim() && !(mode === "review" && event === "APPROVE")) || !!busy} onClick={() => void send()}>
          {busy === "comment:" || busy === "review:" ? <Spinner size={10} /> : null}
          {mode === "comment" ? "Post comment" : EVENTS.find((e) => e.id === event)!.word}
        </button>
        <button type="button" className="hud-btn" onClick={() => setMode(null)}>Cancel</button>
        <span className="text-[11px] whitespace-nowrap text-faint">Asks you first</span>
      </div>
    </div>
  );
}
