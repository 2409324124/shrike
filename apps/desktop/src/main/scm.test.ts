import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ScmState } from "@shrike/schema";
import type { Exec } from "./github.ts";
import { resolveRecipe } from "./recipes.ts";
import { cleanMessage, createScm, githubWeb, parseNameStatus, parseNumstat, parsePorcelainV2, parseUnifiedDiff, type ScmDeps } from "./scm.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const exec: Exec = (cmd, args, o) =>
  new Promise((done) => {
    const c = execFile(cmd, args, { cwd: o.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    c.stdin?.end(o.input ?? "");
  });

test("porcelain v2: staged and unstaged halves, renames, conflicts, untracked, branch line", () => {
  const out = [
    "# branch.oid 1234",
    "# branch.head fix/user id",
    "# branch.upstream origin/fix/user id",
    "# branch.ab +2 -1",
    "1 MM N... 100644 100644 100644 aaa bbb src/app.ts",
    "1 A. N... 000000 100644 100644 000 ccc src/new file.ts",
    "1 .D N... 100644 100644 000000 ddd ddd gone.ts",
    "2 R. N... 100644 100644 100644 eee eee R92 src/after.ts",
    "src/before.ts",
    "u UU N... 100644 100644 100644 100644 f1 f2 f3 both.ts",
    "? notes/todo.md",
    "",
  ].join("\0");
  const p = parsePorcelainV2(out);
  assert.deepEqual([p.branch, p.upstream, p.ahead, p.behind], ["fix/user id", "origin/fix/user id", 2, 1]);
  assert.deepEqual(
    p.files.map((f) => `${f.area}:${f.letter}:${f.oldPath ? `${f.oldPath}>` : ""}${f.path}`),
    ["staged:M:src/app.ts", "changes:M:src/app.ts", "staged:A:src/new file.ts", "changes:D:gone.ts", "staged:R:src/before.ts>src/after.ts", "conflicts:!:both.ts", "untracked:U:notes/todo.md"],
  );
  assert.equal(parsePorcelainV2("# branch.head (detached)\0").branch, undefined);
});

test("numstat and name-status: renames, binary, diff hunks keep line numbers", () => {
  const n = parseNumstat(["3\t1\tsrc/app.ts", "0\t0\t", "src/before.ts", "src/after.ts", "-\t-\tlogo.png", ""].join("\0"));
  assert.deepEqual(Object.fromEntries(n), { "src/app.ts": { added: 3, removed: 1 }, "src/after.ts": { added: 0, removed: 0 }, "logo.png": {} });
  assert.deepEqual(parseNameStatus(["M", "a.ts", "R100", "old.ts", "new.ts", "D", "x.ts", ""].join("\0"), "branch").map((f) => [f.letter, f.oldPath, f.path]), [["M", undefined, "a.ts"], ["R", "old.ts", "new.ts"], ["D", undefined, "x.ts"]]);
  const d = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,3 @@ function f() {\n a\n-b\n+B\n c\n\\ No newline at end of file\n");
  assert.equal(d.hunks[0]!.header, "function f() {");
  assert.deepEqual(d.hunks[0]!.lines, [{ kind: "ctx", text: "a", old: 2, new: 2 }, { kind: "del", text: "b", old: 3 }, { kind: "add", text: "B", new: 3 }, { kind: "ctx", text: "c", old: 4, new: 4 }]);
  assert.equal(parseUnifiedDiff("Binary files a/x.png and b/x.png differ\n").binary, true);
  assert.equal(githubWeb("git@github.com:juspay/xyne-spaces.git"), "https://github.com/juspay/xyne-spaces");
  assert.equal(githubWeb("https://github.com/a/b"), "https://github.com/a/b");
  assert.equal(githubWeb("https://gitlab.com/a/b.git"), undefined);
  assert.equal(cleanMessage("Here's the commit message:\n\n```\nFix: totals\n\nBody\n```"), "Fix: totals\n\nBody");
});

/** A bare "GitHub" remote, main pushed, and a feature branch with one commit of its own. */
function repo(): { dir: string; remote: string } {
  const tmp = mkdtempSync(join(tmpdir(), "shrike-scm-"));
  const remote = join(tmp, "remote.git");
  const dir = join(tmp, "work");
  sh(tmp, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  sh(tmp, "clone", "--quiet", remote, dir);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) sh(dir, "config", k!, v!);
  writeFileSync(join(dir, "app.ts"), "export const total = 1;\nexport const name = 'shop';\n");
  writeFileSync(join(dir, "old.ts"), "one\ntwo\nthree\nfour\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "--quiet", "-m", "first");
  sh(dir, "push", "--quiet", "-u", "origin", "main");
  sh(dir, "switch", "--quiet", "-c", "fix/total");
  writeFileSync(join(dir, "app.ts"), "export const total = 2;\nexport const name = 'shop';\nexport const tax = 0;\n");
  sh(dir, "commit", "--quiet", "-am", "Fix: total");
  return { dir, remote };
}

function deps(dir: string, o: Partial<ScmDeps> = {}) {
  const seen: { approvals: string[]; prompts: string[]; used: string[]; emitted: ScmState[] } = { approvals: [], prompts: [], used: [], emitted: [] };
  const d: ScmDeps = {
    root: () => dir,
    exec,
    approve: async (title) => (seen.approvals.push(title), true),
    writeText: async (p) => (seen.prompts.push(p), "Add tax to the totals\n\nThe cart shows tax now."),
    emit: (s) => seen.emitted.push(s),
    changed: () => {},
    used: (id) => seen.used.push(id),
    ...o,
  };
  return { d, seen };
}

const rows = (s: ScmState) => s.files.map((f) => `${f.area}:${f.letter}:${f.path}${f.added !== undefined ? ` +${f.added}-${f.removed}` : ""}`).sort();

test("a scratch repo: sections with counts, committed on this branch, stage, unstage, commit, undo, discard, sync", { timeout: 60_000 }, async () => {
  const { dir, remote } = repo();
  const { d, seen } = deps(dir);
  const scm = createScm(d);
  try {
    writeFileSync(join(dir, "app.ts"), "export const total = 3;\nexport const name = 'shop';\nexport const tax = 0;\n");
    sh(dir, "mv", "old.ts", "renamed.ts");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new.ts"), "a\nb\n");
    let s = await scm.state();
    assert.deepEqual([s.branch, s.base, s.baseAhead, s.baseBehind, s.upstream, s.web], ["fix/total", "main", 1, 0, undefined, false]);
    assert.deepEqual(rows(s), ["branch:M:app.ts +2-1", "changes:M:app.ts +1-1", "staged:R:renamed.ts +0-0", "untracked:U:src/new.ts +2-0"]);
    assert.equal(s.files.find((f) => f.area === "staged")!.oldPath, "old.ts");
    assert.deepEqual(s.commits.map((c) => [c.subject, c.mine, c.pushed]), [["Fix: total", true, false], ["first", false, true]]);
    assert.ok(seen.emitted.length >= 1, "the dock gets the state");

    const diff = await scm.diff({ path: "app.ts", area: "changes" });
    assert.deepEqual(diff.hunks[0]!.lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind}:${l.text}`), ["del:export const total = 2;", "add:export const total = 3;"]);
    assert.equal((await scm.diff({ path: "src/new.ts", area: "untracked" })).hunks[0]!.lines.length, 2);
    await assert.rejects(scm.diff({ path: "../etc/passwd", area: "changes" }), /isn't in this project/);
    await assert.rejects(scm.stage(["nope.ts"]), /isn't in that list/);

    s = await scm.stage(["src/new.ts"]);
    assert.ok(rows(s).includes("staged:A:src/new.ts +2-0"));
    s = await scm.unstage(["renamed.ts"]);
    assert.ok(!s.files.some((f) => f.area === "staged" && f.path === "renamed.ts"), "unstaging a rename unstages both halves");

    // Write it for me: the Commit message recipe gets the branch, staged files and staged patch.
    const msg = await scm.writeMessage();
    assert.equal(msg, "Add tax to the totals\n\nThe cart shows tax now.");
    assert.match(seen.prompts[0]!, /Branch: fix\/total/);
    assert.match(seen.prompts[0]!, /A src\/new\.ts/);
    assert.match(seen.prompts[0]!, /<patch>[\s\S]*\+a\n\+b[\s\S]*<\/patch>/);
    assert.doesNotMatch(seen.prompts[0]!, /export const total = 3/, "only what's staged");

    s = await scm.commit(msg);
    assert.equal(sh(dir, "log", "-1", "--format=%s"), "Add tax to the totals");
    assert.equal(s.undo, "Add tax to the totals");
    assert.deepEqual(seen.used, ["commit-message"], "an AI-written message that landed counts as a use");
    assert.ok(!s.files.some((f) => f.path === "src/new.ts" && f.area !== "branch"));
    s = await scm.undoCommit();
    assert.equal(s.undo, undefined);
    assert.equal(sh(dir, "log", "-1", "--format=%s"), "Fix: total");
    assert.ok(rows(s).includes("staged:A:src/new.ts +2-0"), "undo puts the changes back as staged");

    // Discard waits on an approval; Not now leaves the file.
    const no = createScm(deps(dir, { approve: async () => false }).d);
    await assert.rejects(no.discard(["app.ts"]), /Not thrown away/);
    assert.match(readFileSync(join(dir, "app.ts"), "utf8"), /total = 3/);
    no.stop();
    s = await scm.discard(["app.ts", "renamed.ts"]);
    assert.match(readFileSync(join(dir, "app.ts"), "utf8"), /total = 2/);
    assert.ok(!existsSync(join(dir, "renamed.ts")), "an untracked file is deleted");
    assert.ok(seen.approvals.some((t) => t === "Throw away your changes to 2 files?"));

    // Nothing staged: Commit takes every change.
    sh(dir, "restore", "--staged", ".");
    s = await scm.commit("Everything");
    assert.equal(s.files.filter((f) => f.area !== "branch").length, 0);

    // Sync: a new branch is pushed only after Allow, never forced.
    s = await scm.sync();
    assert.ok(seen.approvals.includes("Send fix/total to GitHub?"));
    assert.equal(sh(remote, "rev-parse", "fix/total"), sh(dir, "rev-parse", "HEAD"));
    assert.deepEqual([s.upstream, s.ahead, s.undo], ["origin/fix/total", 0, undefined]);
    assert.ok(s.commits.every((c) => c.pushed));
  } finally {
    scm.stop();
  }
});

test("the Commit message recipe renders its skill and variables", async () => {
  const base = mkdtempSync(join(tmpdir(), "shrike-scm-recipe-"));
  const dirs = { builtin: join(import.meta.dirname, "../../../../prompts/skills"), personal: join(base, "p"), claude: join(base, "c"), state: join(base, "s") };
  const r = await resolveRecipe("commit-message", { branch: "fix/a", stagedFiles: "M app.ts", stagedPatch: "+x" }, dirs);
  assert.equal(r.skillId, "commit-message");
  assert.match(r.prompt, /^# Write a commit message/m, "{basePrompt} is the skill body");
  assert.match(r.prompt, /Branch: fix\/a\nStaged files:\nM app\.ts\n\n<patch>\n\+x\n<\/patch>/);
  assert.doesNotMatch(r.prompt, /\{(branch|stagedFiles|stagedPatch)\}/);
});
