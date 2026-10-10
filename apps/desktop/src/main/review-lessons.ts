import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { z } from "zod";
import type { AgentRunInfo, LearnComment, ReviewExample, ReviewLesson, ReviewLessonsView, ReviewerProfile, SelfCheck, SelfReviewResult } from "@shrike/schema";
import { ghError, ghStatus, GH_SETUP, type Exec, type Gh } from "./github.ts";
import { isBot } from "./pr.ts";
import { proposeUpdate, settleNow, type SkillDirs } from "./skills.ts";
import { checkLine, MASTER_AT, rankOfClean, severity, trendOf, type Severity } from "../renderer/src/lessons/review/logic.ts";

// RL1–RL9: review lessons and reviewer profiles. Reads your PRs' review threads through gh (never writes to GitHub),
// one read-only brain call clusters them, and the lessons live in <project>/.shrike/skills/review-lessons.md behind the S4 gate.

export const SKILL_ID = "review-lessons";
export const DEFAULT_LIMIT = 50;
const PAGE = 10;
const MAX_FRESH = 150; // new items per brain call
const MAX_RETRY = 60; // earlier items that fit nothing yet, sent again as context
const MAX_PATCHES = 30; // fixing-commit patches fetched per refresh
const SPARK = 12;

// ---- reading (RL1) ----

const C = "id body createdAt url diffHunk author{login __typename}";
export const MINE_QUERY = `query($q:String!,$n:Int!,$after:String){viewer{login} search(query:$q,type:ISSUE,first:$n,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number title url state createdAt updatedAt reviewThreads(first:60){nodes{id isResolved path line originalLine resolvedBy{login} comments(first:12){nodes{${C}}}}} reviews(first:40){nodes{id state body submittedAt url author{login __typename}}} commits(last:40){nodes{commit{oid messageHeadline committedDate}}}}}}}`;

type Author = { login: string; __typename?: string } | null;
interface RawComment { id: string; body?: string; createdAt: string; url?: string; diffHunk?: string; author: Author }
interface RawPr {
  number?: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  reviewThreads?: { nodes: { id: string; isResolved: boolean; path: string; line?: number | null; originalLine?: number | null; resolvedBy?: { login: string } | null; comments: { nodes: RawComment[] } }[] };
  reviews?: { nodes: { id: string; state: string; body?: string; submittedAt?: string | null; url?: string; author: Author }[] };
  commits?: { nodes: { commit: { oid: string; messageHeadline: string; committedDate: string } }[] };
}
export interface RawSearch {
  data?: { viewer?: { login: string }; search?: { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: RawPr[] } };
}

interface Cm { id: string; author: string; bot: boolean; body: string; at: string; url?: string; hunk?: string }
export interface PrRec {
  number: number;
  title: string;
  url: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  threads: { id: string; path: string; line?: number; resolved: boolean; resolvedBy?: string; comments: Cm[] }[];
  reviews: { id: string; author: string; bot: boolean; state: string; body: string; at?: string; url?: string }[];
  commits: { oid: string; headline: string; at: string }[];
}

const who = (a: Author) => a?.login ?? "ghost";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** gh api graphql search → your PRs, bodies redacted. */
export function parseSearch(raw: RawSearch, redact: (s: string) => string): { viewer?: string; prs: PrRec[]; next?: string } {
  const s = raw.data?.search;
  const prs = (s?.nodes ?? []).filter((p): p is RawPr & { number: number } => typeof p?.number === "number").map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    threads: (p.reviewThreads?.nodes ?? []).map((t) => ({
      id: t.id,
      path: t.path,
      ...((t.line ?? t.originalLine) ? { line: (t.line ?? t.originalLine)! } : {}),
      resolved: t.isResolved,
      ...(t.resolvedBy?.login ? { resolvedBy: t.resolvedBy.login } : {}),
      comments: t.comments.nodes.map((c) => ({ id: c.id, author: who(c.author), bot: isBot(who(c.author), c.author?.__typename), body: redact(clip(c.body ?? "", 4000)), at: c.createdAt, ...(c.url ? { url: c.url } : {}), ...(c.diffHunk ? { hunk: redact(clip(c.diffHunk, 800)) } : {}) })),
    })),
    reviews: (p.reviews?.nodes ?? []).map((r) => ({ id: r.id, author: who(r.author), bot: isBot(who(r.author), r.author?.__typename), state: r.state, body: redact(clip(r.body ?? "", 4000)), ...(r.submittedAt ? { at: r.submittedAt } : {}), ...(r.url ? { url: r.url } : {}) })),
    commits: (p.commits?.nodes ?? []).map((c) => ({ oid: c.commit.oid, headline: redact(clip(c.commit.messageHeadline, 200)), at: c.commit.committedDate })),
  }));
  return { ...(raw.data?.viewer?.login ? { viewer: raw.data.viewer.login } : {}), prs, ...(s?.pageInfo.hasNextPage && s.pageInfo.endCursor ? { next: s.pageInfo.endCursor } : {}) };
}

export interface Item {
  id: string; // the thread's first comment, or the review
  pr: number;
  kind: "thread" | "review";
  reviewer: string;
  bot: boolean;
  at: string;
  body: string;
  url?: string;
  path?: string;
  line?: number;
  resolved?: boolean;
  resolvedBy?: string;
  hunk?: string;
  reply?: string; // your answer in the thread
  severity: Severity;
  fix?: { sha: string; headline: string; patch?: string }; // the first commit after it, for a resolved thread
}

const NOISE = /^(vercel|netlify|codecov|github-actions|changeset-bot|sonarcloud|sonarqubecloud|linear|sentry-io)(\[bot\])?$/i;

