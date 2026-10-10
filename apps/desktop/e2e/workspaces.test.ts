// WS1–WS3 in the built app on a throwaway git copy of shop-app with a local "origin" (a feature branch and PR #5 on it):
// the rail lists main; New workspace makes one from PR #5 (fake gh, Create more), one from a remote branch (run skill on,
// it runs on +offset ports while main keeps running) and one from a name; switching back keeps the other app running;
// rename, delete (clean: no question; with changes: an approval card), collapse. gh is a fake: nothing reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ProjectInfo, RunStatus, Workspace } from "@shrike/schema";
import { dismissResult, fixtureCopy, gitIn, launch, listening, shot, sleep, waitFor } from "./helpers.ts";

const call = <T,>(win: Page, fn: string, ...args: unknown[]) => win.evaluate(([f, a]) => (window.shrike as any)[f](...a), [fn, args] as const) as Promise<T>;
const spaces = (win: Page) => call<Workspace[]>(win, "listWorkspaces");

function freeBlock(): number[] {
  for (let i = 0; i < 50; i++) {
    const b = 22000 + Math.floor(Math.random() * 2000) * 10;
    const all = [0, 100, 200, 300].flatMap((o) => [b, b + 1, b + 2, b + 3].map((p) => p + o));
    if (!listening(all)) return [b, b + 1, b + 2, b + 3];
  }
  throw new Error("no free port block");
}

