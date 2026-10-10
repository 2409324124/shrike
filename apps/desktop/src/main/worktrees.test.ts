import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adoptFix, changedFiles, createWorktree, git, listWorktrees, mainRoot, pickOffset, removeWorktree, unmergedFiles, worktreePath } from "./worktrees.ts";

async function repo(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shrike-wt-")));
  mkdirSync(join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(join(root, "node_modules/dep/index.js"), "export default 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(root, "a.ts"), "export const total = 49;\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  await git(root, ["init", "-q", "-b", "trunk"]);
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return root;
}

test("W1/W5: create, list, change, adopt and remove a worktree in a throwaway repo", async () => {
  const main = await repo();
  writeFileSync(join(main, "a.ts"), "export const total = 49; // wip\n"); // uncommitted
  writeFileSync(join(main, "new.ts"), "export {};\n"); // untracked

  const [a, b] = await Promise.all([createWorktree(main, "fix-cents", "race: approach A"), createWorktree(main, "try-b")]); // at once, like a race
  assert.equal(a.portOffset, 100);
  assert.equal(b.portOffset, 200);
  assert.equal(a.path, worktreePath(main, "fix-cents"));
  assert.equal(readFileSync(join(a.path, "a.ts"), "utf8"), "export const total = 49; // wip\n", "starts from your code as it is now");
  assert.ok(existsSync(join(a.path, "new.ts")));
  assert.ok(existsSync(join(a.path, "node_modules/dep/index.js")), "deps are linked");
  mkdirSync(join(a.path, "node_modules/.vite"));
  assert.ok(!existsSync(join(main, "node_modules/.vite")), "but caches stay per worktree");
  assert.ok(existsSync(join(a.path, ".env")));
  assert.equal(await mainRoot(a.path), main);
  assert.deepEqual(await changedFiles(main, "fix-cents"), []);
  assert.equal((await git(main, ["status", "--porcelain"])).includes(".shrike"), false, "worktrees don't show in your git status");

  const list = await listWorktrees(main);
  assert.deepEqual(list.map((w) => [w.name, w.branch, w.portOffset, w.note]), [
    ["main", "trunk", 0, undefined],
    ["fix-cents", "shrike/fix-cents", 100, "race: approach A"],
    ["try-b", "shrike/try-b", 200, undefined],
  ]);
  await assert.rejects(createWorktree(main, "fix-cents"), /already a worktree/);
  await assert.rejects(createWorktree(main, "../x"), /short name/);

  writeFileSync(join(a.path, "a.ts"), "export const total = 4900; // wip\n");
  writeFileSync(join(a.path, "added.ts"), "export const x = 1;\n");
  assert.deepEqual(await changedFiles(main, "fix-cents"), ["a.ts", "added.ts"]);
  assert.deepEqual(await unmergedFiles(main, "fix-cents"), ["a.ts", "added.ts"]);
  assert.deepEqual((await adoptFix(main, "fix-cents")).sort(), ["a.ts", "added.ts"]);
  assert.deepEqual(await unmergedFiles(main, "fix-cents"), [], "once brought over, removing it loses nothing");
  assert.equal(readFileSync(join(main, "a.ts"), "utf8"), "export const total = 4900; // wip\n");
  assert.ok(existsSync(join(main, "added.ts")));
  assert.equal((await git(main, ["diff", "--cached", "--name-only"])).trim(), "", "nothing staged in your checkout");

  writeFileSync(join(b.path, "a.ts"), "export const total = 1;\n");
  await assert.rejects(adoptFix(main, "try-b"), /didn't bring it over/);
  assert.equal(readFileSync(join(main, "a.ts"), "utf8"), "export const total = 4900; // wip\n", "a conflicting fix changes nothing");

  await removeWorktree(main, "fix-cents");
  await removeWorktree(main, "try-b");
  assert.deepEqual((await listWorktrees(main)).map((w) => w.name), ["main"]);
  assert.ok(existsSync(join(main, "node_modules/dep/index.js")), "removing a worktree keeps your node_modules");
  assert.equal((await git(main, ["branch", "--list", "shrike/*"])).trim(), "");
  assert.equal((await createWorktree(main, "again")).portOffset, 100, "freed offsets are reused");
});

test("not a git repo: plain words", async () => {
  await assert.rejects(mainRoot(mkdtempSync(join(tmpdir(), "shrike-nogit-"))), /isn't a git repository/);
});

test("W2: offsets skip the project's own port gaps; odd untracked files copy; .shrike state and run files stay out of a fix", async () => {
  assert.equal(pickOffset([], [5173, 3001]), 100);
  assert.equal(pickOffset([], [3000, 3100]), 200, "3000+100 would land on 3100");
  assert.equal(pickOffset([200], [3000, 3100]), 400, "300 is 100 from 200: two worktrees would clash");
  assert.equal(pickOffset([200, 400], [3000, 3100]), 600);
  assert.equal(pickOffset([100], []), 200);

  const main = await repo();
  mkdirSync(join(main, ".shrike/flows"), { recursive: true });
  writeFileSync(join(main, ".shrike/flows/f.json"), "{}\n");
  await git(main, ["add", "-A"]);
  await git(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "flow"]);
  symlinkSync("nope", join(main, "dangling"));
  mkdirSync(join(main, "vendor/lib"), { recursive: true });
  writeFileSync(join(main, "vendor/lib/x.js"), "1\n");
  await git(join(main, "vendor/lib"), ["init", "-q"]);

  const w = await createWorktree(main, "w4", undefined, [3000, 3100]);
  assert.equal(w.portOffset, 200);
  writeFileSync(join(w.path, "a.ts"), "export const total = 4900;\n");
  writeFileSync(join(w.path, ".shrike/flows/f.json"), '{"lastRun":1}\n');
  writeFileSync(join(w.path, "server.log"), "ran\n");
  assert.deepEqual(await changedFiles(main, "w4"), ["a.ts", "server.log"], ".shrike state isn't a change");
  writeFileSync(join(main, ".shrike/flows/f.json"), '{"lastRun":2}\n');
  assert.deepEqual(await adoptFix(main, "w4", ["a.ts"]), ["a.ts"], "only the fix's own files come over");
  assert.ok(!existsSync(join(main, "server.log")));
  assert.equal(readFileSync(join(main, ".shrike/flows/f.json"), "utf8"), '{"lastRun":2}\n');
  await removeWorktree(main, "w4");

  // a half-made worktree (folder and branch, no metadata) can still be removed and its name reused
  await git(main, ["worktree", "add", "-b", "shrike/w5", worktreePath(main, "w5"), "HEAD"]);
  await removeWorktree(main, "w5");
  assert.equal((await git(main, ["branch", "--list", "shrike/*"])).trim(), "");
  await createWorktree(main, "w5");
  await removeWorktree(main, "w5");

  // a copy that fails part-way is rolled back
  writeFileSync(join(main, "locked.txt"), "x\n");
  chmodSync(join(main, "locked.txt"), 0);
  await assert.rejects(createWorktree(main, "w6"), /didn't make it/);
  assert.equal((await git(main, ["worktree", "list"])).trim().split("\n").length, 1);
  assert.equal((await git(main, ["branch", "--list", "shrike/*"])).trim(), "");
  chmodSync(join(main, "locked.txt"), 0o644);
  await createWorktree(main, "w6");
  await removeWorktree(main, "w6");
});