/** RL1: every thread a reviewer started and every review with a written body. Yours, deploy bots and ghosts aren't. */
export function itemsOf(prs: readonly PrRec[], viewer: string, patches: Record<string, string> = {}): Item[] {
  const out: Item[] = [];
  const reviewer = (login: string) => login !== viewer && login !== "ghost" && !NOISE.test(login);
  for (const p of prs) {
    for (const t of p.threads) {
      const first = t.comments[0];
      if (!first || !reviewer(first.author) || !first.body.trim()) continue;
      const reply = t.comments.find((c) => c.author === viewer)?.body;
      const after = t.resolved ? p.commits.find((c) => Date.parse(c.at) > Date.parse(first.at)) : undefined;
      const patch = after ? patches[`${after.oid}:${t.path}`] : undefined;
      out.push({
        id: first.id, pr: p.number, kind: "thread", reviewer: first.author, bot: first.bot, at: first.at, body: first.body,
        ...(first.url ? { url: first.url } : {}), path: t.path, ...(t.line ? { line: t.line } : {}), resolved: t.resolved, ...(t.resolvedBy ? { resolvedBy: t.resolvedBy } : {}),
        ...(first.hunk ? { hunk: first.hunk } : {}), ...(reply ? { reply: clip(reply, 300) } : {}), severity: severity(first.body),
        ...(after ? { fix: { sha: after.oid, headline: after.headline, ...(patch ? { patch } : {}) } } : {}),
      });
    }
    for (const r of p.reviews) {
      if (!reviewer(r.author) || r.body.trim().length < 20 || (r.state !== "CHANGES_REQUESTED" && r.state !== "COMMENTED")) continue;
      out.push({ id: r.id, pr: p.number, kind: "review", reviewer: r.author, bot: r.bot, at: r.at ?? p.updatedAt, body: r.body, ...(r.url ? { url: r.url } : {}), severity: severity(r.body, r.state) });
    }
  }
  return out;
}

// ---- clustering (RL2): one read-only brain call ----

export interface StoredLesson {
  id: string;
  title: string;
  spot: string;
  fix: string[];
  items: string[];
  since: number; // when Shrike first learned it
  learnedAt: number; // when its fix steps were last written
  notWorking?: boolean; // flagged again after its fix was written
  rewrite?: boolean; // the brain still has to rewrite its fix
}

const day = (t: number | string) => new Date(t).toISOString().slice(0, 10);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The prompt, with short aliases (c1, c2) for item ids so the answer stays small. */
export function clusterAsk(o: { guide: string; repo: string; viewer: string; lessons: readonly StoredLesson[]; items: readonly Item[]; learn: ReadonlySet<string>; earlier: readonly Item[]; reviewers: readonly { login: string; comments: number }[] }): { prompt: string; alias: Map<string, string> } {
  const alias = new Map<string, string>();
  const line = (i: Item) => {
    const a = `c${alias.size + 1}`;
    alias.set(a, i.id);
    const where = i.path ? ` ${i.path}${i.line ? `:${i.line}` : ""}` : " (review summary)";
    const fix = i.fix ? ` | fixed by ${i.fix.sha.slice(0, 7)} "${i.fix.headline}"${i.fix.patch ? `\n    patch: ${clip(oneLine(i.fix.patch), 400)}` : ""}` : "";
    return `[${a}]${o.learn.has(i.id) ? " LEARN" : ""} #${i.pr} ${day(i.at)} @${i.reviewer}${i.bot ? " (bot)" : ""} ${i.severity}${where}: ${clip(oneLine(i.body), 420)}${i.reply ? `\n    your reply: ${clip(oneLine(i.reply), 160)}` : ""}${fix}`;
  };
  const guide = /## How Shrike clusters[\s\S]*/.exec(o.guide)?.[0] ?? o.guide;
  const lessons = o.lessons.length
    ? o.lessons.map((l) => `- id: ${l.id} | ${l.title} | written ${day(l.learnedAt)} | ${l.items.length} comments${l.rewrite ? " | NOT WORKING YET: rewrite its fix" : ""}\n  spot: ${l.spot}\n  fix: ${l.fix.join(" / ")}`).join("\n")
    : "(none yet)";
  const prompt = [
    `Cluster these pull request review comments into lessons. Read only: don't call any tool, don't change files. The comments were left on @${o.viewer}'s pull requests in ${o.repo}.`,
    guide.trim(),
    `Existing lessons (keep their ids; a comment newer than "written" means its fix didn't work, so rewrite the fix):\n${lessons}`,
    `New comments:\n${o.items.map(line).join("\n") || "(none)"}`,
    o.earlier.length ? `Earlier comments that fit no lesson yet (group them with new ones when alike):\n${o.earlier.map(line).join("\n")}` : "",
    `Reviewers to profile: ${o.reviewers.map((r) => `@${r.login} (${r.comments} comments)`).join(", ") || "(none)"}`,
  ].filter(Boolean).join("\n\n");
  return { prompt, alias };
}

const Out = z.object({
  lessons: z.array(z.object({ id: z.string().max(80).optional(), title: z.string().min(1).max(120), spot: z.string().max(400).default(""), fix: z.array(z.string().max(300)).max(8).default([]), comments: z.array(z.string().max(40)).max(400).default([]) })).max(30).default([]),
  reviewers: z.array(z.object({ login: z.string().min(1).max(60), style: z.array(z.string().max(240)).max(5).default([]), habit: z.string().max(240).optional() })).max(20).default([]),
});
export type ClusterOut = z.infer<typeof Out>;

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** The JSON block of the brain's answer, item aliases mapped back. Null when there's none. */
export function parseCluster(text: string, alias: ReadonlyMap<string, string>): ClusterOut | null {
  const fence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const body = fence ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  const r = Out.safeParse(v);
  if (!r.success) return null;
  return { ...r.data, lessons: r.data.lessons.map((l) => ({ ...l, comments: l.comments.flatMap((c) => alias.get(c.trim()) ?? []) })) };
}

