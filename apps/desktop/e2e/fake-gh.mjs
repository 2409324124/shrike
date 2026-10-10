#!/usr/bin/env node
// A fake gh for e2e (SHRIKE_GH_BIN). Nothing it does reaches GitHub unless SHRIKE_FAKE_GH_REAL names the real gh,
// and then only reads pass through: every write is refused.
// State: $SHRIKE_FAKE_GH_DIR/state.json (seeded below). Every call: one JSON line in $SHRIKE_FAKE_GH_DIR/calls.log.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
if (!dir) (process.stderr.write("fake-gh: set SHRIKE_FAKE_GH_DIR\n"), process.exit(2));
appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
const fail = (msg, code = 1) => (process.stderr.write(msg + "\n"), process.exit(code));
const val = (flag, name) => {
  for (let i = 0; i < a.length; i++) if (a[i] === flag && a[i + 1]?.startsWith(`${name}=`)) return a[i + 1].slice(name.length + 1);
  return undefined;
};
const query = val("-f", "query") ?? "";

const real = process.env.SHRIKE_FAKE_GH_REAL;
if (real) {
  const k = a.slice(0, 2).join(" ");
  const read = a[0] === "--version" || ["auth status", "pr view", "pr checks", "pr list", "pr diff", "run view", "run list", "repo view"].includes(k) || (k === "api graphql" && /^\s*query\b/.test(query));
  if (!read) fail(`fake-gh: refused a write in read-only mode: ${a.slice(0, 3).join(" ")}`);
  const r = spawnSync(real, a, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const put = (fd, text) => { // synchronous: process.exit would cut off a large async write to a pipe
    for (let b = Buffer.from(text ?? ""); b.length; ) try { b = b.subarray(writeSync(fd, b)); } catch (e) { if (e.code !== "EAGAIN") throw e; }
  };
  put(1, r.stdout);
  put(2, r.stderr);
  process.exit(r.status ?? 1);
}

const file = join(dir, "state.json");
const at = (m) => new Date(Date.now() - m * 60_000).toISOString();
const rg = (up = 0, mine = false) => ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"].map((content) => ({ content, viewerHasReacted: content === "THUMBS_UP" && mine, reactors: { totalCount: content === "THUMBS_UP" ? up : 0 } }));
const c = (id, login, typename, body, m, up = 0) => ({ id, body, createdAt: at(m), url: `https://github.com/e2e/todo-app/pull/7#${id}`, author: { login, __typename: typename }, reactionGroups: rg(up) });
const RUN = "https://github.com/e2e/todo-app/actions/runs/1001";
const seed = {
  pr: {
    id: "PR_kw7", number: 7, title: "Fix: Add Todo works again", url: "https://github.com/e2e/todo-app/pull/7", state: "OPEN", isDraft: true, updatedAt: at(12), headRefName: "fix/add-todo", baseRefName: "main", reviewDecision: "CHANGES_REQUESTED", author: { login: "e2e", __typename: "User" },
    reviewThreads: { nodes: [
      { id: "PRRT_1", isResolved: false, isOutdated: false, path: "server/todos.controller.ts", line: 4, originalLine: 4, comments: { nodes: [c("PRRC_1", "ana", "User", "This reads `req.body.user`, but the form sends **userId**.\n\n```suggestion\ninsertTodo({ title, userId: req.body.userId });\n```", 40, 2)] } },
      { id: "PRRT_2", isResolved: true, isOutdated: true, path: "web/src/App.tsx", line: null, originalLine: 9, comments: { nodes: [c("PRRC_2", "coderabbitai", "Bot", "## Potential issue\n\n| File | Change |\n|---|---|\n| web/src/App.tsx | type the body |\n\n<details><summary>Prompt for AI agents</summary>Type the request body.</details><script>alert(1)</script>", 55), c("PRRC_3", "e2e", "User", "Done.", 30)] } },
    ] },
    comments: { nodes: [c("IC_1", "vercel", "Bot", "<!-- vercel -->Preview is ready: [open it](https://todo-app.vercel.app) <img src=\"https://evil.test/track.png\" alt=\"tracker\">", 50), c("IC_2", "bo", "User", "Can we add a test for this? [bad link](javascript:alert(1))", 20)] },
    reviews: { nodes: [{ id: "PRR_1", state: "CHANGES_REQUESTED", body: "One thing left, see the controller.", submittedAt: at(39), author: { login: "ana", __typename: "User" } }] },
  },
  checks: [
    { name: "test", bucket: "fail", link: `${RUN}/job/2001`, startedAt: at(9), completedAt: at(8), workflow: "CI" },
    { name: "lint", bucket: "pass", link: `${RUN}/job/2002`, startedAt: at(9), completedAt: at(8.7), workflow: "CI" },
    { name: "typecheck", bucket: "pass", link: `${RUN}/job/2003`, startedAt: at(9), completedAt: at(8.4), workflow: "CI" },
    { name: "deploy preview", bucket: "pass", link: "https://vercel.com/e2e/todo-app", startedAt: at(9), completedAt: at(7) },
  ],
  jobs: [
    { databaseId: 2001, name: "test", status: "completed", conclusion: "failure", startedAt: at(9), completedAt: at(8), steps: [
      { name: "Set up job", status: "completed", conclusion: "success", startedAt: at(9), completedAt: at(8.97) },
      { name: "Install", status: "completed", conclusion: "success", startedAt: at(8.97), completedAt: at(8.6) },
      { name: "Run tests", status: "completed", conclusion: "failure", startedAt: at(8.6), completedAt: at(8.05) },
      { name: "Upload report", status: "completed", conclusion: "skipped", startedAt: null, completedAt: null },
    ] },
  ],
  viewer: "e2e",
};
const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : seed;
const save = () => writeFileSync(file, JSON.stringify(s));
const comments = () => [...s.pr.comments.nodes, ...s.pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes)];
let n = 100;
const id = (p) => `${p}_new${Date.now()}${n++}`;

