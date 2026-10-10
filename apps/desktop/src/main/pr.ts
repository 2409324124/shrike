import type { AgentOptions, AgentRunInfo, ChainsState, PrAction, PrAgentTask, PrCheck, PrCheckJob, PrComment, PrInfo, PrReaction, PrReview, PrThread, PrView } from "@shrike/schema";
import { actionsIds, failedLog, ghError, ghStatus, GH_SETUP, type Exec, type Gh } from "./github.ts";

// PR1–PR8: the pull request and CI panel. Reads through gh (graphql, pr checks, run list/view); every write asks first.

const KNOWN_BOTS = /^(github-actions|github-advanced-security|dependabot|dependabot-preview|renovate|coderabbitai|copilot|copilot-pull-request-reviewer|sonarcloud|sonarqubecloud|codecov|codecov-commenter|vercel|netlify|linear|sentry-io|graphite-app|changeset-bot|socket-security|deepsource-io|greptile-apps|gemini-code-assist|qodo-merge-pro|ellipsis-dev)$/i;
export const isBot = (login: string, typename?: string): boolean => typename === "Bot" || /\[bot\]$/i.test(login) || KNOWN_BOTS.test(login);

const json = <T>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

// ---- reading ----

const COMMENT = "id body createdAt url author{login __typename} reactionGroups{content viewerHasReacted reactors{totalCount}}";
export const PR_QUERY = `query($owner:String!,$name:String!,$n:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$n){id number title url state isDraft updatedAt headRefName baseRefName reviewDecision author{login __typename} reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine comments(first:50){nodes{${COMMENT}}}}} comments(first:100){nodes{${COMMENT}}} reviews(first:50){nodes{id state body submittedAt author{login __typename}}}}}}`;

type Author = { login: string; __typename?: string } | null;
interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  url?: string;
  author: Author;
  reactionGroups?: { content: PrReaction; viewerHasReacted: boolean; reactors?: { totalCount: number } }[];
}
interface RawPr {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision?: string | null;
  author: Author;
  reviewThreads?: { nodes: { id: string; isResolved: boolean; isOutdated: boolean; path: string; line?: number | null; originalLine?: number | null; comments: { nodes: RawComment[] } }[] };
  comments?: { nodes: RawComment[] };
  reviews?: { nodes: { id: string; state: string; body: string; submittedAt?: string | null; author: Author }[] };
}
export interface RawGraph {
  data?: { viewer?: { login: string }; repository?: { pullRequest?: RawPr | null } };
}

