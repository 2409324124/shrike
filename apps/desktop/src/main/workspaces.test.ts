import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApprovalRequest } from "@shrike/schema";
import { createWorkspaces } from "./workspaces.ts";
import { git } from "./worktrees.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];
const commit = (cwd: string, m: string) => git(cwd, [...ID, "commit", "-qam", m]);

/** origin (bare) with trunk, feature/cart and a PR ref; a clone with a local branch. */
async function repos(): Promise<{ main: string; origin: string; dir: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shrike-ws-")));
  const origin = join(dir, "origin.git");
  const main = join(dir, "shop");
  await git(dir, ["init", "-q", "--bare", "-b", "trunk", origin]);
  await git(dir, ["clone", "-q", origin, main]);
  writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(main, ".env"), "SECRET=1\n");
  writeFileSync(join(main, ".gitignore"), ".env\n");
  await git(main, ["add", "-A"]);
  await commit(main, "init");
  await git(main, ["push", "-q", "origin", "trunk"]);
  await git(main, ["checkout", "-qb", "feature/cart"]);
  writeFileSync(join(main, "a.ts"), "export const a = 2;\n");
  await commit(main, "cart");
  await git(main, ["push", "-q", "origin", "feature/cart"]);
  await git(main, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
  await git(main, ["push", "-q", "origin", "HEAD:refs/pull/8/head"]);
  await git(main, ["checkout", "-q", "trunk"]);
  await git(main, ["branch", "-qD", "feature/cart"]); // remote only now
  await git(main, ["branch", "-q", "local-x"]);
  return { main, origin, dir };
}