/** Adds the answer to the lessons. Returns the lessons flagged again after their fix was written. */
export function mergeCluster(lessons: StoredLesson[], out: ClusterOut, items: ReadonlyMap<string, Item>, learn: ReadonlySet<string>, now: number): Set<string> {
  const owner = new Map<string, string>();
  for (const l of lessons) for (const id of l.items) owner.set(id, l.id);
  const again = new Set<string>();
  for (const o of out.lessons) {
    const fresh = [...new Set(o.comments)].filter((id) => items.has(id) && !owner.has(id));
    let l = lessons.find((x) => x.id === o.id);
    if (!l) {
      if (fresh.length < 2 && !fresh.some((id) => learn.has(id))) continue;
      let id = slug(o.id || o.title) || "lesson";
      for (let n = 2; lessons.some((x) => x.id === id); n++) id = `${slug(o.id || o.title) || "lesson"}-${n}`;
      l = { id, title: oneLine(o.title), spot: oneLine(o.spot), fix: o.fix.map(oneLine).filter(Boolean), items: [], since: now, learnedAt: now };
      lessons.push(l);
    } else {
      if (fresh.some((id) => Date.parse(items.get(id)!.at) > l!.learnedAt)) (again.add(l.id), (l.notWorking = true), (l.rewrite = true));
      const fix = o.fix.map(oneLine).filter(Boolean);
      if (l.rewrite && fix.length && fix.join("\n") !== l.fix.join("\n")) Object.assign(l, { fix, learnedAt: now, rewrite: false });
    }
    for (const id of fresh) (l.items.push(id), owner.set(id, l.id));
  }
  return again;
}

// ---- the view (RL3, RL7, RL8) ----

export interface Cache {
  repo: string;
  viewer?: string;
  limit: number;
  prs: Record<string, PrRec>;
  patches: Record<string, string>; // "<sha>:<path>" → that file's patch ("" when there was none)
  lessons: StoredLesson[];
  reviewers: Record<string, { style: string[]; habit?: string }>;
  asked: string[]; // items the brain has seen
  learn: Item[]; // RL8 Learn from this
  pending?: { at: number; lessons: string[]; open: string[] }; // RL4: what the newest draft is about
  key?: string; // the substance the skill last got
  drafted?: { id: string; title: string; fix: string; status: string }[];
  mastered: string[]; // RL9: once each
  minedAt?: number;
  check?: SelfCheck;
}

export const emptyCache = (repo: string): Cache => ({ repo, limit: DEFAULT_LIMIT, prs: {}, patches: {}, lessons: [], reviewers: {}, asked: [], learn: [], mastered: [] });

const byCreated = (a: { createdAt: string }, b: { createdAt: string }) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** PRs someone else reviewed (a thread or a review), oldest first. */
export function reviewedPrs(c: Cache): PrRec[] {
  const v = c.viewer;
  return Object.values(c.prs).filter((p) => p.threads.some((t) => t.comments[0] && t.comments[0].author !== v) || p.reviews.some((r) => r.author !== v)).sort(byCreated);
}

export function allItems(c: Cache): Item[] {
  const mined = itemsOf(Object.values(c.prs), c.viewer ?? "", c.patches);
  const ids = new Set(mined.map((i) => i.id));
  return [...mined, ...c.learn.filter((i) => !ids.has(i.id))];
}

interface Stat extends ReviewLesson {
  afterLearn: number; // reviewed PRs opened after both its last time and when Shrike learned it
}

