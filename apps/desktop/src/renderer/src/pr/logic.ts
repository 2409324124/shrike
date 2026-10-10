import type { PrCheck, PrComment, PrReaction, PrReview, PrThread, PrView } from "@shrike/schema";

// PR1–PR8 view logic, pure (node:test in logic.test.ts).

export type CheckCounts = Record<PrCheck["state"], number>;

export function checkCounts(checks: PrCheck[]): CheckCounts {
  const n: CheckCounts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  for (const c of checks) n[c.state]++;
  return n;
}

/** "18 passing · 2 failing · 1 running", zero parts left out. */
export function checkLine(n: CheckCounts): string {
  const parts = [n.pass && `${n.pass} passing`, n.fail && `${n.fail} failing`, n.pending && `${n.pending} running`, n.skipped && `${n.skipped} skipped`].filter(Boolean);
  return parts.join(" · ") || "No checks yet";
}

const ORDER: PrCheck["state"][] = ["fail", "pending", "pass", "skipped"];
/** Failing first, then running, passing, skipped; names sorted inside a group. */
export function groupChecks(checks: PrCheck[]): { state: PrCheck["state"]; checks: PrCheck[] }[] {
  return ORDER.map((state) => ({ state, checks: checks.filter((c) => c.state === state).sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.checks.length);
}

export function seconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** How long a check took, or has been running. */
export function took(c: Pick<PrCheck, "startedAt" | "completedAt" | "state">, now = Date.now()): string | undefined {
  if (!c.startedAt) return undefined;
  const end = c.completedAt ? Date.parse(c.completedAt) : c.state === "pending" ? now : NaN;
  const s = Math.round((end - Date.parse(c.startedAt)) / 1000);
  return Number.isFinite(s) && s >= 0 ? seconds(s) : undefined;
}

export function ago(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export type Who = "all" | "people" | "bots";
export type FeedItem = { kind: "thread"; at: string; thread: PrThread } | { kind: "comment"; at: string; comment: PrComment } | { kind: "review"; at: string; review: PrReview };

const by = (w: Who, bot: boolean) => w === "all" || (w === "bots") === bot;

/** Reviews, review threads and conversation comments in time order. A thread belongs to whoever started it. */
export function feed(v: Pick<PrView, "threads" | "comments" | "reviews">, who: Who): FeedItem[] {
  const items: FeedItem[] = [
    ...v.reviews.filter((r) => by(who, r.bot)).map((review) => ({ kind: "review" as const, at: review.at ?? "", review })),
    ...v.threads.filter((t) => t.comments[0] && by(who, t.comments[0].bot)).map((thread) => ({ kind: "thread" as const, at: thread.comments[0]!.at, thread })),
    ...v.comments.filter((c) => by(who, c.bot)).map((comment) => ({ kind: "comment" as const, at: comment.at, comment })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export function whoCounts(v: Pick<PrView, "threads" | "comments" | "reviews">): Record<Who, number> {
  return { all: feed(v, "all").length, people: feed(v, "people").length, bots: feed(v, "bots").length };
}

/** PR6: open conversations against resolved ones. */
export function reviewProgress(threads: PrThread[]): { resolved: number; open: number; total: number } {
  const resolved = threads.filter((t) => t.resolved).length;
  return { resolved, open: threads.length - resolved, total: threads.length };
}

/** PR7: comment counts per file, in project paths (the repo prefix stripped), for the source control file list. */
export function fileComments(threads: PrThread[], prefix = ""): Record<string, { open: number; resolved: number }> {
  const out: Record<string, { open: number; resolved: number }> = {};
  for (const t of threads) {
    if (prefix && !t.path.startsWith(prefix)) continue;
    const p = t.path.slice(prefix.length);
    const e = (out[p] ??= { open: 0, resolved: 0 });
    e[t.resolved ? "resolved" : "open"]++;
  }
  return out;
}

/** The agent's last message after "Fix all open comments": `REPLY <thread id>: text` lines, text running on until the next REPLY. */
export function parseReplies(text: string, ids: string[]): Record<string, string> {
  const known = new Set(ids);
  const out: Record<string, string> = {};
  let cur: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*`?REPLY\s+`?([\w=-]+)`?\s*:\s*(.*)$/.exec(raw);
    if (m) {
      cur = known.has(m[1]!) ? m[1]! : undefined;
      if (cur) out[cur] = m[2]!.trim();
    } else if (cur && raw.trim()) out[cur] += `\n${raw.trim()}`;
    else if (cur && !raw.trim()) cur = undefined;
  }
  for (const k of Object.keys(out)) if (!out[k]!.trim()) delete out[k];
  return out;
}

export const REACTIONS: { content: PrReaction; emoji: string; word: string }[] = [
  { content: "THUMBS_UP", emoji: "👍", word: "Thumbs up" },
  { content: "THUMBS_DOWN", emoji: "👎", word: "Thumbs down" },
  { content: "LAUGH", emoji: "😄", word: "Laugh" },
  { content: "HOORAY", emoji: "🎉", word: "Hooray" },
  { content: "CONFUSED", emoji: "😕", word: "Confused" },
  { content: "HEART", emoji: "❤️", word: "Heart" },
  { content: "ROCKET", emoji: "🚀", word: "Rocket" },
  { content: "EYES", emoji: "👀", word: "Eyes" },
];
export const emoji = (c: PrReaction): string => REACTIONS.find((r) => r.content === c)?.emoji ?? "";

/** Ring segments (PR2): fractions of the circle per state, failing first so it reads at 12 o'clock. */
export function ringParts(n: CheckCounts): { state: PrCheck["state"]; from: number; to: number }[] {
  const total = n.pass + n.fail + n.pending + n.skipped;
  if (!total) return [];
  let at = 0;
  return ORDER.filter((s) => n[s]).map((state) => {
    const from = at;
    at += n[state] / total;
    return { state, from, to: at };
  });
}