const k = a.slice(0, 2).join(" ");
if (a[0] === "--version") out("gh version 2.99.0 (fake-gh)\n");
else if (k === "auth status") out("Logged in to github.com as e2e (fake)\n");
else if (k === "pr view") {
  const json = a[a.indexOf("--json") + 1] ?? "";
  if (json.includes("body")) out({ number: 7, title: s.pr.title, url: s.pr.url, state: s.pr.state, body: "", headRefName: s.pr.headRefName, baseRefName: s.pr.baseRefName });
  else out({ number: 7, url: s.pr.url });
} else if (k === "pr checks") (out(a.includes("name,bucket,link") ? s.checks.map(({ name, bucket, link }) => ({ name, bucket, link })) : s.checks), process.exit(s.checks.some((x) => x.bucket !== "pass") ? 8 : 0));
else if (k === "pr list") out([{ number: 7, title: s.pr.title, url: s.pr.url, state: s.pr.state }]);
else if (k === "pr ready") (s.pr.isDraft = false, save(), out("✓ ready\n"));
else if (k === "run view" && a.includes("--log-failed")) out("test\tRun tests\t2026-10-09T10:00:01.1Z ##[group]Run pnpm test\ntest\tRun tests\t2026-10-09T10:00:02.1Z not ok 3 - creates a todo for the signed-in user\ntest\tRun tests\t2026-10-09T10:00:02.2Z   AssertionError: expected 500 to equal 201\ntest\tRun tests\t2026-10-09T10:00:03.1Z ##[error]Process completed with exit code 1.\n");
else if (k === "run view") out({ jobs: s.jobs });
else if (k === "run list") out([]);
else if (k === "run rerun") (s.checks.forEach((x) => x.bucket === "fail" && ((x.bucket = "pending"), (x.completedAt = "0001-01-01T00:00:00Z"))), save(), out("✓ Requested rerun\n"));
else if (k === "api graphql" && /^\s*query\b/.test(query)) out({ data: { viewer: { login: s.viewer }, repository: { pullRequest: s.pr } } });
else if (k === "api graphql") {
  const v = (name) => val("-f", name);
  if (query.includes("addPullRequestReviewThreadReply")) s.pr.reviewThreads.nodes.find((t) => t.id === v("id"))?.comments.nodes.push(c(id("PRRC"), s.viewer, "User", v("body"), 0));
  else if (query.includes("addComment")) s.pr.comments.nodes.push(c(id("IC"), s.viewer, "User", v("body"), 0));
  else if (query.includes("unresolveReviewThread")) s.pr.reviewThreads.nodes.find((t) => t.id === v("id")).isResolved = false;
  else if (query.includes("resolveReviewThread")) s.pr.reviewThreads.nodes.find((t) => t.id === v("id")).isResolved = true;
  else if (query.includes("addReaction") || query.includes("removeReaction")) {
    const g = comments().find((x) => x.id === v("id"))?.reactionGroups.find((r) => r.content === v("c"));
    if (g) (g.viewerHasReacted = query.includes("addReaction")), (g.reactors.totalCount += g.viewerHasReacted ? 1 : -1);
  } else if (query.includes("addPullRequestReview")) s.pr.reviews.nodes.push({ id: id("PRR"), state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[v("e")], body: v("body"), submittedAt: at(0), author: { login: s.viewer, __typename: "User" } });
  else fail(`fake-gh: unknown mutation ${query.slice(0, 80)}`);
  save();
  out({ data: {} });
} else fail(`fake-gh: unsupported ${a.join(" ")}`);