test("WS1/WS2: list, create from PR (fake gh) / branch / name, offsets, groups, delete asks first", async () => {
  const { main, dir } = await repos();
  const ghCalls: string[] = [];
  const asked: Omit<ApprovalRequest, "id">[] = [];
  let answer = false;
  let current: string | null = main;
  const ws = createWorkspaces({
    file: join(dir, "workspaces.json"),
    current: () => current,
    status: (p) => (p === main ? { state: "running", url: "http://localhost:5180" } : undefined),
    portsOf: async () => [5180, 4100],
    requestApproval: async (r) => (asked.push(r), answer),
    stopBackground: async () => {},
    emit: () => {},
    // ponytail: a stand-in for gh; real gh is only ever called read-only.
    gh: async (args, cwd) => {
      ghCalls.push(args.slice(0, 2).join(" "));
      if (args[0] === "pr" && args[1] === "list") return { code: 0, stderr: "", stdout: JSON.stringify([{ number: 7, title: "Cart", state: "OPEN", headRefName: "pr-cart", url: "https://github.com/acme/shop/pull/7", isDraft: false, author: { login: "sam" } }]) };
      if (args[0] === "pr" && args[1] === "checkout" && args[2] === "7") {
        await git(cwd, ["fetch", "-q", "origin", "pull/7/head:pr-cart"]);
        await git(cwd, ["checkout", "-q", "pr-cart"]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unknown" };
    },
  });

  const first = await ws.list();
  assert.deepEqual(first.map((w) => [w.name, w.kind, w.branch, w.group, w.running, w.port, w.project]), [["main", "main", "trunk", "idle", true, 5180, "shop"]]);

  const src = await ws.sources(main);
  assert.equal(src.current, "trunk");
  assert.deepEqual(src.prs, [{ number: 7, title: "Cart", branch: "pr-cart", author: "sam" }]);
  assert.ok(src.branches.some((b) => b.name === "origin/feature/cart" && b.remote));
  assert.ok(src.branches.some((b) => b.name === "local-x" && !b.remote));

  const pr = await ws.create({ project: main, from: { kind: "smart", text: "#7" } });
  assert.deepEqual([pr.name, pr.branch, pr.kind, pr.pr?.number, pr.group, pr.portOffset], ["pr-7", "pr-cart", "shrike", 7, "review", 100]);
  assert.ok(ghCalls.includes("pr checkout"));
  const pr8 = await ws.create({ project: main, from: { kind: "pr", number: 8 } });
  assert.deepEqual([pr8.name, pr8.branch], ["pr-8", "pr-8"], "gh couldn't check it out: git fetches pull/8/head itself");
  assert.equal(await ws.remove(pr8.path), true);

  const br = await ws.create({ project: main, from: { kind: "smart", text: "origin/feature/cart" }, copyEnv: false });
  assert.deepEqual([br.name, br.branch, br.ahead, br.behind, br.portOffset], ["feature-cart", "feature/cart", 0, 0, 200]);
  assert.equal(await git(br.path, ["show", "HEAD:a.ts"]), "export const a = 2;\n", "the branch's own code");

  writeFileSync(join(main, "a.ts"), "export const a = 99; // wip\n");
  const nm = await ws.create({ project: main, from: { kind: "name", name: "Try Cents" }, base: "local-x", portOffset: 700 });
  assert.deepEqual([nm.name, nm.branch, nm.portOffset, nm.changes], ["try-cents", "shrike/try-cents", 700, 0]);
  assert.equal(await git(nm.path, ["show", "HEAD:a.ts"]), "export const a = 1;\n", "a base branch starts clean, without your wip");
  await assert.rejects(ws.create({ project: main, from: { kind: "name", name: "other" }, portOffset: 700 }), /taken/);
  await assert.rejects(ws.create({ project: main, from: { kind: "branch", branch: "feature/cart" } }), /feature\/cart is already open in feature-cart/);
  await assert.rejects(ws.create({ project: main, from: { kind: "branch", branch: "nope" } }), /no branch called nope/);

  await git(main, ["worktree", "add", "-q", join(dir, "outside"), "local-x"]);
  const all = await ws.list();
  assert.equal(all[0]!.name, "main");
  assert.deepEqual(all.map((w) => `${w.name}:${w.kind}`).sort(), ["feature-cart:shrike", "main:main", "outside:git", "pr-7:shrike", "try-cents:shrike"], "worktrees made outside Shrike show too");
  assert.equal(all.find((w) => w.name === "main")!.changes, 1);

  // agent dots: a run belongs to the folder open when it started
  ws.observe("agent:status", { id: "r1", status: "running" });
  ws.observe("approval:request", {});
  current = nm.path;
  ws.observe("agent:status", { id: "r2", status: "running" });
  let l = await ws.list();
  assert.equal(l.find((w) => w.name === "main")!.group, "needs-you");
  assert.equal(l.find((w) => w.name === "try-cents")!.group, "working");
  current = main;
  ws.observe("approval:resolved", {});
  assert.equal((await ws.list()).find((w) => w.name === "main")!.agent, "working", "back to what it was");
  current = nm.path;
  ws.observe("agent:status", { id: "r2", status: "done" });
  l = await ws.list();
  assert.deepEqual([l.find((w) => w.name === "try-cents")!.agent, l.find((w) => w.name === "try-cents")!.group], ["done", "idle"]);

  // delete: refuses the open one; asks when work would be lost
  await assert.rejects(ws.remove(nm.path), /Switch to another workspace first/);
  current = main;
  writeFileSync(join(nm.path, "b.ts"), "x\n");
  await git(nm.path, ["add", "-A"]);
  await git(nm.path, [...ID, "commit", "-qm", "work"]);
  writeFileSync(join(nm.path, "c.ts"), "y\n"); // after the last listing: still counted
  assert.equal(await ws.remove(nm.path), false);
  assert.match(asked.at(-1)!.title, /would be lost/);
  assert.match(asked.at(-1)!.reason, /1 changed file and 1 commit that exist nowhere else/);
  answer = true;
  assert.equal(await ws.remove(nm.path), true);
  const before = asked.length;
  assert.equal(await ws.remove(br.path), true, "a clean branch checkout goes without asking");
  assert.equal(asked.length, before);
  assert.ok((await git(main, ["branch", "--list", "feature/cart"])).trim(), "your branch stays; only the folder goes");
  await assert.rejects(ws.remove(main), /main checkout/);

  ws.rename(pr.path, "  Cart review  ");
  assert.equal((await ws.list()).find((w) => w.path === pr.path)!.label, "Cart review");
  await assert.rejects(ws.known("/not/a/workspace"), /doesn't know/);
});

test("WS1: a folder that isn't a git repo is one plain row; projects are remembered most recent first", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shrike-ws-plain-")));
  const plain = join(dir, "plain");
  const other = join(dir, "other");
  for (const p of [plain, other]) mkdirSync(p);
  let current = plain;
  const ws = createWorkspaces({ file: join(dir, "w.json"), current: () => current, status: () => undefined, portsOf: async () => [], requestApproval: async () => false, stopBackground: async () => {}, emit: () => {}, gh: async () => ({ code: 1, stdout: "", stderr: "" }) });
  assert.deepEqual((await ws.list()).map((w) => [w.project, w.kind, w.current]), [["plain", "main", true]]);
  current = other;
  assert.deepEqual((await ws.list()).map((w) => [w.project, w.current]), [["other", true], ["plain", false]]);
});