test("workspaces: rail, create from PR / branch / name, switching keeps other apps running, delete asks first", { timeout: 900_000 }, async () => {
  const [web, api, auth, pay] = freeBlock();
  const ports = (o: number) => [web!, api!, auth!, pay!].map((p) => p + o);
  const proj = fixtureCopy("shop-app", { ports: { 5180: web!, 4100: api!, 4101: auth!, 4199: pay! }, git: true });
  const origin = join(proj, "..", "origin.git");
  gitIn(join(proj, ".."), "init", "-q", "--bare", "-b", "main", origin);
  gitIn(proj, "remote", "add", "origin", origin);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  gitIn(proj, "checkout", "-qb", "feature/coupons");
  writeFileSync(join(proj, "COUPONS.md"), "coupons\n");
  gitIn(proj, "add", "-A");
  gitIn(proj, "commit", "-qm", "coupons");
  gitIn(proj, "push", "-q", "origin", "feature/coupons", "HEAD:refs/pull/5/head");
  gitIn(proj, "checkout", "-q", "main");
  gitIn(proj, "branch", "-qD", "feature/coupons");

  const ghDir = mkdtempSync(join(tmpdir(), "shrike-e2e-gh-"));
  const ghLog = join(ghDir, "calls.log");
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-workspaces.mjs")}" "$@"\n`, { mode: 0o755 });
  writeFileSync(ghLog, "");
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(ghDir, "gh"), FAKE_GH_LOG: ghLog });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("dialog", { name: "Set up shop-app" }).getByRole("button", { name: "Run all" }).click();
    await waitFor("main running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 120_000);
    await dismissResult(win, 3000);

    // WS1: the rail lists the project's main checkout, live on its port.
    const rail = win.getByRole("navigation", { name: "Workspaces" });
    await rail.getByRole("button", { name: /main/ }).first().waitFor();
    await waitFor("main live in the rail", async () => (await spaces(win)).find((w) => w.kind === "main" && w.running && w.port === web), 30_000);
    await sleep(600);
    await shot(app, "ws-01-rail", "v6");

    // WS2: ⌘N, Smart understands #5; Create more keeps the dialog open and the new one waits in the rail.
    await win.keyboard.press("Meta+n");
    const dlg = win.getByRole("dialog", { name: "New workspace" });
    await dlg.waitFor();
    await dlg.getByRole("textbox", { name: "Name, PR number, branch or link" }).fill("#5");
    await dlg.getByText("Pull request #5").waitFor();
    await dlg.getByText("Coupons take whole cents").waitFor();
    await dlg.getByText("Create more").click();
    await sleep(300);
    await shot(app, "ws-02-dialog-smart-pr", "v6");
    await win.keyboard.press("Meta+Enter");
    await dlg.getByText("pr-5 is ready").waitFor({ timeout: 60_000 });
    const pr5 = await waitFor("pr-5 in the list", async () => (await spaces(win)).find((w) => w.name === "pr-5"), 20_000);
    assert.deepEqual([pr5.branch, pr5.pr?.number, pr5.group, pr5.current], ["coupon-fix", 5, "review", false]);
    assert.equal(gitIn(pr5.path, "log", "-1", "--format=%s"), "coupons", "the PR's own code");

    // From branch: a remote-only branch; the run skill starts it on its own ports, main keeps running.
    await dlg.getByRole("tab", { name: "From branch" }).click();
    await dlg.getByRole("textbox", { name: "Search branches" }).fill("coupons");
    await dlg.getByRole("option").filter({ hasText: "origin/feature/coupons" }).getByRole("button").click();
    await dlg.getByText("Create more").click();
    await sleep(300);
    await shot(app, "ws-03-dialog-branch", "v6");
    await dlg.getByRole("button", { name: /Create workspace/ }).click();
    await dlg.waitFor({ state: "detached", timeout: 60_000 });
    await win.getByRole("status", { name: "Workspace ready" }).waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot(app, "ws-04-ready", "v6");
    await waitFor("switched to feature-coupons", async () => (await call<ProjectInfo>(win, "getProject")).root.endsWith("/.shrike/worktrees/feature-coupons"), 30_000);
    await waitFor("feature-coupons running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 180_000);
    await dismissResult(win, 3000);
    const both = await waitFor("both apps running", async () => {
      const l = await spaces(win);
      const m = l.find((w) => w.kind === "main");
      const f = l.find((w) => w.name === "feature-coupons");
      return m?.running && f?.running && f.current && { m, f };
    }, 120_000);
    assert.equal(both.f.portOffset, 200);
    assert.equal(both.f.branch, "feature/coupons");
    const hdr = { authorization: "Bearer demo-token" };
    const cart = (port: number) => fetch(`http://localhost:${port}/api/cart`, { headers: hdr }).then((r) => r.status === 200, () => false);
    await waitFor("main answers on its ports", () => cart(web!), 90_000);
    await waitFor("feature-coupons answers on +200", () => cart(web! + 200), 90_000);
    await sleep(1000);
    await shot(app, "ws-05-two-running", "v6");

    // New name, from your code as it is now, without running it.
    await rail.getByRole("button", { name: /New workspace/ }).click();
    await dlg.getByRole("tab", { name: "New name" }).click();
    await dlg.getByRole("textbox", { name: "Workspace name" }).fill("Try Cents");
    await dlg.getByText("Advanced").click();
    await dlg.getByText("Run the app with its run skill").click();
    await dlg.getByRole("button", { name: /Create workspace/ }).click();
    await waitFor("switched to try-cents", async () => (await call<ProjectInfo>(win, "getProject")).root.endsWith("/.shrike/worktrees/try-cents"), 60_000);
    await waitFor("feature-coupons still running in the background", async () => (await spaces(win)).find((w) => w.name === "feature-coupons")?.running, 60_000);

    // Switching back to main keeps the others' apps running.
    await rail.getByRole("button", { name: /^main/ }).click();
    await waitFor("back on main", async () => (await call<ProjectInfo>(win, "getProject")).root === proj, 30_000);
    await waitFor("main running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 120_000);
    await waitFor("feature-coupons keeps answering on +200", () => cart(web! + 200), 30_000);
    assert.ok((await spaces(win)).find((w) => w.name === "feature-coupons")?.running);
    await dismissResult(win, 2000);

    // Rename from the row menu.
    await rail.getByRole("button", { name: "More for pr-5" }).click({ force: true });
    await win.getByRole("menuitem", { name: "Rename" }).click();
    const box = rail.getByRole("textbox", { name: "Rename pr-5" });
    await box.fill("Coupon review");
    await box.press("Enter");
    await waitFor("renamed", async () => (await spaces(win)).find((w) => w.name === "pr-5")?.label === "Coupon review", 10_000);
    await sleep(600);
    await shot(app, "ws-06-groups", "v6");

    // Delete: a clean one goes without asking; one with changes asks with an approval card first.
    await rail.getByRole("button", { name: "More for Coupon review" }).click({ force: true });
    await win.getByRole("menuitem", { name: "Delete workspace" }).click();
    await waitFor("pr-5 gone", async () => !(await spaces(win)).some((w) => w.name === "pr-5"), 30_000);
    const tc = (await spaces(win)).find((w) => w.name === "try-cents")!;
    writeFileSync(join(tc.path, "notes.txt"), "keep me?\n");
    await rail.getByRole("button", { name: "More for try-cents" }).click({ force: true });
    await win.getByRole("menuitem", { name: "Delete workspace" }).click();
    const allow = win.getByRole("button", { name: /^Allow/ });
    await allow.waitFor({ timeout: 20_000 });
    await sleep(400);
    await shot(app, "ws-07-delete-asks", "v6");
    assert.ok((await spaces(win)).some((w) => w.name === "try-cents"), "nothing deleted before you answer");
    await allow.click();
    await waitFor("try-cents gone", async () => !(await spaces(win)).some((w) => w.name === "try-cents"), 30_000);

    // ⌘B collapses the rail to tiles.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+b");
    await rail.getByRole("button", { name: "Show workspaces (⌘B)" }).waitFor();
    await sleep(500);
    await shot(app, "ws-08-collapsed", "v6");
    await win.keyboard.press("Meta+b");

    const fc = (await spaces(win)).find((w) => w.name === "feature-coupons")!;
    await call(win, "workspaceAction", fc.path, "stop");
    await waitFor("feature-coupons' ports freed", () => listening(ports(200)) === "", 30_000);
    await call(win, "deleteWorkspace", fc.path);
    await call(win, "stop");
  } finally {
    await cleanup();
  }
  const calls = readFileSync(ghLog, "utf8").trim().split("\n");
  assert.ok(calls.some((c) => c.startsWith("pr checkout 5")), "the PR came through gh");
  assert.deepEqual(calls.filter((c) => /^(pr (create|merge|comment|review|close|edit)|api|issue)/.test(c)), [], "nothing was written to GitHub");
  assert.equal(gitIn(proj, "worktree", "list").split("\n").length, 1, "no worktrees left");
  assert.ok(gitIn(proj, "branch", "--list", "feature/coupons"), "a branch you checked out stays");
  assert.equal(listening([0, 100, 200, 300].flatMap(ports)), "", "every port free");
});
