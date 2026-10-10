import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScmDiffLine, ScmState } from "@shrike/schema";
import { askLine, branchMap, changedRange, commitWords, inlineRows, paint, splitRows, statusWords, syncWords } from "./logic.ts";

const base: ScmState = { isRepo: true, branch: "fix/a", upstream: "origin/fix/a", ahead: 0, behind: 0, base: "main", baseAhead: 0, baseBehind: 0, remote: "origin", web: true, pull: "ff-only", files: [], commits: [] };
const c = (sha: string, pushed: boolean, mine = true) => ({ sha, short: sha, author: "me", at: 0, subject: sha, mine, pushed });

test("plain words: unsaved, unsent, conflicts, all clear", () => {
  assert.deepEqual(statusWords(base).map((w) => w.text), ["Everything is saved and on GitHub."]);
  const s: ScmState = { ...base, ahead: 2, baseBehind: 1, files: [{ path: "a.ts", letter: "M", area: "staged" }, { path: "a.ts", letter: "M", area: "changes" }, { path: "b.ts", letter: "!", area: "conflicts" }] };
  assert.deepEqual(statusWords(s).map((w) => w.text), ["1 file with conflicts", "1 change not saved to git yet", "2 commits not on GitHub yet", "main moved on by 1 commit"]);
  assert.equal(commitWords(s).can, false);
  assert.equal(commitWords({ ...base, files: [{ path: "x", letter: "U", area: "untracked" }] }).label, "Commit all 1 change");
  assert.equal(syncWords({ ...base, ahead: 1, behind: 2 }).label, "Sync ↓2 ↑1");
  assert.equal(syncWords({ ...base, upstream: undefined }).label, "Send to GitHub");
});

test("branch map: oldest first, hollow when only here, capped", () => {
  const s: ScmState = { ...base, baseAhead: 3, baseBehind: 2, commits: [c("3", false), c("2", true), c("1", true), c("0", true, false)], files: [{ path: "x", letter: "M", area: "changes" }] };
  assert.deepEqual(branchMap(s, true), { onBase: false, base: "main", behind: 2, mine: [true, true, false], more: 0, dirty: true, pr: true });
  const big = branchMap({ ...s, baseAhead: 10, commits: Array.from({ length: 10 }, (_, i) => c(String(i), i > 0)) }, false, 4);
  assert.deepEqual([big.mine, big.more], [[true, true, true, false], 6]);
  assert.equal(branchMap({ ...base, branch: "main", ahead: 1, commits: [c("9", false, false)] }, true).pr, false, "no PR on the base branch");
});

test("diff rows: pairs, split padding, changed words keep token colours", () => {
  const L = (kind: ScmDiffLine["kind"], text: string, o?: number, n?: number): ScmDiffLine => ({ kind, text, ...(o ? { old: o } : {}), ...(n ? { new: n } : {}) });
  const lines = [L("ctx", "a", 1, 1), L("del", "userId: user", 2), L("del", "x", 3), L("add", "userId: userId", undefined, 2), L("ctx", "z", 4, 3)];
  assert.deepEqual(inlineRows(lines).map((r) => [r.kind, r.pair]), [["ctx", undefined], ["del", "userId: userId"], ["del", undefined], ["add", "userId: user"], ["ctx", undefined]]);
  const sp = splitRows(lines);
  assert.equal(sp.length, 4);
  assert.equal(sp[2]!.right, undefined, "the extra del has an empty right side");
  assert.deepEqual(changedRange("userId: userId", "userId: user"), [12, 14]);
  assert.equal(changedRange("same", "same"), undefined);
  const painted = paint([{ content: "userId: ", color: "a" }, { content: "userId", color: "b" }], [12, 14]);
  assert.deepEqual(painted, [{ content: "userId: ", color: "a" }, { content: "user", color: "b" }, { content: "Id", color: "b", lit: true }]);
  const ask = askLine({ path: "src/x.ts", binary: false, hunks: [{ header: "", lines }] }, "the staged changes");
  assert.match(ask, /^Context: the staged changes to src\/x\.ts, around line 2:\n-userId: user\n-x\n\+userId: userId$/);
});
