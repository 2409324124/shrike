import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentOptions, Flow, GitState } from "@shrike/schema";
import { branchName, commitMessage, createGit, exec, gitMissing, parseStatus, readGit, type GitDeps } from "./git.ts";
import { listPrs, makeGh, type ExecResult, type Gh } from "./github.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true" } }).trim();

/** A bare "GitHub" remote and a clone of it with one commit on main. */
function repo(): { dir: string; remote: string } {
  const tmp = mkdtempSync(join(tmpdir(), "shrike-git-"));
  const remote = join(tmp, "remote.git");
  const dir = join(tmp, "work");
  sh(tmp, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  sh(tmp, "clone", "--quiet", remote, dir);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) sh(dir, "config", k!, v!);
  writeFileSync(join(dir, "app.ts"), "export const total = 1;\nexport const name = 'shop';\n");
  writeFileSync(join(dir, "notes.md"), "notes\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "--quiet", "-m", "first");
  sh(dir, "push", "--quiet", "-u", "origin", "main");
  return { dir, remote };
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/** gh fake: answers by the first two args; records every call. */
function fakeGh(answers: Record<string, ExecResult | ((args: string[], input?: string) => ExecResult)> = {}): Gh & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args, o) => {
      calls.push(args);
      const a = answers[args.slice(0, 2).join(" ")] ?? answers[args[0]!];
      if (typeof a === "function") return a(args, o.input);
      return a ?? { code: 1, stdout: "", stderr: "no fake for this" };
    },
  };
}

function service(dir: string, over: Partial<GitDeps> = {}) {
  const emitted: GitState[] = [];
  const approvals: { title: string; reason: string }[] = [];
  const agents: { goal: string; opts: AgentOptions }[] = [];
  const ran: string[] = [];
  const deps: GitDeps = {
    root: () => dir,
    gh: fakeGh(),
    approve: async (title, reason) => (approvals.push({ title, reason }), true),
    startAgent: async (goal, opts) => (agents.push({ goal, opts }), { id: "run1", goal, brain: "builtin", status: "running" }),
    issue: async () => "# Checkout fails: total is a string\n\n## What happened\n\nThe server failed.\n\n## What the agent found\n\ntotal was sent as text, so the sum broke.\n",
    shrikeFiles: () => ["app.ts"],
    lastFix: () => "Fix total",
    flows: async () => [],
    runFlow: async (id) => (ran.push(id), { ok: true }),
    emit: (s) => emitted.push(s),
    ...over,
  };
  return { git: createGit(deps), emitted, approvals, agents, ran };
}

test("parseStatus reads branch, upstream, ahead/behind, renames and conflicts", () => {
  const s = parseStatus("## fix/a...origin/fix/a [ahead 2, behind 1]\0 M app.ts\0R  new.ts\0old.ts\0UU both.ts\0?? n/x.ts\0");
  assert.equal(s.branch, "fix/a");
  assert.equal(s.upstream, "origin/fix/a");
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.changed.map((c) => `${c.status} ${c.path}`), ["M app.ts", "R new.ts", "UU both.ts", "?? n/x.ts"]);
  assert.deepEqual(s.conflicts, ["both.ts"]);
  assert.equal(parseStatus("## No commits yet on main\0").branch, "main");
  assert.equal(parseStatus("## HEAD (no branch)\0").branch, undefined);
});

test("words: branch name and commit message come from the verdict and the finding", () => {
  assert.equal(branchName("Checkout fails: total is a string!"), "fix/checkout-fails-total-is-a-string");
  const msg = commitMessage("Checkout fails: total is a string", "# t\n\n## What happened\n\nIt broke.\n\n## What the agent found\n\ntotal was text.\n\n- (observed) more\n");
  assert.equal(msg, "Fix: Checkout fails: total is a string\n\ntotal was text.\n\nFound and fixed with Shrike.");
});

test("readGit: a real repo, a folder that isn't one", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.ts"), "export const total = 2;\n");
  const { state, remote } = await readGit(dir);
  assert.equal(state.isRepo, true);
  assert.equal(state.branch, "main");
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.base, "main");
  assert.equal(remote, "origin");
  assert.deepEqual(state.changed, [{ path: "app.ts", status: "M" }]);
  const plain = (await readGit(mkdtempSync(join(tmpdir(), "shrike-nogit-")))).state;
  assert.deepEqual([plain.isRepo, plain.gitMissing], [false, undefined], "git is there; the folder just isn't a repo");
  // No git at all: spawn ENOENT (127) or macOS's stand-in without the developer tools.
  assert.equal(gitMissing({ code: 127, stderr: "spawn git ENOENT" }), true);
  assert.equal(gitMissing({ code: 1, stderr: "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" }), true);
  assert.equal(gitMissing({ code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }), false);
});