export function lessonStats(c: Cache, items: ReadonlyMap<string, Item>): Stat[] {
  const reviewed = reviewedPrs(c);
  const recent = reviewed.slice(-SPARK);
  const created = new Map(reviewed.map((p) => [p.number, Date.parse(p.createdAt)]));
  const pending = new Set(c.pending?.lessons ?? []);
  return c.lessons
    .map((l): Stat => {
      const its = l.items.flatMap((id) => items.get(id) ?? []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const prs = [...new Set(its.map((i) => i.pr))];
      const last = Math.max(0, ...its.map((i) => created.get(i.pr) ?? Date.parse(i.at))); // a PR outside the cache (a teammate's, via Learn from this): the comment's own time
      const clean = reviewed.filter((p) => Date.parse(p.createdAt) > last).length;
      const afterLearn = reviewed.filter((p) => Date.parse(p.createdAt) > Math.max(last, l.since)).length;
      const counts = new Map<string, number>();
      for (const i of its) counts.set(i.reviewer, (counts.get(i.reviewer) ?? 0) + 1);
      const spark = recent.map((p) => its.filter((i) => i.pr === p.number).length);
      const mastered = afterLearn >= MASTER_AT; // RL9: only quiet since Shrike learned it counts, like the window
      return {
        id: l.id, title: l.title, spot: l.spot, fix: l.fix, count: its.length, prs, reviewers: [...counts].sort((a, b) => b[1] - a[1]).map(([r]) => r),
        trend: trendOf(spark), spark, clean, rank: rankOfClean(clean), status: mastered ? "mastered" : l.notWorking ? "not-working" : "learning", ...(pending.has(l.id) ? { pending: true } : {}),
        examples: its.slice(0, 5).map((i): ReviewExample => ({ commentId: i.id, pr: i.pr, ...(i.url ? { url: i.url } : {}), ...(i.path ? { path: i.path } : {}), ...(i.line ? { line: i.line } : {}), reviewer: i.reviewer, at: i.at, quote: clip(oneLine(i.body.replace(/[*_`#>]/g, "")), 200) })),
        afterLearn,
      };
    })
    .filter((l) => l.count > 0)
    .sort((a, b) => Number(a.status === "mastered") - Number(b.status === "mastered") || b.count - a.count);
}

export function reviewerProfiles(c: Cache, items: readonly Item[], lessons: readonly ReviewLesson[]): ReviewerProfile[] {
  const reviewed = reviewedPrs(c);
  const owner = new Map<string, ReviewLesson>();
  for (const s of c.lessons) {
    const l = lessons.find((x) => x.id === s.id);
    if (l) for (const id of s.items) owner.set(id, l);
  }
  const logins = new Set([...items.map((i) => i.reviewer), ...reviewed.flatMap((p) => p.reviews.map((r) => r.author))].filter((l) => l !== c.viewer && l !== "ghost" && !NOISE.test(l)));
  const out: ReviewerProfile[] = [];
  for (const login of logins) {
    const mine = items.filter((i) => i.reviewer === login);
    const reviews = reviewed.flatMap((p) => p.reviews.filter((r) => r.author === login));
    const prs = reviewed.filter((p) => mine.some((i) => i.pr === p.number) || p.reviews.some((r) => r.author === login));
    if (mine.length < 3 && prs.length < 2) continue;
    const perPr = prs.map((p) => mine.filter((i) => i.pr === p.number).length).slice(-10);
    const sev = (s: Severity) => mine.filter((i) => i.severity === s).length;
    const concerns = new Map<string, { lessonId: string; title: string; count: number }>();
    for (const i of mine) {
      const l = owner.get(i.id);
      if (l) concerns.set(l.id, { lessonId: l.id, title: l.title, count: (concerns.get(l.id)?.count ?? 0) + 1 });
    }
    const p = c.reviewers[login];
    out.push({
      login, bot: mine[0]?.bot ?? reviews[0]?.bot ?? isBot(login), prs: prs.length, comments: mine.length, perPr, trend: trendOf(perPr),
      blocking: sev("blocking"), nits: sev("nit"), questions: sev("question"), notes: sev("note"),
      approvals: reviews.filter((r) => r.state === "APPROVED").length, changes: reviews.filter((r) => r.state === "CHANGES_REQUESTED").length,
      concerns: [...concerns.values()].sort((a, b) => b.count - a.count).slice(0, 4), style: p?.style ?? [], ...(p?.habit ? { habit: p.habit } : {}),
    });
  }
  return out.sort((a, b) => Number(a.bot) - Number(b.bot) || b.comments - a.comments || b.prs - a.prs).slice(0, 8);
}

export function viewOf(c: Cache): Omit<ReviewLessonsView, "ready"> & { stats: Stat[] } {
  const items = allItems(c);
  const byId = new Map(items.map((i) => [i.id, i]));
  const stats = lessonStats(c, byId);
  const lessons = stats.map(({ afterLearn: _a, ...l }) => l);
  const owner = new Map<string, string>();
  for (const l of c.lessons) for (const id of l.items) owner.set(id, l.id);
  const byComment: ReviewLessonsView["byComment"] = {};
  for (const l of c.lessons) {
    const title = lessons.find((x) => x.id === l.id)?.title ?? l.title;
    l.items.flatMap((id) => byId.get(id) ?? []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).forEach((i, n) => (byComment[i.id] = { lessonId: l.id, nth: n + 1, title }));
  }
  const reviewed = reviewedPrs(c);
  return {
    repo: c.repo, ...(c.viewer ? { viewer: c.viewer } : {}), limit: c.limit, prs: Object.keys(c.prs).length, reviewed: reviewed.length, ...(c.minedAt ? { minedAt: c.minedAt } : {}),
    lessons, reviewers: reviewerProfiles(c, items, lessons),
    burn: reviewed.slice(-SPARK).map((p) => ({ pr: p.number, flagged: items.filter((i) => i.pr === p.number && owner.has(i.id)).length })),
    byComment, ...(c.check ? { check: c.check } : {}), stats,
  };
}

// ---- the skill (RL4) ----

const quote = (s: string) => s.replace(/"/g, "'");

export function renderBody(c: Cache, v: Pick<ReviewLessonsView, "lessons" | "reviewers" | "prs" | "reviewed">): string {
  const out = [
    "# Review lessons",
    "",
    `What reviewers keep flagging in @${c.viewer ?? "you"}'s pull requests on ${c.repo} (${v.prs} PRs read, ${v.reviewed} reviewed). Before you change code or open a pull request here, check your work against every lesson, follow each reviewer's conventions, then call \`self_review\`.`,
  ];
  for (const l of v.lessons) {
    out.push("", `## Lesson: ${l.title}`, `<!-- lesson:${l.id} -->`, `Flagged ${l.count === 1 ? "once" : `${l.count} times`} in ${l.prs.length === 1 ? "1 PR" : `${l.prs.length} PRs`}${l.reviewers.length ? ` by ${l.reviewers.map((r) => `@${r}`).join(", ")}` : ""}. Last in #${l.prs[0]}.`);
    if (l.status === "not-working") out.push("Status: not working yet. It was flagged again after this fix was written.");
    else if (l.status === "mastered") out.push(`Status: mastered. Not flagged in the last ${l.clean} reviewed PRs.`);
    if (l.spot) out.push("", `Spot it: ${l.spot}`);
    if (l.fix.length) out.push("", "Fix it:", ...l.fix.map((f, i) => `${i + 1}. ${f}`));
    if (l.examples.length) out.push("", "Examples:", ...l.examples.slice(0, 3).map((e) => `- #${e.pr}${e.path ? ` ${e.path}${e.line ? `:${e.line}` : ""}` : ""} (@${e.reviewer}): "${quote(clip(e.quote, 140))}"${e.url ? ` ${e.url}` : ""}`));
  }
  for (const r of v.reviewers) {
    const mostly = r.blocking >= r.nits + r.questions ? "mostly blocking" : r.nits > r.questions ? "mostly nits" : "mostly questions";
    out.push("", `## Reviewer: @${r.login}${r.bot ? " (bot)" : ""}`, `Reviewed ${r.prs} of these PRs, about ${Math.max(1, Math.round(r.comments / Math.max(1, r.prs)))} comments a PR, ${mostly}; approved ${r.approvals}, asked for changes ${r.changes}.${r.concerns.length ? ` Raises most: ${r.concerns.map((x) => `${x.title} (${x.count})`).join(", ")}.` : ""}`);
    for (const s of r.style) out.push(`- ${s}`);
    if (r.habit) out.push(`- How they review: ${r.habit}`);
  }
  return out.join("\n");
}

export const frontOf = (c: Cache, n: number): string =>
  `---\nname: Review lessons\nwhen: Before you change code or open a pull request in this repo: the ${n === 1 ? "issue" : `${n} issues`} reviewers keep flagging in ${c.viewer ? `@${c.viewer}'s` : "your"} pull requests, and how to fix them before they do\nversion: 1\n---\n\n`;

/** What counts as a change to the skill: lessons and their fix steps, statuses, reviewer conventions. Counts don't. */
export const substance = (c: Cache, v: Pick<ReviewLessonsView, "lessons">): string =>
  JSON.stringify([v.lessons.map((l) => [l.id, l.title, l.spot, l.fix, l.status]), Object.entries(c.reviewers).sort(([a], [b]) => a.localeCompare(b))]);

function reasonOf(before: Cache["drafted"], v: Pick<ReviewLessonsView, "lessons">): string {
  const was = new Map((before ?? []).map((d) => [d.id, d]));
  const added = v.lessons.filter((l) => !was.has(l.id)).map((l) => l.title);
  const rewritten = v.lessons.filter((l) => was.has(l.id) && was.get(l.id)!.fix !== l.fix.join("\n")).map((l) => l.title);
  const mastered = v.lessons.filter((l) => l.status === "mastered" && was.get(l.id)?.status !== "mastered").map((l) => l.title);
  const parts = [
    added.length ? `${added.length === 1 ? "a new lesson" : `${added.length} new lessons`}: ${added.slice(0, 3).join(", ")}` : "",
    rewritten.length ? `rewrote how to fix ${rewritten.slice(0, 2).join(" and ")}` : "",
    mastered.length ? `${mastered.slice(0, 2).join(" and ")} stopped coming up` : "",
  ].filter(Boolean);
  return parts.join("; ") || "reviewer conventions";
}

// ---- self-check (RL5, RL6) ----

/** What the self-check covers: every lesson not mastered and every one flagged in the recent reviewed PRs (mastered last), their reviewers' first. */
export const checkList = (lessons: readonly ReviewLesson[], theirs: ReadonlySet<string>): ReviewLesson[] =>
  lessons
    .filter((l) => l.status !== "mastered" || l.spark.some(Boolean))
    .sort((a, b) => Number(a.status === "mastered") - Number(b.status === "mastered") || Number(b.reviewers.some((r) => theirs.has(r))) - Number(a.reviewers.some((r) => theirs.has(r))) || b.count - a.count)
    .slice(0, 12);

/** CODEOWNERS owners of these repo paths (the last matching rule wins, as on GitHub), without the @. */
export function codeowners(text: string, files: readonly string[]): string[] {
  const rules = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean).map((l) => {
    const [pat, ...owners] = l.split(/\s+/);
    let g = pat!;
    if (g.endsWith("/")) g += "**";
    if (!g.includes("/") || g === "*") g = `**/${g}`;
    else g = g.replace(/^\//, "");
    return { glob: g, dir: `${g}/**`, owners: owners.filter((o) => o.startsWith("@")).map((o) => o.slice(1)) };
  });
  const out = new Set<string>();
  for (const f of files) {
    const hit = rules.findLast((r) => matchesGlob(f, r.glob) || matchesGlob(f, r.dir));
    for (const o of hit?.owners ?? []) out.add(o);
  }
  return [...out];
}

export function checkAsk(o: { lessons: readonly ReviewLesson[]; reviewers: readonly ReviewerProfile[]; files: readonly string[]; diff: string }): string {
  return [
    "Check this change against the review lessons below before its pull request opens. Read only: don't call any tool, don't change files.",
    `Likely reviewers: ${o.reviewers.map((r) => `@${r.login}${r.style.length ? ` (${r.style.join("; ")})` : ""}`).join(", ") || "unknown"}`,
    `Lessons:\n${o.lessons.map((l, i) => `[L${i + 1}] ${l.title}. Spot it: ${l.spot || l.fix[0] || l.title}`).join("\n")}`,
    `The change (${o.files.length} files: ${o.files.slice(0, 40).join(", ")}):\n${o.diff}`,
    "For each lesson, does the change repeat that issue? End with one line per lesson, exactly: `FOUND L1: <file:line> <what, in plain words>` or `CLEAN L1`.",
  ].join("\n\n");
}

export function parseCheck(text: string, lessons: readonly ReviewLesson[]): SelfCheck["found"] {
  const out: SelfCheck["found"] = [];
  for (const m of text.matchAll(/^\W*FOUND\s+L(\d+)\s*:?\s*(.*)$/gim)) {
    const l = lessons[Number(m[1]) - 1];
    if (l && !out.some((f) => f.lessonId === l.id)) out.push({ lessonId: l.id, title: l.title, ...(m[2]?.trim() ? { where: clip(m[2].trim().replace(/`/g, ""), 200) } : {}) });
  }
  return out;
}

// ---- the service ----

export interface LessonsDeps {
  root(): string | undefined;
  gh: Gh;
  exec: Exec; // git, reads only
  dir: string; // userData/review-lessons
  skills(): SkillDirs;
  skillsChanged(): Promise<void>; // the shelf and the System see the new file
  guide(): Promise<string>; // prompts/skills/review-lessons.md
  ask(prompt: string): Promise<string>; // one-shot, read-only brain; rejects when there's none
  startAgent(goal: string): Promise<AgentRunInfo>;
  redact(text: string): string;
  emit(v: ReviewLessonsView): void;
  mastered(m: { lessonId: string; title: string; clean: number; key: string }): void; // RL9 window and XP
}

const json = <T>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

export function createReviewLessons(deps: LessonsDeps) {
  const repos = new Map<string, string>(); // root → owner/name
  const caches = new Map<string, Cache>();
  let ready: { at: number; v: Awaited<ReturnType<typeof ghStatus>> } | undefined;
  let job: Promise<ReviewLessonsView> | undefined;
  let checking: Promise<SelfCheck | null> | undefined;
  let busy: ReviewLessonsView["busy"];

  const need = (): string => {
    const r = deps.root();
    if (!r) throw new Error("Open a project first.");
    return r;
  };
  const file = (repo: string) => join(deps.dir, `${createHash("sha1").update(repo).digest("hex").slice(0, 16)}.json`);

  async function load(repo: string): Promise<Cache> {
    const had = caches.get(repo);
    if (had) return had;
    const v = json<Partial<Cache>>(await readFile(file(repo), "utf8").catch(() => ""));
    const c: Cache = { ...emptyCache(repo), ...(v && typeof v === "object" && v.repo === repo ? v : {}) };
    caches.set(repo, c);
    return c;
  }
  async function save(c: Cache): Promise<void> {
    await mkdir(deps.dir, { recursive: true });
    const tmp = `${file(c.repo)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(c));
    await rename(tmp, file(c.repo));
  }

  async function repoOf(root: string): Promise<{ repo?: string; problem?: string }> {
    if (!ready || Date.now() - ready.at > (ready.v.ready ? 300_000 : 15_000)) ready = { at: Date.now(), v: await ghStatus(deps.gh, root) };
    if (!ready.v.ready) return { problem: GH_SETUP[ready.v.problem ?? "missing"] };
    const known = repos.get(root);
    if (known) return { repo: known };
    const r = await deps.gh.run(["repo", "view", "--json", "nameWithOwner"], { cwd: root });
    const repo = r.code === 0 ? json<{ nameWithOwner?: string }>(r.stdout)?.nameWithOwner : undefined;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { problem: "This project isn't a GitHub repository, so there are no pull request reviews to learn from." };
    repos.set(root, repo);
    return { repo };
  }

  function publish(c: Cache | undefined, extra: Partial<ReviewLessonsView> = {}): ReviewLessonsView {
    const { stats: _s, ...v } = c ? viewOf(c) : { lessons: [], reviewers: [], burn: [], byComment: {}, limit: DEFAULT_LIMIT, prs: 0, reviewed: 0, stats: [] };
    const out: ReviewLessonsView = { ready: !!c, ...v, ...(busy ? { busy } : {}), ...extra };
    deps.emit(out);
    return out;
  }

  async function current(): Promise<{ root: string; c?: Cache; problem?: string }> {
    const root = need();
    const { repo, problem } = await repoOf(root);
    return repo ? { root, c: await load(repo) } : { root, ...(problem ? { problem } : {}) };
  }

  async function view(): Promise<ReviewLessonsView> {
    const { c, problem } = await current();
    const out = publish(c, problem ? { problem } : {});
    return out;
  }

  /** RL1: one page at a time, newest update first; a page with nothing new ends it once enough PRs are known. */
  async function mine(root: string, c: Cache): Promise<void> {
    const q = `repo:${c.repo} is:pr author:@me sort:updated-desc`;
    let after: string | undefined;
    let seen = 0;
    while (seen < c.limit) {
      const r = await deps.gh.run(["api", "graphql", "-f", `query=${MINE_QUERY}`, "-f", `q=${q}`, "-F", `n=${Math.min(PAGE, c.limit - seen)}`, ...(after ? ["-f", `after=${after}`] : [])], { cwd: root });
      const page = json<RawSearch>(r.stdout); // gh exits non-zero on partial GraphQL errors but still prints the data
      if (!page?.data?.search) throw new Error(r.code !== 0 && r.stderr.trim() ? ghError({ ...r, stdout: "" }, "Couldn't read your pull requests") : "Couldn't read your pull requests: GitHub's answer didn't come through whole. Try Refresh.");
      const p = parseSearch(page, deps.redact);
      if (p.viewer) c.viewer = p.viewer;
      let same = 0;
      for (const pr of p.prs) {
        if (c.prs[pr.number]?.updatedAt === pr.updatedAt) same++;
        c.prs[pr.number] = pr;
      }
      seen += p.prs.length;
      if (!p.next || !p.prs.length || (same === p.prs.length && Object.keys(c.prs).length >= c.limit)) break;
      after = p.next;
    }
    const keep = Object.values(c.prs).sort(byCreated).slice(-c.limit);
    c.prs = Object.fromEntries(keep.map((p) => [p.number, p]));
    c.minedAt = Date.now();
  }

  /** The fixing commit's patch for a thread's file: the local clone first, else GitHub (a read). */
  async function patches(root: string, c: Cache): Promise<void> {
    const top = (await deps.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim() || root;
    const want = itemsOf(Object.values(c.prs), c.viewer ?? "", c.patches).filter((i) => i.fix && i.path && !((`${i.fix.sha}:${i.path}`) in c.patches)).slice(-MAX_PATCHES);
    for (const i of want) {
      const key = `${i.fix!.sha}:${i.path}`;
      let patch = "";
      const local = await deps.exec("git", ["show", "--format=", "--no-color", "-U2", i.fix!.sha, "--", i.path!], { cwd: top });
      if (local.code === 0 && local.stdout.trim()) patch = local.stdout;
      else {
        const r = await deps.gh.run(["api", `repos/${c.repo}/commits/${i.fix!.sha}`], { cwd: root });
        patch = (r.code === 0 ? json<{ files?: { filename: string; patch?: string }[] }>(r.stdout)?.files?.find((f) => f.filename === i.path)?.patch : undefined) ?? "";
      }
      c.patches[key] = deps.redact(clip(patch, 1500));
    }
  }

  async function cluster(c: Cache): Promise<Set<string>> {
    const items = allItems(c);
    const byId = new Map(items.map((i) => [i.id, i]));
    const owned = new Set(c.lessons.flatMap((l) => l.items));
    const asked = new Set(c.asked);
    const newest = (a: Item, b: Item) => Date.parse(b.at) - Date.parse(a.at);
    const learn = new Set(c.learn.filter((i) => !owned.has(i.id)).map((i) => i.id));
    const fresh = items.filter((i) => !owned.has(i.id) && (!asked.has(i.id) || learn.has(i.id))).sort(newest).slice(0, MAX_FRESH);
    if (!fresh.length && !c.lessons.some((l) => l.rewrite)) return new Set();
    const since = Date.now() - 120 * 86_400_000;
    const earlier = fresh.length ? items.filter((i) => !owned.has(i.id) && asked.has(i.id) && !learn.has(i.id) && Date.parse(i.at) > since).sort(newest).slice(0, MAX_RETRY) : [];
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.reviewer, (counts.get(i.reviewer) ?? 0) + 1);
    const reviewers = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([login, comments]) => ({ login, comments }));
    const { prompt, alias } = clusterAsk({ guide: await deps.guide(), repo: c.repo, viewer: c.viewer ?? "you", lessons: c.lessons, items: fresh, learn, earlier, reviewers });
    busy = "thinking";
    publish(c);
    const out = parseCluster(await deps.ask(deps.redact(prompt)), alias);
    if (!out) throw new Error("Your agent's answer had no lessons in it. Try Refresh.");
    const again = mergeCluster(c.lessons, out, byId, learn, Date.now());
    for (const r of out.reviewers) c.reviewers[r.login.replace(/^@/, "")] = { style: r.style.map(oneLine), ...(r.habit ? { habit: oneLine(r.habit) } : {}) };
    c.asked = [...new Set([...c.asked, ...fresh.map((i) => i.id)])].slice(-5000);
    return again;
  }

  /** RL4: the gate for the newest draft, then RL9 and the next draft. */
  async function evolve(root: string, c: Cache, again: Set<string>): Promise<void> {
    const dd = deps.skills();
    const items = new Map(allItems(c).map((i) => [i.id, i]));
    const p = c.pending;
    if (p) {
      const v = c.viewer;
      if (p.lessons.some((id) => again.has(id))) {
        await settleNow({ expect: "reviewed", ok: false, skillIds: [SKILL_ID], why: "the same issue was flagged again" }, dd);
        Object.assign(p, { at: Date.now(), open: p.open.filter((id) => !items.get(id)?.resolved) }); // only what a reviewer does after it came back counts
      } else if (p.open.some((id) => { const i = items.get(id); return i?.resolved && i.resolvedBy && i.resolvedBy !== v; }) || Object.values(c.prs).some((pr) => pr.reviews.some((r) => r.state === "APPROVED" && r.author !== v && !r.bot && r.at && Date.parse(r.at) > p.at))) {
        const done = await settleNow({ expect: "reviewed", ok: true, skillIds: [SKILL_ID] }, dd);
        if (done.length) for (const l of c.lessons) if (p.lessons.includes(l.id)) delete l.notWorking;
        delete c.pending;
      }
    }
    const v = viewOf(c);
    for (const s of v.stats) {
      if (s.afterLearn < MASTER_AT || c.mastered.includes(s.id)) continue;
      c.mastered.push(s.id);
      deps.mastered({ lessonId: s.id, title: s.title, clean: s.afterLearn, key: `lesson:${c.repo}:${s.id}` });
    }
    if (!v.lessons.length) return;
    const key = substance(c, v);
    if (key === c.key) return;
    const target = join(root, ".shrike", "skills", `${SKILL_ID}.md`);
    const body = renderBody(c, v);
    const exists = await stat(target).then(() => true, () => false);
    if (!exists) {
      await mkdir(join(root, ".shrike", "skills"), { recursive: true });
      await writeFile(target, `${frontOf(c, v.lessons.length)}${body}\n`);
      await deps.skillsChanged(); // [Skill Acquired]
    } else {
      const now = Date.now();
      await proposeUpdate(dd, { skillId: SKILL_ID, reason: reasonOf(c.drafted, v), after: body, runId: `${SKILL_ID}:${now}` });
      const changed = v.lessons.filter((l) => { const d = c.drafted?.find((x) => x.id === l.id); return !d || d.fix !== l.fix.join("\n") || d.status !== l.status; }).map((l) => l.id);
      const open = c.lessons.filter((l) => changed.includes(l.id)).flatMap((l) => l.items).filter((id) => items.get(id)?.kind === "thread" && !items.get(id)?.resolved);
      c.pending = { at: now, lessons: [...new Set([...(c.pending?.lessons ?? []), ...changed])], open: [...new Set([...(c.pending?.open ?? []), ...open])] };
    }
    c.key = key;
    c.drafted = v.lessons.map((l) => ({ id: l.id, title: l.title, fix: l.fix.join("\n"), status: l.status }));
  }

  let refreshing: Promise<ReviewLessonsView> | undefined;
  /** One job at a time; a job asked for while another runs waits for it. */
  function run(work: (root: string, c: Cache) => Promise<void>): Promise<ReviewLessonsView> {
    const next = (job ?? Promise.resolve()).catch(() => {}).then(async () => {
      const { root, c, problem } = await current();
      if (!c) return publish(undefined, problem ? { problem } : {});
      let note: string | undefined;
      try {
        await work(root, c);
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
      } finally {
        busy = undefined;
      }
      await save(c).catch(() => {});
      return publish(c, note ? { problem: note } : {});
    });
    job = next;
    void next.finally(() => job === next && (job = undefined)).catch(() => {});
    return next;
  }

  /** Read new review activity, cluster what's new, then the gate and the skill. */
  const refresh = (opts: { limit?: number } = {}): Promise<ReviewLessonsView> =>
    (refreshing ??= run(async (root, c) => {
      if (opts.limit) c.limit = opts.limit;
      busy = "mining";
      publish(c);
      await mine(root, c);
      await patches(root, c).catch(() => {});
      const again = await cluster(c);
      await evolve(root, c, again);
    }).finally(() => (refreshing = undefined)));

  /** RL8: a comment that must get a lesson; clusters straight away (no new reading). */
  const learn = (m: LearnComment) =>
    run(async (root, c) => {
      const body = deps.redact(clip(m.body, 4000));
      if (!body.trim()) throw new Error("That comment is empty.");
      c.learn = [...c.learn.filter((i) => i.id !== m.commentId), { id: m.commentId, pr: m.pr, kind: "thread", reviewer: m.author, bot: isBot(m.author), at: m.at, body, ...(m.url ? { url: m.url } : {}), ...(m.path ? { path: m.path } : {}), ...(m.line ? { line: m.line } : {}), severity: severity(body) } satisfies Item].slice(-50);
      const again = await cluster(c);
      await evolve(root, c, again);
    });

  // ---- RL5/RL6 ----

  async function change(root: string): Promise<{ key: string; files: string[]; diff: string }> {
    const git = (args: string[]) => deps.exec("git", args, { cwd: root });
    const head = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
    let base = head || "origin/main";
    if ((await git(["rev-parse", "--verify", "-q", base])).code !== 0) base = (await git(["rev-parse", "--verify", "-q", "main"])).code === 0 ? "main" : "HEAD";
    const mb = (await git(["merge-base", base, "HEAD"])).stdout.trim() || "HEAD";
    const [names, untracked, diff, sha] = await Promise.all([git(["diff", "--name-only", mb]), git(["ls-files", "--others", "--exclude-standard", "--full-name"]), git(["diff", "--no-color", "-U3", mb]), git(["rev-parse", "HEAD"])]);
    const files = [...new Set([...names.stdout.split("\n"), ...untracked.stdout.split("\n")].map((f) => f.trim()).filter(Boolean))]; // both repo-relative
    const text = deps.redact(clip(diff.stdout, 60_000));
    return { key: createHash("sha1").update(`${sha.stdout}\n${text}\n${files.join("\n")}`).digest("hex").slice(0, 16), files, diff: text };
  }

  async function likely(root: string, c: Cache, files: readonly string[], profiles: readonly ReviewerProfile[]): Promise<ReviewerProfile[]> {
    const top = (await deps.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim() || root;
    let text = "";
    for (const f of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) if ((text = await readFile(join(top, f), "utf8").catch(() => ""))) break;
    const owners = codeowners(text, files).filter((o) => o !== c.viewer);
    const recent = reviewedPrs(c).slice(-10);
    const freq = new Map<string, number>();
    for (const p of recent) for (const r of new Set([...p.reviews.map((x) => x.author), ...p.threads.map((t) => t.comments[0]?.author ?? "")])) if (r && r !== c.viewer) freq.set(r, (freq.get(r) ?? 0) + 1);
    const order = [...owners.map((o) => o.split("/").pop()!), ...[...freq].sort((a, b) => b[1] - a[1]).map(([r]) => r)];
    const out: ReviewerProfile[] = [];
    for (const login of order) {
      const p = profiles.find((x) => x.login.toLowerCase() === login.toLowerCase());
      if (p && !p.bot && !out.includes(p)) out.push(p);
    }
    return out.slice(0, 3);
  }

  async function plan(): Promise<{ root: string; c: Cache; lessons: ReviewLesson[]; reviewers: ReviewerProfile[]; ch: Awaited<ReturnType<typeof change>> } | null> {
    const { root, c } = await current();
    if (!c?.lessons.length) return null;
    const v = viewOf(c);
    const ch = await change(root);
    const reviewers = await likely(root, c, ch.files, v.reviewers);
    const theirs = new Set(reviewers.map((r) => r.login));
    const lessons = checkList(v.lessons, theirs);
    return lessons.length ? { root, c, lessons, reviewers, ch } : null;
  }

  function selfCheck(opts: { force?: boolean } = {}): Promise<SelfCheck | null> {
    if (checking) return checking;
    checking = (async () => {
      const p = await plan();
      if (!p) return null;
      const { c, lessons, reviewers, ch } = p;
      if (!opts.force && c.check && c.check.key === ch.key && c.check.state !== "failed") return c.check;
      const base: SelfCheck = { key: ch.key, at: Date.now(), state: "checking", reviewers: reviewers.map((r) => r.login), checked: lessons.length, found: [], by: "shrike" };
      c.check = base;
      publish(c);
      if (!ch.files.length) c.check = { ...base, state: "done", note: "Nothing on this branch differs from the main branch yet." };
      else
        try {
          c.check = { ...base, state: "done", found: parseCheck(await deps.ask(checkAsk({ lessons, reviewers, files: ch.files, diff: ch.diff })), lessons) };
        } catch (err) {
          c.check = { ...base, state: "failed", note: err instanceof Error ? err.message : String(err) };
        }
      await save(c).catch(() => {});
      publish(c);
      return c.check;
    })().finally(() => (checking = undefined));
    return checking;
  }

  /** RL6 Fix it first: an agent run on what the check found, ending with self_review results. */
  async function fixSelfCheck(): Promise<AgentRunInfo> {
    const { c } = await current();
    const check = c?.check;
    if (!c || !check?.found.length) throw new Error("The self-check found nothing to fix.");
    const lessons = viewOf(c).lessons;
    const goal = [
      `Before this pull request opens, fix the repeat review issues the self-check found. Load the ${SKILL_ID} skill first.`,
      ...check.found.map((f, i) => {
        const l = lessons.find((x) => x.id === f.lessonId);
        return `${i + 1}. ${f.title}${f.where ? ` at ${f.where}` : ""}.${l?.fix.length ? ` How to fix it: ${l.fix.join(" ")}` : ""}`;
      }),
      "Fix each with propose_patch (the smallest change). Then call self_review with one result per lesson above: found, fixed, where.",
    ].join("\n\n");
    return deps.startAgent(deps.redact(goal));
  }

  /** RL5 the MCP tool: no results returns the checklist; results go on the self-check card. */
  async function selfReview(results?: SelfReviewResult[]): Promise<string> {
    const p = await plan();
    if (!p) return "There are no review lessons for this repo yet, so there's nothing to check. Write the code the way the project already does.";
    const { c, lessons, reviewers, ch } = p;
    if (!results?.length)
      return [
        `Review lessons for ${c.repo}: what ${reviewers.length ? reviewers.map((r) => `@${r.login}`).join(" and ") : "reviewers"} flagged before. Check the diff against each, fix what you find with propose_patch, then call self_review again with one result per lesson.`,
        ...lessons.map((l) => `- ${l.id}: ${l.title} (${l.count} times${l.status === "not-working" ? ", not working yet" : ""})\n  Spot it: ${l.spot}\n  Fix it: ${l.fix.join(" ")}`),
        ...reviewers.filter((r) => r.style.length).map((r) => `Conventions of @${r.login}: ${r.style.join("; ")}`),
        `Changed files: ${ch.files.slice(0, 60).join(", ") || "none yet"}`,
      ].join("\n");
    const find = (s: string) => lessons.find((l) => l.id === s.trim() || l.title.toLowerCase() === s.trim().toLowerCase()) ?? viewOf(c).lessons.find((l) => l.id === s.trim());
    const found = results.flatMap((r) => {
      const l = find(r.lesson);
      return r.found && l ? [{ lessonId: l.id, title: l.title, ...(r.where ? { where: clip(r.where, 200) } : {}), ...(r.fixed ? { fixed: true } : {}) }] : [];
    });
    c.check = { key: ch.key, at: Date.now(), state: "done", reviewers: reviewers.map((r) => r.login), checked: Math.max(results.length, c.check?.checked ?? 0), found, by: "agent" };
    await save(c).catch(() => {});
    publish(c);
    return `Saved. The user sees: ${checkLine(c.check)}.`;
  }

  return { view, refresh, learn, selfCheck, fixSelfCheck, selfReview };
}

export type ReviewLessons = ReturnType<typeof createReviewLessons>;
