import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workspace } from "@shrike/schema";
import { groupOf, grouped, parsePorcelain, parseSmart, slugName } from "./logic.ts";

test("WS2 Smart: name, #12, branch, PR URL, issue URL, Jira URL", () => {
  const kind = (t: string, b?: string[]) => {
    const s = parseSmart(t, b);
    return s && { ...s, say: undefined };
  };
  assert.deepEqual(kind("Fix the login page"), { kind: "name", name: "fix-the-login-page", say: undefined });
  assert.deepEqual(kind("#12"), { kind: "pr", number: 12, say: undefined });
  assert.deepEqual(kind("1234"), { kind: "pr", number: 1234, say: undefined });
  assert.deepEqual(kind("https://github.com/acme/shop/pull/77/files"), { kind: "pr", number: 77, url: "https://github.com/acme/shop/pull/77/files", say: undefined });
  assert.deepEqual(kind("https://github.com/acme/shop/issues/9"), { kind: "name", name: "issue-9", note: "https://github.com/acme/shop/issues/9", say: undefined });
  assert.deepEqual(kind("https://acme.atlassian.net/browse/SHOP-42"), { kind: "name", name: "shop-42", note: "https://acme.atlassian.net/browse/SHOP-42", say: undefined });
  assert.deepEqual(kind("SHOP-42"), { kind: "name", name: "shop-42", note: "SHOP-42", say: undefined });
  assert.deepEqual(kind("feature/cart"), { kind: "branch", branch: "feature/cart", say: undefined });
  assert.deepEqual(kind("cart-v2", ["main", "origin/cart-v2"]), { kind: "branch", branch: "origin/cart-v2", say: undefined }, "a known branch wins over a name");
  assert.deepEqual(kind("cart-v2"), { kind: "name", name: "cart-v2", say: undefined });
  assert.deepEqual(kind("feature/new-thing", ["main"]), { kind: "name", name: "feature-new-thing", say: undefined }, "a branch that doesn't exist is a new name");
  assert.equal(parseSmart("   "), null);
  assert.equal(parseSmart("#12")!.say, "Pull request #12");
  assert.equal(slugName("Feature/Login page!!"), "feature-login-page");
  assert.equal(slugName("x".repeat(60)).length, 40);
});

test("WS1 grouping by status, most urgent first", () => {
  const w = (name: string, agent: Workspace["agent"], pr?: NonNullable<Workspace["pr"]>["state"]): Workspace => {
    const base = { path: `/p/${name}`, projectRoot: "/p", project: "p", name, kind: "shrike", branch: name, current: false, running: false, portOffset: 0, agent, ...(pr ? { pr: { number: 1, state: pr, url: "" } } : {}) } as Omit<Workspace, "group">;
    return { ...base, group: groupOf(base) };
  };
  const list = [w("a", "idle"), w("b", "working"), w("c", "waiting", "open"), w("d", "done", "open"), w("e", "idle", "merged"), w("f", "done")];
  assert.deepEqual(list.map((x) => x.group), ["idle", "working", "needs-you", "review", "done", "idle"]);
  assert.deepEqual(grouped(list).map((g) => [g.word, g.items.map((x) => x.name).join("")]), [
    ["Needs you", "c"],
    ["Working", "b"],
    ["Ready for review", "d"],
    ["Idle", "af"],
    ["Done", "e"],
  ]);
});

test("porcelain: main first, detached and prunable worktrees", () => {
  const out = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.shrike/worktrees/x\nHEAD bbb\ndetached\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n";
  assert.deepEqual(parsePorcelain(out), [
    { path: "/r", branch: "main", head: "aaa", prunable: false },
    { path: "/r/.shrike/worktrees/x", branch: "", head: "bbb", prunable: false },
    { path: "/gone", branch: "old", head: "ccc", prunable: true },
  ]);
});