test("G1 shipFix: branches off main, commits only Shrike's files, pushes after approval, opens the PR with the issue", async () => {
  const { dir, remote } = repo();
  writeFileSync(join(dir, "app.ts"), "export const total = Number(1);\nexport const name = 'shop';\n");
  writeFileSync(join(dir, "notes.md"), "my own edit, not Shrike's\n");
  let body = "";
  const gh = fakeGh({
    "--version": ok("gh version 2"),
    "auth status": ok(),
    "pr view": (args) => (args[2] === "7" ? ok(JSON.stringify({ number: 7, title: "Fix: Checkout fails", url: "https://github.com/o/r/pull/7", state: "OPEN", body: "", baseRefName: "main" })) : { code: 1, stdout: "", stderr: "no pull requests found" }),
    "pr checks": ok(JSON.stringify([{ name: "test", bucket: "pending", link: "https://github.com/o/r/actions/runs/1/job/2" }])),
    "pr create": (_args, input) => ((body = input ?? ""), ok("https://github.com/o/r/pull/7\n")),
  });
  const { git, approvals } = service(dir, { gh });
  const pr = await git.shipFix({ actionId: "a1" });
  assert.deepEqual(pr, { number: 7, title: "Fix: Checkout fails", url: "https://github.com/o/r/pull/7", state: "open", checks: [{ name: "test", state: "pending", url: "https://github.com/o/r/actions/runs/1/job/2" }] });
  const branch = sh(dir, "branch", "--show-current");
  assert.equal(branch, "fix/checkout-fails-total-is-a-string");
  assert.equal(sh(dir, "log", "-1", "--format=%B"), "Fix: Checkout fails: total is a string\n\ntotal was sent as text, so the sum broke.\n\nFound and fixed with Shrike.");
  assert.equal(sh(dir, "show", "--name-only", "--format=", "HEAD"), "app.ts");
  assert.equal(sh(dir, "status", "--porcelain"), "M notes.md", "the user's own edit stays uncommitted");
  assert.equal(sh(remote, "rev-parse", branch), sh(dir, "rev-parse", "HEAD"), "pushed");
  assert.equal(sh(remote, "rev-parse", "main"), sh(dir, "rev-parse", "main"), "main untouched");
  assert.equal(approvals.length, 1);
  assert.match(approvals[0]!.title, /^Send fix\/checkout-fails-total-is-a-string to GitHub and open a pull request\?$/);
  assert.match(body, /^# Checkout fails: total is a string/);
  const create = gh.calls.find((c) => c[1] === "create")!;
  assert.deepEqual(create.slice(2, 6), ["--base", "main", "--head", branch]);
});

test("G1 shipFix: the Commit box message, when there is one, is the commit and the PR title", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.ts"), "export const total = Number(1);\n");
  let title = "";
  const gh = fakeGh({
    "--version": ok("gh version 2"),
    "auth status": ok(),
    "pr view": (args) => (args[2] === "8" ? ok(JSON.stringify({ number: 8, title, url: "https://github.com/o/r/pull/8", state: "OPEN", body: "" })) : { code: 1, stdout: "", stderr: "no pull requests found" }),
    "pr checks": ok("[]"),
    "pr create": (args) => ((title = args[args.indexOf("--title") + 1]!), ok("https://github.com/o/r/pull/8\n")),
  });
  const { git, approvals } = service(dir, { gh });
  await git.shipFix({ title: "Total works again", message: "Fix: Add Todo saves the owner again\r\n\r\nThe server read req.body.user.\n" });
  assert.equal(sh(dir, "log", "-1", "--format=%B"), "Fix: Add Todo saves the owner again\n\nThe server read req.body.user.");
  assert.equal(title, "Fix: Add Todo saves the owner again");
  assert.match(approvals[0]!.reason, /your commit "Fix: Add Todo saves the owner again"/);
});

