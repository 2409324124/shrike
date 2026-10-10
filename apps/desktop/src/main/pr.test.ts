import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrAction } from "@shrike/schema";
import { createPrPanel, isBot, parseChecks, parseGraph, parseJob, parseRuns, runState, type RawGraph } from "./pr.ts";
import type { ExecResult } from "./github.ts";

const c = (id: string, login: string, body: string, typename = "User", reactions: { content: "THUMBS_UP" | "EYES"; viewerHasReacted: boolean; reactors: { totalCount: number } }[] = []) => ({ id, body, createdAt: "2026-10-08T10:00:00Z", url: `https://github.com/o/r/pull/7#${id}`, author: { login, __typename: typename }, reactionGroups: reactions });
const GRAPH: RawGraph = {
  data: {
    viewer: { login: "me" },
    repository: {
      pullRequest: {
        id: "PR_1", number: 7, title: "Fix add todo", url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: true, updatedAt: "2026-10-08T11:00:00Z", headRefName: "fix/x", baseRefName: "main", reviewDecision: "CHANGES_REQUESTED", author: { login: "me", __typename: "User" },
        reviewThreads: { nodes: [
          { id: "T1", isResolved: false, isOutdated: false, path: "server/todos.ts", line: 18, originalLine: 17, comments: { nodes: [c("C1", "ana", "Use **userId** here", "User", [{ content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 2 } }, { content: "EYES", viewerHasReacted: false, reactors: { totalCount: 0 } }])] } },
          { id: "T2", isResolved: true, isOutdated: true, path: "web/a.ts", line: null, originalLine: 4, comments: { nodes: [c("C2", "github-advanced-security", "## CodeQL", "Bot")] } },
        ] },
        comments: { nodes: [c("C3", "coderabbitai", "Summary"), c("C4", "vercel[bot]", "Deployed", "Bot"), c("C5", "bo", "LGTM?")] },
        reviews: { nodes: [
          { id: "R1", state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-10-08T10:30:00Z", author: { login: "ana", __typename: "User" } },
          { id: "R2", state: "COMMENTED", body: "", submittedAt: null, author: { login: "ana", __typename: "User" } },
          { id: "R3", state: "COMMENTED", body: "Nice", submittedAt: null, author: null },
        ] },
      },
    },
  },
};

test("graphql: threads, comments, reviews, bots and the PR's state", () => {
  const v = parseGraph(GRAPH)!;
  assert.deepEqual(v.pr, { id: "PR_1", number: 7, title: "Fix add todo", url: "https://github.com/o/r/pull/7", state: "draft", author: "me", updatedAt: "2026-10-08T11:00:00Z", base: "main", head: "fix/x", decision: "changes" });
  assert.equal(v.viewer, "me");
  assert.deepEqual(v.threads.map((t) => [t.id, t.path, t.line, t.resolved, t.outdated]), [["T1", "server/todos.ts", 18, false, false], ["T2", "web/a.ts", 4, true, true]]);
  assert.deepEqual(v.threads[0]!.comments[0]!.reactions, [{ content: "THUMBS_UP", count: 2, mine: true }]);
  assert.deepEqual(v.comments.map((x) => [x.author, x.bot]), [["coderabbitai", true], ["vercel[bot]", true], ["bo", false]]);
  assert.equal(v.threads[1]!.comments[0]!.bot, true);
  assert.deepEqual(v.reviews.map((r) => [r.id, r.author, r.state]), [["R1", "ana", "changes"], ["R3", "ghost", "commented"]]); // a bare "commented" is dropped
  assert.equal(parseGraph({ data: { repository: { pullRequest: null } } }), undefined);
  assert.equal(isBot("renovate"), true);
  assert.equal(isBot("renovator"), false);
});