const who = (a: Author) => a?.login ?? "ghost"; // GitHub's name for a deleted account
const comment = (c: RawComment): PrComment => ({
  id: c.id,
  author: who(c.author),
  bot: isBot(who(c.author), c.author?.__typename),
  body: c.body ?? "",
  at: c.createdAt,
  ...(c.url ? { url: c.url } : {}),
  reactions: (c.reactionGroups ?? []).map((g) => ({ content: g.content, count: g.reactors?.totalCount ?? 0, mine: g.viewerHasReacted })).filter((g) => g.count > 0),
});
const REVIEW: Record<string, PrReview["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };
const DECISION: Record<string, PrInfo["decision"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", REVIEW_REQUIRED: "review" };

/** gh api graphql → the panel's threads, comments and reviews. Empty review bodies (a bare "commented" on a thread) are dropped. */
export function parseGraph(raw: RawGraph): Pick<PrView, "pr" | "threads" | "comments" | "reviews" | "viewer"> | undefined {
  const p = raw.data?.repository?.pullRequest;
  if (!p) return undefined;
  const s = p.state.toLowerCase();
  const decision = p.reviewDecision ? DECISION[p.reviewDecision] : undefined;
  const pr: PrInfo = {
    id: p.id,
    number: p.number,
    title: p.title,
    url: p.url,
    state: s === "merged" ? "merged" : s === "closed" ? "closed" : p.isDraft ? "draft" : "open",
    author: who(p.author),
    updatedAt: p.updatedAt,
    base: p.baseRefName,
    head: p.headRefName,
    ...(decision ? { decision } : {}),
  };
  const threads: PrThread[] = (p.reviewThreads?.nodes ?? []).map((t) => ({
    id: t.id,
    path: t.path,
    ...((t.line ?? t.originalLine) ? { line: (t.line ?? t.originalLine)! } : {}),
    resolved: t.isResolved,
    outdated: t.isOutdated,
    comments: t.comments.nodes.map(comment),
  }));
  const reviews: PrReview[] = (p.reviews?.nodes ?? [])
    .filter((r) => r.body?.trim() || r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
    .map((r) => ({ id: r.id, author: who(r.author), bot: isBot(who(r.author), r.author?.__typename), state: REVIEW[r.state] ?? "commented", body: r.body ?? "", ...(r.submittedAt ? { at: r.submittedAt } : {}) }));
  return { pr, threads, comments: (p.comments?.nodes ?? []).map(comment), reviews, ...(raw.data?.viewer?.login ? { viewer: raw.data.viewer.login } : {}) };
}

const BUCKET: Record<string, PrCheck["state"]> = { pass: "pass", fail: "fail", cancel: "fail", pending: "pending", skipping: "skipped" };

/** gh pr checks --json name,bucket,link,startedAt,completedAt,workflow */
export function parseChecks(list: { name: string; bucket: string; link?: string; startedAt?: string; completedAt?: string; workflow?: string }[]): PrCheck[] {
  return list.map((c) => {
    const run = actionsIds(c.link)?.run;
    const real = (t?: string) => (t && !t.startsWith("0001") ? t : undefined); // gh prints year 1 for "not yet"
    return {
      name: c.name,
      state: BUCKET[c.bucket] ?? "pending",
      ...(c.link ? { url: c.link } : {}),
      ...(c.workflow ? { workflow: c.workflow } : {}),
      ...(real(c.startedAt) ? { startedAt: c.startedAt } : {}),
      ...(real(c.completedAt) ? { completedAt: c.completedAt } : {}),
      ...(run ? { run } : {}),
    };
  });
}

/** Actions status + conclusion (runs, jobs, steps) → one plain state. */
export function runState(status: string, conclusion?: string | null): PrCheck["state"] {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "pass";
  if (conclusion === "skipped" || conclusion === "neutral") return "skipped";
  return "fail";
}

interface RawRun { databaseId: number; name?: string; workflowName?: string; status: string; conclusion?: string | null; url: string; createdAt?: string; updatedAt?: string }

/** gh run list --branch: before a PR exists, the newest run of each workflow stands in for its checks. */
export function parseRuns(runs: RawRun[]): PrCheck[] {
  const seen = new Set<string>();
  const out: PrCheck[] = [];
  for (const r of runs) {
    const name = r.workflowName || r.name || `Run ${r.databaseId}`;
    if (seen.has(name)) continue; // gh lists newest first
    seen.add(name);
    const state = runState(r.status, r.conclusion);
    out.push({ name, state, url: r.url, run: String(r.databaseId), ...(r.createdAt ? { startedAt: r.createdAt } : {}), ...(state !== "pending" && r.updatedAt ? { completedAt: r.updatedAt } : {}) });
  }
  return out;
}

const secs = (a?: string | null, b?: string | null) => (a && b && !a.startsWith("0001") && !b.startsWith("0001") ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : undefined);
interface RawStep { name: string; status: string; conclusion?: string | null; startedAt?: string | null; completedAt?: string | null }
interface RawJob extends RawStep { databaseId: number; steps?: RawStep[] }

/** gh run view --json jobs → a job's steps; for a whole run (no job id) each job is one step. */
export function parseJob(jobs: RawJob[], job?: string): PrCheckJob["steps"] {
  const step = (s: RawStep) => {
    const seconds = secs(s.startedAt, s.completedAt);
    return { name: s.name, state: runState(s.status, s.conclusion), ...(seconds !== undefined ? { seconds } : {}) };
  };
  if (!job) return jobs.map(step);
  return (jobs.find((j) => String(j.databaseId) === job)?.steps ?? []).map(step);
}

const ownerName = (url: string) => /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(url);

// ---- the service ----

export interface PrDeps {
  root(): string | undefined;
  gh: Gh;
  exec: Exec; // git, for the branch name before a PR exists
  approve(title: string, reason: string): Promise<boolean>;
  startAgent(goal: string, opts: AgentOptions): Promise<AgentRunInfo>;
  queue(prompt: string): Promise<ChainsState>; // P1 Up next
  redact(text: string): string; // @shrike/redact before anything reaches an agent
}

const EMOJI: Record<PrReaction, string> = { THUMBS_UP: "👍", THUMBS_DOWN: "👎", LAUGH: "😄", HOORAY: "🎉", CONFUSED: "😕", HEART: "❤️", ROCKET: "🚀", EYES: "👀" };
const quote = (body: string) => body.trim().split("\n").map((l) => `> ${l}`).join("\n");

export function createPrPanel(deps: PrDeps) {
  const gh = deps.gh;
  const views = new Map<number, PrView>(); // what the panel last showed, per PR: writes only touch ids from here
  const logs = new Map<string, { summary: string; lines: string[] }>(); // a failed job's log doesn't change
  let ready: { at: number; v: Awaited<ReturnType<typeof ghStatus>> } | undefined;

  const need = (): string => {
    const r = deps.root();
    if (!r) throw new Error("No project is open.");
    return r;
  };

  async function ghReady(cwd: string) {
    if (!ready || Date.now() - ready.at > (ready.v.ready ? 300_000 : 15_000)) ready = { at: Date.now(), v: await ghStatus(gh, cwd) };
    return ready.v;
  }

  async function view(n?: number): Promise<PrView> {
    const cwd = need();
    const g = await ghReady(cwd);
    const empty: PrView = { ghReady: g.ready, checks: [], threads: [], comments: [], reviews: [], at: Date.now() };
    if (!g.ready) return { ...empty, problem: GH_SETUP[g.problem ?? "missing"] };
    const [b, pre] = await Promise.all([deps.exec("git", ["branch", "--show-current"], { cwd }), deps.exec("git", ["rev-parse", "--show-prefix"], { cwd })]);
    const branch = b.code === 0 ? b.stdout.trim() || undefined : undefined;
    if (pre.code === 0 && pre.stdout.trim()) empty.prefix = pre.stdout.trim();
    const head = await gh.run(["pr", "view", ...(n ? [String(n)] : []), "--json", "number,url"], { cwd });
    const found = head.code === 0 ? json<{ number: number; url: string }>(head.stdout) : undefined;
    if (!found) {
      if (n) throw new Error(ghError(head, `Couldn't find pull request #${n}`));
      if (!branch) return { ...empty, problem: "This folder isn't on a branch right now." };
      const runs = await gh.run(["run", "list", "--branch", branch, "--limit", "30", "--json", "databaseId,name,workflowName,status,conclusion,url,createdAt,updatedAt"], { cwd });
      return { ...empty, branch, checks: runs.code === 0 ? parseRuns(json<RawRun[]>(runs.stdout) ?? []) : [] };
    }
    const m = ownerName(found.url);
    if (!m) throw new Error(`Shrike can only read pull requests on github.com (${found.url}).`);
    const [graph, checks] = await Promise.all([
      gh.run(["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${m[1]}`, "-f", `name=${m[2]}`, "-F", `n=${found.number}`], { cwd }),
      gh.run(["pr", "checks", String(found.number), "--json", "name,bucket,link,startedAt,completedAt,workflow"], { cwd }), // exits non-zero while checks fail or wait
    ]);
    const parsed = graph.code === 0 ? parseGraph(json<RawGraph>(graph.stdout) ?? {}) : undefined;
    if (!parsed) throw new Error(ghError(graph, `Couldn't read pull request #${found.number}`));
    const v: PrView = { ...empty, ...parsed, branch: parsed.pr!.head, checks: parseChecks(json<Parameters<typeof parseChecks>[0]>(checks.stdout) ?? []) };
    views.set(found.number, v);
    return v;
  }

  async function checkJob(link: string, name: string): Promise<PrCheckJob> {
    const cwd = need();
    const ids = actionsIds(link);
    if (!ids) return { steps: [], lines: [], summary: `"${name}" runs outside GitHub Actions. Open its page to see the details.` };
    const r = await gh.run(["run", "view", ids.run, "--json", "jobs"], { cwd });
    if (r.code !== 0) throw new Error(ghError(r, `Couldn't read "${name}"`));
    const steps = parseJob(json<{ jobs: RawJob[] }>(r.stdout)?.jobs ?? [], ids.job);
    if (!steps.some((s) => s.state === "fail")) return { steps, lines: [] };
    const log = logs.get(link) ?? (await failedLog(gh, cwd, name, link));
    logs.set(link, log);
    return { steps, ...log };
  }

  /** The PR as the panel last showed it; writes never act on ids the user didn't see. */
  async function seen(n: number): Promise<PrView & { pr: PrInfo }> {
    const v = views.get(n) ?? (await view(n));
    if (!v.pr) throw new Error(`Couldn't find pull request #${n}.`);
    return v as PrView & { pr: PrInfo };
  }

  const allComments = (v: PrView) => [...v.comments, ...v.threads.flatMap((t) => t.comments)];
  const where = (t: PrThread) => `${t.path}${t.line ? `:${t.line}` : ""}`;
  const as = (v: PrView) => (v.viewer ? `as @${v.viewer}` : "as you");

  async function graphql(cwd: string, mutation: string, vars: Record<string, string>, what: string): Promise<void> {
    const r = await gh.run(["api", "graphql", "-f", `query=${mutation}`, ...Object.entries(vars).flatMap(([k, val]) => ["-f", `${k}=${val}`])], { cwd }); // -f: never read as @file or a number
    if (r.code !== 0 || json<{ errors?: unknown[] }>(r.stdout)?.errors?.length) throw new Error(ghError(r, what));
  }

  async function act(a: PrAction): Promise<PrView> {
    const cwd = need();
    const no = (what: string): never => {
      throw new Error(`Not ${what}. Nothing was sent to GitHub.`);
    };
    if (a.kind === "rerun") {
      const n = [...views.values()].find((v) => v.checks.some((c) => c.run === a.run));
      const c = n?.checks.find((x) => x.run === a.run);
      if (!c) throw new Error("Shrike only re-runs checks it has shown you.");
      const failed = n!.checks.filter((x) => x.run === a.run && x.state === "fail").map((x) => x.name);
      if (!(await deps.approve(`Re-run the failed jobs of "${c.workflow ?? c.name}"?`, `GitHub runs ${failed.length ? failed.map((f) => `"${f}"`).join(", ") : "the failed jobs"} again on the same commit. Nothing else changes.`))) no("re-run");
      const r = await gh.run(["run", "rerun", a.run, "--failed"], { cwd });
      if (r.code !== 0) throw new Error(ghError(r, "GitHub didn't re-run it"));
      return n?.pr ? view(n.pr.number) : view();
    }
    const v = await seen(a.n);
    const thread = "threadId" in a ? v.threads.find((t) => t.id === a.threadId) : undefined;
    if ("threadId" in a && !thread) throw new Error("That conversation isn't on this pull request any more. Refresh and try again.");
    switch (a.kind) {
      case "reply": {
        const body = a.body.trim();
        if (!(await deps.approve(`Post this reply on pull request #${a.n}?`, `Shrike posts ${as(v)} in the conversation on ${where(thread!)}:\n\n${body}`))) no("posted");
        await graphql(cwd, "mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}", { id: thread!.id, body }, "GitHub didn't post the reply");
        break;
      }
      case "comment": {
        const body = a.body.trim();
        if (!(await deps.approve(`Post this comment on pull request #${a.n}?`, `Shrike posts ${as(v)} on "${v.pr.title}":\n\n${body}`))) no("posted");
        await graphql(cwd, "mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{id}}}}", { id: v.pr.id, body }, "GitHub didn't post the comment");
        break;
      }
      case "react": {
        const c = allComments(v).find((x) => x.id === a.subjectId);
        if (!c) throw new Error("That comment isn't on this pull request any more. Refresh and try again.");
        const mine = c.reactions.some((r) => r.content === a.content && r.mine);
        if (!(await deps.approve(mine ? `Take back your ${EMOJI[a.content]} on @${c.author}'s comment?` : `React ${EMOJI[a.content]} to @${c.author}'s comment?`, `Shrike ${mine ? "removes" : "adds"} the reaction ${as(v)} on pull request #${a.n}. Everyone on it can see reactions.`))) no("sent");
        await graphql(cwd, `mutation($id:ID!,$c:ReactionContent!){${mine ? "removeReaction" : "addReaction"}(input:{subjectId:$id,content:$c}){reaction{content}}}`, { id: c.id, c: a.content }, "GitHub didn't take the reaction");
        break;
      }
      case "resolve": {
        if (!(await deps.approve(a.resolved ? `Mark the conversation on ${where(thread!)} as resolved?` : `Reopen the conversation on ${where(thread!)}?`, `Shrike ${a.resolved ? "resolves" : "unresolves"} it ${as(v)} on pull request #${a.n}. ${a.resolved ? "It folds away for everyone; anyone can reopen it." : "It shows as open again for everyone."}`))) no(a.resolved ? "resolved" : "reopened");
        await graphql(cwd, `mutation($id:ID!){${a.resolved ? "resolveReviewThread" : "unresolveReviewThread"}(input:{threadId:$id}){thread{isResolved}}}`, { id: thread!.id }, "GitHub didn't change the conversation");
        break;
      }
      case "review": {
        const body = a.body.trim();
        if (a.event !== "APPROVE" && !body) throw new Error(a.event === "COMMENT" ? "Write what you think first." : "Say what needs to change first.");
        const word = { APPROVE: "Approve", COMMENT: "Comment on", REQUEST_CHANGES: "Request changes on" }[a.event];
        if (!(await deps.approve(`${word} pull request #${a.n}?`, `Shrike submits your review ${as(v)} on "${v.pr.title}"${body ? `:\n\n${body}` : ", with no message."}`))) no("submitted");
        await graphql(cwd, "mutation($id:ID!,$e:PullRequestReviewEvent!,$body:String!){addPullRequestReview(input:{pullRequestId:$id,event:$e,body:$body}){pullRequestReview{id}}}", { id: v.pr.id, e: a.event, body }, "GitHub didn't take the review");
        break;
      }
      case "ready": {
        if (v.pr.state !== "draft") throw new Error(`Pull request #${a.n} isn't a draft.`);
        if (!(await deps.approve(`Mark pull request #${a.n} as ready for review?`, `It stops being a draft, and GitHub asks its reviewers to look. Nothing is merged.`))) no("changed");
        const r = await gh.run(["pr", "ready", String(a.n)], { cwd });
        if (r.code !== 0) throw new Error(ghError(r, "GitHub didn't change it"));
        break;
      }
    }
    return view(a.n);
  }

  async function agent(t: PrAgentTask): Promise<AgentRunInfo | ChainsState> {
    const cwd = need();
    if (t.kind === "fix-check") {
      const v = t.n ? await seen(t.n) : await view();
      const c = v.checks.find((x) => x.name === t.name);
      if (!c) throw new Error(`There's no check called "${t.name}" here.`);
      const log = c.url ? (logs.get(c.url) ?? (await failedLog(gh, cwd, c.name, c.url))) : undefined;
      if (c.url && log) logs.set(c.url, log);
      const goal = [
        `The "${c.name}" check failed${v.pr ? ` on pull request #${v.pr.number}` : ` on branch ${v.branch ?? "this branch"}`}. Fix it.`,
        log ? `What its log said: ${log.summary}` : "",
        log?.lines.length ? `Failing lines:\n${log.lines.join("\n")}` : "",
        c.url ? `Check page: ${c.url}` : "",
        "Find the cause in the code, then propose the smallest fix with propose_patch. Say if it looks flaky instead.",
      ].filter(Boolean).join("\n\n");
      return deps.startAgent(deps.redact(goal), { skillId: "explain-ci" });
    }
    const v = await seen(t.n);
    if (t.kind === "queue") {
      const thread = v.threads.find((x) => x.comments.some((c) => c.id === t.commentId));
      const c = allComments(v).find((x) => x.id === t.commentId);
      if (!c) throw new Error("That comment isn't on this pull request any more.");
      return deps.queue(deps.redact(`Address this review comment on pull request #${t.n}${thread ? ` (${where(thread)})` : ""} from @${c.author}:\n\n${quote(c.body)}\n\nChange the code if the comment is right (propose_patch), or say why not.`));
    }
    const open = v.threads.filter((x) => !x.resolved);
    if (!open.length) throw new Error("Every conversation on this pull request is resolved.");
    const goal = [
      `Address the ${open.length === 1 ? "open review conversation" : `${open.length} open review conversations`} on pull request #${t.n} "${v.pr.title}" (${v.pr.head} into ${v.pr.base}).`,
      ...open.map((x, i) => `${i + 1}. Thread ${x.id} on ${where(x)}${x.outdated ? " (outdated)" : ""}\n${x.comments.map((c) => `@${c.author}${c.bot ? " (bot)" : ""}:\n${quote(c.body)}`).join("\n")}`),
      "Fix what is right with propose_patch (one patch for all of it is fine). Post nothing to GitHub yourself.",
      "End your last message with one line per thread, exactly: REPLY <thread id>: <the reply you'd post, plain and short>. The user approves each reply before it's posted.",
    ].join("\n\n");
    return deps.startAgent(deps.redact(goal), { skillId: "review-fix" });
  }

  return { view, checkJob, act, agent };
}