test("G1 shipFix: a denied push keeps the commit local and says so; no gh means push only", async () => {
  const { dir, remote } = repo();
  writeFileSync(join(dir, "app.ts"), "export const total = 3;\n");
  const denied = service(dir, { approve: async () => false, gh: fakeGh({ "--version": { code: 127, stdout: "", stderr: "not found" } }) });
  await assert.rejects(denied.git.shipFix({ title: "Total fix" }), /Not sent\. Your fix is saved as a commit on fix\/total-fix\./);
  assert.throws(() => sh(remote, "rev-parse", "--verify", "--quiet", "fix/total-fix"));

  writeFileSync(join(dir, "app.ts"), "export const total = 4;\n");
  const nogh = service(dir, { gh: fakeGh({ "--version": { code: 127, stdout: "", stderr: "" } }) });
  await assert.rejects(nogh.git.shipFix({}), /Sent fix\/total-fix to GitHub\. To open the pull request from here: Install GitHub's command line tool/);
  assert.equal(nogh.approvals[0]!.title, "Send fix/total-fix to GitHub?");
  assert.equal(sh(remote, "rev-parse", "fix/total-fix"), sh(dir, "rev-parse", "HEAD"));
  const st = await nogh.git.state();
  assert.equal(st.ghReady, false);
  assert.equal(st.ghProblem, "missing");
  await assert.rejects(nogh.git.listPullRequests(), /brew install gh/);
});

test("G1 shipFix: refuses files without changes and an empty ship", async () => {
  const { dir } = repo();
  const { git } = service(dir);
  await assert.rejects(git.shipFix({}), /no changes from Shrike's fixes/);
  await assert.rejects(git.shipFix({ files: ["notes.md"] }), /notes\.md has no changes/);
});

test("G1 shipFix: commits already on a branch (the Changes dock) push after approval and open the PR, nothing new committed", async () => {
  const { dir, remote } = repo();
  sh(dir, "switch", "--quiet", "-c", "shrike/cents");
  writeFileSync(join(dir, "app.ts"), "export const total = 5;\n");
  sh(dir, "commit", "--quiet", "-am", "Total in cents\n\nWhole cents only.");
  const head = sh(dir, "rev-parse", "HEAD");
  let body = "";
  const gh = fakeGh({ "--version": ok("gh version 2"), "auth status": ok(), "pr view": (args) => (args[2] === "8" ? ok(JSON.stringify({ number: 8, title: "Total in cents", url: "https://github.com/o/r/pull/8", state: "OPEN", body: "" })) : { code: 1, stdout: "", stderr: "no pull requests found" }), "pr checks": ok("[]"), "pr create": (_a, input) => ((body = input ?? ""), ok("https://github.com/o/r/pull/8\n")) });
  const { git, approvals } = service(dir, { gh });
  assert.equal((await git.state()).onBranch, 1);
  assert.equal((await git.shipFix({})).number, 8);
  assert.equal(sh(dir, "rev-parse", "HEAD"), head, "no new commit");
  assert.equal(sh(remote, "rev-parse", "shrike/cents"), head, "pushed");
  assert.match(approvals[0]!.reason, /your commit "Total in cents" on shrike\/cents/);
  assert.deepEqual(gh.calls.find((c) => c[1] === "create")!.slice(2, 8), ["--base", "main", "--head", "shrike/cents", "--title", "Total in cents"]);
  assert.equal(body, "Total in cents\n\nWhole cents only.\n");
});

/** main moves on GitHub while the user's branch changes the same line. */
function conflicted(): { dir: string } {
  const { dir } = repo();
  sh(dir, "switch", "--quiet", "-c", "fix/total");
  writeFileSync(join(dir, "app.ts"), "export const total = Number(input);\nexport const name = 'shop';\n");
  sh(dir, "commit", "--quiet", "-am", "mine");
  const other = mkdtempSync(join(tmpdir(), "shrike-other-"));
  sh(other, "clone", "--quiet", sh(dir, "remote", "get-url", "origin"), "o");
  const o = join(other, "o");
  for (const [k, v] of [["user.name", "Other"], ["user.email", "o@example.com"], ["commit.gpgsign", "false"]]) sh(o, "config", k!, v!);
  writeFileSync(join(o, "app.ts"), "export const total = parseInt(input, 10);\nexport const name = 'shop';\n");
  sh(o, "commit", "--quiet", "-am", "theirs: parse the total");
  sh(o, "push", "--quiet", "origin", "main");
  return { dir };
}

test("G6 + G3: sync previews incoming, rebase stops on a real conflict, the agent gets both sides, fixing the file finishes it and re-runs flows", async () => {
  const { dir } = conflicted();
  const flows: Pick<Flow, "id" | "name" | "lastRun">[] = [{ id: "f1", name: "Checkout" }];
  const { git, agents, ran } = service(dir, { flows: async () => flows });
  const preview = await git.syncWithMain({ mode: "preview" });
  assert.deepEqual(preview.incoming?.map((c) => c.subject), ["theirs: parse the total"]);
  assert.equal(preview.operation, undefined);

  const s = await git.syncWithMain();
  assert.equal(s.operation, "rebase", "an unpushed branch rebases");
  assert.deepEqual(s.conflicts, ["app.ts"]);

  await git.resolveConflicts();
  assert.equal(agents[0]!.opts.skillId, "fix-conflicts");
  assert.match(agents[0]!.goal, /parseInt\(input, 10\)/);
  assert.match(agents[0]!.goal, /Number\(input\)/);
  assert.match(agents[0]!.goal, /"theirs" \(the bottom side\) is the user's own change/);

  writeFileSync(join(dir, "app.ts"), "export const total = parseInt(String(input), 10);\nexport const name = 'shop';\n"); // what the applied patch writes
  const after = await git.refresh();
  assert.equal(after?.operation, undefined);
  assert.deepEqual(after?.conflicts, []);
  assert.equal(sh(dir, "log", "-1", "--format=%s"), "mine");
  assert.equal(sh(dir, "log", "-1", "--format=%s", "HEAD~1"), "theirs: parse the total");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ran, ["f1"], "L4: the saved flows re-ran");
});

test("G6: undo a stopped rebase, then merge instead; continue refuses while markers remain", async () => {
  const { dir } = conflicted();
  const { git } = service(dir);
  await git.syncWithMain({ mode: "rebase" });
  await assert.rejects(git.syncWithMain({ mode: "continue" }), /app\.ts still has conflicts/);
  const undone = await git.syncWithMain({ mode: "abort" });
  assert.equal(undone.operation, undefined);
  assert.equal(sh(dir, "log", "-1", "--format=%s"), "mine");
  const merged = await git.syncWithMain({ mode: "merge" });
  assert.equal(merged.operation, "merge");
  writeFileSync(join(dir, "app.ts"), "export const total = 1;\n");
  const done = await git.syncWithMain({ mode: "continue" });
  assert.equal(done.operation, undefined);
  assert.match(sh(dir, "log", "-1", "--format=%s"), /^Merge/);
});

test("G6: a branch already on GitHub merges (no force-push ever); updating main itself asks first", async () => {
  const { dir } = conflicted();
  sh(dir, "push", "--quiet", "-u", "origin", "fix/total");
  const { git, approvals } = service(dir);
  const s = await git.syncWithMain();
  assert.equal(s.operation, "merge");
  await git.syncWithMain({ mode: "abort" });
  sh(dir, "switch", "--quiet", "main");
  const denied = service(dir, { approve: async (t) => (approvals.push({ title: t, reason: "" }), false) });
  await assert.rejects(denied.git.syncWithMain(), /Not updated/);
  assert.equal(approvals.at(-1)!.title, "Update your main branch?");
});

test("G5 merge only when green and flows passed, with approval; G2/G4 start agent runs with the right skill", async () => {
  const { dir } = repo();
  let checks = [{ name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/11/job/22" }];
  const gh = fakeGh({
    "--version": ok(),
    "auth status": ok(),
    "pr view": ok(JSON.stringify({ number: 3, title: "Fix total", url: "u", state: "OPEN", body: "Fixes checkout", headRefName: "fix/total", baseRefName: "main" })),
    "pr checks": () => ok(JSON.stringify(checks)),
    "pr diff": ok("diff --git a/app.ts b/app.ts\n+export const total = 2;\n"),
    "pr merge": ok(),
    "run view": ok("test\tRun tests\t2026-10-08T10:00:00.0000000Z ✗ adds the total\ntest\tRun tests\t2026-10-08T10:00:00.1Z AssertionError: expected '12' to equal 3\n"),
  });
  let flows: Pick<Flow, "id" | "name" | "lastRun">[] = [{ id: "f", name: "Checkout", lastRun: { at: 1, ok: true, actionIds: [] } }];
  const { git, approvals, agents } = service(dir, { gh, flows: async () => flows });
  await assert.rejects(git.mergePullRequest(3), /The "test" check failed/);

  await git.explainCheck(3, "test");
  assert.equal(agents[0]!.opts.skillId, "explain-ci");
  assert.match(agents[0]!.goal, /during "Run tests"\. The first problem it printed: ✗ adds the total/);
  assert.deepEqual(gh.calls.find((c) => c[0] === "run"), ["run", "view", "11", "--job", "22", "--log-failed"]);

  await git.reviewPullRequest(3);
  assert.equal(agents[1]!.opts.skillId, "review-pr");
  assert.match(agents[1]!.goal, /do not call propose_patch/);
  assert.match(agents[1]!.goal, /\+export const total = 2;/);
  assert.match(agents[1]!.goal, /Fixes checkout/);

  checks = [{ name: "test", bucket: "pass", link: "x" }];
  flows = [{ id: "f", name: "Checkout", lastRun: { at: 1, ok: false, actionIds: [] } }];
  await assert.rejects(git.mergePullRequest(3), /Your flow "Checkout" broke/);
  flows = [];
  await git.mergePullRequest(3);
  assert.equal(approvals.at(-1)!.title, "Merge pull request #3 into main?");
  assert.deepEqual(gh.calls.find((c) => c[1] === "merge"), ["pr", "merge", "3", "--squash", "--delete-branch"]);
});

test("state(): the branch's PR with checks, failing ones carry their log summary", async () => {
  const { dir } = repo();
  sh(dir, "switch", "--quiet", "-c", "fix/x");
  const gh = fakeGh({
    "--version": ok(),
    "auth status": ok(),
    "pr view": ok(JSON.stringify({ number: 5, title: "x", url: "u", state: "OPEN" })),
    "pr checks": { code: 1, stdout: JSON.stringify([{ name: "lint", bucket: "fail", link: "https://github.com/o/r/actions/runs/9" }, { name: "build", bucket: "pass" }]), stderr: "" },
    "run view": ok("lint\tLint\t2026-10-08T10:00:00Z src/a.ts:3:1 error 'x' is never used\n"),
  });
  const s = await service(dir, { gh }).git.state();
  assert.equal(s.ghReady, true);
  assert.equal(s.pr?.number, 5);
  assert.deepEqual(s.pr?.checks.map((c) => c.state), ["fail", "pass"]);
  assert.match(s.pr?.checks[0]?.summary ?? "", /"lint" check failed during "Lint"\. The first problem it printed: src\/a\.ts:3:1 error/);
});

test("prSeen: the PR panel's green re-run refreshes the state, so the rail stops saying the check failed", async () => {
  const { dir } = repo();
  sh(dir, "switch", "--quiet", "-c", "fix/x");
  let bucket = "fail";
  const gh = fakeGh({
    "--version": ok(),
    "auth status": ok(),
    "pr view": ok(JSON.stringify({ number: 5, title: "x", url: "u", state: "OPEN" })),
    "pr checks": () => ({ code: bucket === "pass" ? 0 : 1, stdout: JSON.stringify([{ name: "Test", bucket }]), stderr: "" }),
    "run view": ok(""),
  });
  const { git, emitted } = service(dir, { gh });
  await git.refresh();
  assert.equal(emitted.at(-1)?.pr?.checks[0]?.state, "fail");
  assert.equal(git.prSeen(5, [{ name: "Test", state: "fail" }]), undefined, "same checks: no refresh");
  bucket = "pass";
  assert.equal(git.prSeen(6, [{ name: "Test", state: "pass" }]), undefined, "another PR: no refresh");
  await git.prSeen(5, [{ name: "Test", state: "pass" }]);
  assert.equal(emitted.at(-1)?.pr?.checks[0]?.state, "pass");
});

test("a gh that never answers (packets dropped) is stopped and reads as a network problem", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "shrike-gh-hang-")), "gh");
  writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n", { mode: 0o755 }); // one process, like the real gh binary
  const prev = process.env.SHRIKE_GH_BIN;
  process.env.SHRIKE_GH_BIN = bin;
  try {
    const gh = makeGh((cmd, args, o) => exec(cmd, args, { ...o, timeoutMs: 500 }));
    const t = Date.now();
    await assert.rejects(listPrs(gh, tmpdir()), /^Error: Couldn't list pull requests\. The network didn't answer\. Check your internet connection/);
    assert.ok(Date.now() - t < 5000);
  } finally {
    if (prev === undefined) delete process.env.SHRIKE_GH_BIN;
    else process.env.SHRIKE_GH_BIN = prev;
  }
});