test("checks, branch runs and job steps map to plain states", () => {
  assert.deepEqual(
    parseChecks([
      { name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/11/job/22", startedAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:01:05Z", workflow: "CI" },
      { name: "lint", bucket: "pending", startedAt: "0001-01-01T00:00:00Z", completedAt: "0001-01-01T00:00:00Z" },
      { name: "deploy", bucket: "skipping", link: "https://vercel.com/x" },
    ]),
    [
      { name: "test", state: "fail", url: "https://github.com/o/r/actions/runs/11/job/22", workflow: "CI", startedAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:01:05Z", run: "11" },
      { name: "lint", state: "pending" },
      { name: "deploy", state: "skipped", url: "https://vercel.com/x" },
    ],
  );
  assert.equal(runState("in_progress", null), "pending");
  assert.equal(runState("completed", "timed_out"), "fail");
  assert.equal(runState("completed", "neutral"), "skipped");
  const runs = parseRuns([
    { databaseId: 3, workflowName: "CI", status: "in_progress", conclusion: null, url: "u3", createdAt: "a", updatedAt: "b" },
    { databaseId: 2, workflowName: "CI", status: "completed", conclusion: "failure", url: "u2" },
    { databaseId: 1, workflowName: "Lint", status: "completed", conclusion: "success", url: "u1", createdAt: "a", updatedAt: "b" },
  ]);
  assert.deepEqual(runs, [{ name: "CI", state: "pending", url: "u3", run: "3", startedAt: "a" }, { name: "Lint", state: "pass", url: "u1", run: "1", startedAt: "a", completedAt: "b" }]);
  const jobs = [{ databaseId: 22, name: "test", status: "completed", conclusion: "failure", steps: [{ name: "Set up", status: "completed", conclusion: "success", startedAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:00:02Z" }, { name: "Run tests", status: "completed", conclusion: "failure" }] }];
  assert.deepEqual(parseJob(jobs, "22"), [{ name: "Set up", state: "pass", seconds: 2 }, { name: "Run tests", state: "fail" }]);
  assert.deepEqual(parseJob(jobs), [{ name: "test", state: "fail" }]);
});

// A fake gh: answers reads from GRAPH, logs every call.
function fake(approve: boolean) {
  const calls: string[][] = [];
  const asked: { title: string; reason: string }[] = [];
  const goals: string[] = [];
  const queued: string[] = [];
  const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
  const panel = createPrPanel({
    root: () => "/repo",
    exec: async (_c, args) => ok(args[0] === "branch" ? "fix/x\n" : ""),
    gh: {
      run: async (args) => {
        calls.push(args);
        const k = args.slice(0, 2).join(" ");
        if (k === "--version" || k === "auth status") return ok("");
        if (k === "pr view") return ok({ number: 7, url: "https://github.com/o/r/pull/7" });
        if (k === "pr checks") return { code: 8, stdout: JSON.stringify([{ name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/11/job/22", workflow: "CI" }]), stderr: "" };
        if (k === "api graphql" && args[3]!.startsWith("query=query")) return ok(GRAPH);
        if (k === "run view") return ok("test\tRun tests\t2026-10-08T10:00:02.1Z AssertionError: expected 1 token=abc123secretvalue to equal 2");
        return ok({ data: {} });
      },
    },
    approve: async (title, reason) => (asked.push({ title, reason }), approve),
    startAgent: async (goal) => (goals.push(goal), { id: "run1", goal, brain: "claude-code", status: "running" } as never),
    queue: async (p) => (queued.push(p), { items: [], paused: false, chain: null }),
    redact: (s) => s.replace(/token=\S+/g, "token=[redacted]"),
  });
  const writes = () => calls.filter((a) => (a[0] === "api" && a[3]!.startsWith("query=mutation")) || ["ready", "rerun"].includes(a[1]!));
  return { panel, calls, asked, goals, queued, writes };
}

const ACTIONS: PrAction[] = [
  { kind: "reply", n: 7, threadId: "T1", body: "Done, thanks!" },
  { kind: "comment", n: 7, body: "Ready for another look" },
  { kind: "react", n: 7, subjectId: "C5", content: "HEART" },
  { kind: "resolve", n: 7, threadId: "T1", resolved: true },
  { kind: "review", n: 7, event: "REQUEST_CHANGES", body: "Please add a test" },
  { kind: "ready", n: 7 },
  { kind: "rerun", run: "11" },
];

test("every write asks first; Not now sends nothing to GitHub", async () => {
  const f = fake(false);
  await f.panel.view(7);
  for (const a of ACTIONS) await assert.rejects(f.panel.act(a), /^Error: Not [\w-]+\. Nothing was sent to GitHub\.$/);
  assert.equal(f.asked.length, ACTIONS.length);
  assert.deepEqual(f.writes(), []);
  assert.match(f.asked[0]!.reason, /as @me in the conversation on server\/todos\.ts:18:\n\nDone, thanks!$/); // exactly what will be posted
});

test("Allow posts the exact text through gh, with -f strings only", async () => {
  const f = fake(true);
  await f.panel.view(7);
  for (const a of ACTIONS) await f.panel.act(a);
  const w = f.writes();
  assert.equal(w.length, ACTIONS.length);
  assert.ok(w[0]!.includes("body=Done, thanks!") && w[0]!.includes("id=T1") && w[0]![3]!.includes("addPullRequestReviewThreadReply"));
  assert.ok(w[1]![3]!.includes("addComment") && w[1]!.includes("id=PR_1"));
  assert.ok(w[2]![3]!.includes("addReaction") && w[2]!.includes("c=HEART"));
  assert.ok(w[3]![3]!.includes("resolveReviewThread"));
  assert.ok(w[4]!.includes("e=REQUEST_CHANGES"));
  assert.deepEqual(w[5], ["pr", "ready", "7"]);
  assert.deepEqual(w[6], ["run", "rerun", "11", "--failed"]);
  assert.ok(w.every((a) => !a.includes("-F")));
  // my own reaction toggles off
  await f.panel.act({ kind: "react", n: 7, subjectId: "C1", content: "THUMBS_UP" });
  assert.ok(f.writes().at(-1)![3]!.includes("removeReaction"));
});

test("writes refuse ids the panel never showed", async () => {
  const f = fake(true);
  await f.panel.view(7);
  await assert.rejects(f.panel.act({ kind: "reply", n: 7, threadId: "T9", body: "x" }), /isn't on this pull request/);
  await assert.rejects(f.panel.act({ kind: "react", n: 7, subjectId: "C9", content: "EYES" }), /isn't on this pull request/);
  await assert.rejects(f.panel.act({ kind: "rerun", run: "99" }), /only re-runs checks it has shown/);
  await assert.rejects(f.panel.act({ kind: "review", n: 7, event: "COMMENT", body: " " }), /Write what you think/);
  assert.equal(f.asked.length, 0);
});

test("agent tasks: queue a comment, fix all open threads, fix a check, all redacted", async () => {
  const f = fake(true);
  await f.panel.view(7);
  await f.panel.agent({ kind: "queue", n: 7, commentId: "C1" });
  assert.match(f.queued[0]!, /^Address this review comment on pull request #7 \(server\/todos\.ts:18\) from @ana:\n\n> Use \*\*userId\*\* here/);
  await f.panel.agent({ kind: "fix-all", n: 7 });
  assert.match(f.goals[0]!, /1\. Thread T1 on server\/todos\.ts:18/);
  assert.doesNotMatch(f.goals[0]!, /Thread T2/); // resolved threads stay out
  assert.match(f.goals[0]!, /REPLY <thread id>:/);
  await f.panel.agent({ kind: "fix-check", n: 7, name: "test" });
  assert.match(f.goals[1]!, /token=\[redacted\]/);
  assert.doesNotMatch(f.goals[1]!, /abc123secretvalue/);
});
