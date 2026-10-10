import { test } from "node:test";
import assert from "node:assert/strict";
import type { Worktree } from "@shrike/schema";
import { withBranch } from "./worktrees.ts";

test("the open tab's branch follows a checkout made outside Shrike", () => {
  const w = (name: string, branch: string, current: boolean): Worktree => ({ name, path: `/p/${name}`, branch, current, running: false, portOffset: 0 });
  const list = [w("main", "main", true), w("fix", "fix-x", false)];
  assert.deepEqual(withBranch(list, "feature-y")!.map((x) => x.branch), ["feature-y", "fix-x"]);
  assert.equal(withBranch(list, "main"), list, "no change, same list");
  assert.equal(withBranch(list, undefined), list, "a detached HEAD keeps the last name");
  assert.equal(withBranch(null, "main"), null);
});
