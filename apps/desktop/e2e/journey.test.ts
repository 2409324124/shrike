// The three stages end to end on one throwaway todo-app repo with a local bare "origin" (fake gh, recorded Claude):
// workspaces (Smart #5, a remote branch, a new name; two apps running at once), Changes (an agent edit shows up live,
// diff, Write it for me, commit, undo, commit), Create PR behind Allow, the PR panel (failing check, Explain, People / Bots,
// Reply and Resolve behind Allow, Queue for agent), and a prompt typed in the composer read back in the conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ChainsState, ProjectInfo, RunStatus, Workspace } from "@shrike/schema";
import { dismissResult, fakeClaude, fixtureCopy, gitIn, isListening, key, launch, listening, mcpClient, questReady, shot, sleep, waitFor } from "./helpers.ts";

const PLANTED = "insertTodo({ title, userId: req.body.user });";
const FIXED = "insertTodo({ title, userId: req.body.userId });";
const call = <T,>(win: Page, fn: string, ...args: unknown[]) => win.evaluate(([f, a]) => (window.shrike as any)[f](...a), [fn, args] as const) as Promise<T>;
const spaces = (win: Page) => call<Workspace[]>(win, "listWorkspaces");

function freeBlock(): [number, number] {
  for (let i = 0; i < 50; i++) {
    const b = 24000 + Math.floor(Math.random() * 1500) * 10;
    if (!listening([0, 100, 200, 300].flatMap((o) => [b + o, b + 1 + o]))) return [b, b + 1];
  }
  throw new Error("no free port block");
}

test("journey: workspaces, changes, PR and checks, composer (fake gh, recorded Claude)", { timeout: 900_000 }, async () => {
  const [web, api] = freeBlock();
  const ports = [0, 100, 200, 300].flatMap((o) => [web + o, api + o]);
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const origin = join(proj, "..", "origin.git");
  gitIn(join(proj, ".."), "init", "-q", "--bare", "-b", "main", origin);
  gitIn(proj, "remote", "add", "origin", origin);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  for (const [b, file, ref] of [["feature/dark-mode", "DARK.md", "feature/dark-mode"], ["dark-list", "LIST.md", "refs/pull/5/head"]] as const) {
    gitIn(proj, "checkout", "-qb", b);
    writeFileSync(join(proj, file), `${b}\n`);
    gitIn(proj, "add", "-A");
    gitIn(proj, "commit", "-qm", b);
    gitIn(proj, "push", "-q", "origin", `HEAD:${ref}`);
    gitIn(proj, "checkout", "-q", "main");
    gitIn(proj, "branch", "-qD", b);
  }

  const ghDir = mkdtempSync(join(tmpdir(), "shrike-e2e-jgh-"));
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-journey.mjs")}" "$@"\n`, { mode: 0o755 });
  const ghCalls = (): string[][] => (existsSync(join(ghDir, "calls.log")) ? readFileSync(join(ghDir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const writes = () => ghCalls().filter((a) => (a[0] === "api" && /^query=mutation/.test(a[3] ?? "")) || ["pr ready", "run rerun", "pr merge", "pr create", "pr comment", "pr review", "pr close", "pr edit", "issue comment"].includes(a.slice(0, 2).join(" ")));
  const claude = fakeClaude(60);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(ghDir, "gh"), SHRIKE_FAKE_GH_DIR: ghDir, ...claude.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });

    // Stage 1: the rail shows the project; main runs.
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    const rail = win.getByRole("navigation", { name: "Workspaces" });
    await waitFor("main live in the rail", async () => (await spaces(win)).find((w) => w.kind === "main" && w.running), 60_000);
    await sleep(500);
    await shot(app, "01-rail", "j");

    // Smart #5 (fake gh) and a remote branch wait in the rail with Create more; a new name opens and runs on its own ports.
    await key(win, "Meta+n");
    const dlg = win.getByRole("dialog", { name: "New workspace" });
    const smart = dlg.getByRole("textbox", { name: "Name, PR number, branch or link" });
    await smart.fill("#5");
    await dlg.getByText("Pull request #5").waitFor();
    await dlg.getByText("Create more").click();
    await win.keyboard.press("Meta+Enter");
    await dlg.getByText("pr-5 is ready").waitFor({ timeout: 60_000 });
    await dlg.getByRole("tab", { name: "From branch" }).click();
    await dlg.getByRole("textbox", { name: "Search branches" }).fill("dark-mode");
    await dlg.getByRole("option").filter({ hasText: "origin/feature/dark-mode" }).getByRole("button").click();
    await dlg.getByRole("button", { name: /Create workspace/ }).click();
    await dlg.getByText(/feature-dark-mode is ready/).waitFor({ timeout: 60_000 });
    await dlg.getByRole("tab", { name: "Smart" }).click();
    await smart.fill("fix add todo");
    await dlg.getByText("New workspace fix-add-todo").waitFor();
    await dlg.getByText("Create more").click();
    await sleep(300);
    await shot(app, "02-dialog-smart-name", "j");
    await dlg.getByRole("button", { name: /Create workspace/ }).click();
    await dlg.waitFor({ state: "detached", timeout: 60_000 });
    const pr5 = (await spaces(win)).find((w) => w.name === "pr-5")!;
    assert.equal(gitIn(pr5.path, "log", "-1", "--format=%s"), "dark-list", "PR #5's own code");
    assert.equal((await spaces(win)).find((w) => w.name === "feature-dark-mode")?.branch, "feature/dark-mode");
    await waitFor("switched to fix-add-todo", async () => (await call<ProjectInfo>(win, "getProject")).root.endsWith("/.shrike/worktrees/fix-add-todo"), 30_000);
    await waitFor("fix-add-todo running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 180_000);
    await dismissResult(win, 3000);
    const mine = await waitFor("both apps running", async () => {
      const l = await spaces(win);
      const f = l.find((w) => w.name === "fix-add-todo");
      return l.find((w) => w.kind === "main")?.running && f?.running && f;
    }, 120_000);
    const off = mine.portOffset ?? 0;
    assert.ok(off > 0, "its own ports");
    await waitFor("main answers", () => isListening(web), 60_000);
    await waitFor("fix-add-todo answers on its own port", () => isListening(web + off), 60_000);

    // Switch to main and back while both keep running.
    await rail.getByRole("button", { name: /^main/ }).click();
    await waitFor("on main", async () => (await call<ProjectInfo>(win, "getProject")).root === proj, 30_000);
    await waitFor("fix-add-todo running again in the background (a switch restarts the app you leave)", () => isListening(web + off), 60_000);
    await rail.getByRole("button", { name: /fix-add-todo/ }).first().click();
    await waitFor("back on fix-add-todo", async () => (await call<ProjectInfo>(win, "getProject")).root === mine.path, 30_000);
    await waitFor("fix-add-todo running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 60_000);
    await waitFor("main running again in the background", () => isListening(web), 60_000);
    await dismissResult(win, 2000);
    await sleep(600);
    await shot(app, "03-two-running", "j");

    // Stage 2: the agent's edit (propose_patch, then your click) shows up in Changes on its own.
    await key(win, "Meta+Shift+KeyG");
    const dock = win.getByRole("complementary", { name: "Right dock" });
    const sec = (name: string) => dock.getByRole("region", { name, exact: true });
    const mcp = await mcpClient(app);
    const proposed = mcp.call("propose_patch", { files: [{ path: "server/todos.controller.ts", edits: [{ oldText: PLANTED, newText: FIXED }] }], rationale: "The page sends userId, so read userId." });
    await win.getByRole("button", { name: /Apply fix/ }).click({ timeout: 30_000 });
    assert.match(await proposed, /applied/);
    await mcp.close();
    assert.match(readFileSync(join(mine.path, "server/todos.controller.ts"), "utf8"), /req\.body\.userId/);
    assert.doesNotMatch(readFileSync(join(proj, "server/todos.controller.ts"), "utf8"), /req\.body\.userId/, "main's copy keeps the planted bug");
    await sec("Changes").getByText("todos.controller.ts").waitFor({ timeout: 15_000 });
    await sleep(300);
    await shot(app, "04-changes-live", "j");
    await sec("Changes").getByRole("button", { name: /todos\.controller\.ts/ }).first().click();
    const diff = win.getByRole("dialog", { name: "Changes to server/todos.controller.ts" });
    await diff.getByText("req.body.userId").first().waitFor();
    await sleep(200);
    await shot(app, "05-diff", "j");
    await win.keyboard.press("Escape");
    await diff.waitFor({ state: "detached" });

    await dock.getByRole("button", { name: /Write it for me/ }).click();
    const box = dock.getByRole("textbox", { name: "Commit message" });
    await waitFor("the agent's message", async () => (await box.inputValue()).startsWith("Fix: Add Todo saves the owner again"), 60_000);
    assert.ok(claude.calls().some((c) => /^# Write a commit message/m.test(c.goal)), "the Commit message recipe reached the agent");
    await dock.getByRole("button", { name: /^Commit all 1 change/ }).click();
    await dock.getByRole("button", { name: /Undo last commit/ }).waitFor();
    assert.equal(gitIn(mine.path, "log", "-1", "--format=%s"), "Fix: Add Todo saves the owner again");
    await dock.getByRole("button", { name: /Undo last commit/ }).click();
    await waitFor("undone", () => gitIn(mine.path, "log", "-1", "--format=%s") !== "Fix: Add Todo saves the owner again");
    await dock.getByRole("button", { name: /^Commit 1 file/ }).click();
    await waitFor("committed again", () => gitIn(mine.path, "log", "-1", "--format=%s") === "Fix: Add Todo saves the owner again");
    await sleep(300);
    await shot(app, "06-committed", "j");

    // Create PR: Ship pushes and opens it only after Allow.
    const branch = gitIn(mine.path, "branch", "--show-current");
    await dock.getByRole("button", { name: "Create PR" }).click();
    const sheet = win.getByRole("dialog", { name: "Ship" });
    await sheet.getByRole("button", { name: "Open a pull request" }).click({ timeout: 20_000 });
    const shipAllow = sheet.getByRole("region", { name: "Allow this?" });
    await shipAllow.waitFor({ timeout: 20_000 });
    assert.deepEqual(writes(), [], "nothing sent before Allow");
    assert.throws(() => gitIn(origin, "rev-parse", "--verify", "--quiet", branch), "nothing pushed before Allow");
    await sleep(300);
    await shot(app, "07-create-pr-allow", "j");
    await shipAllow.getByRole("button", { name: "Allow" }).click();
    await sheet.getByText("Pull request #7 · open").waitFor({ timeout: 30_000 });
    assert.equal(gitIn(origin, "rev-parse", branch), gitIn(mine.path, "rev-parse", "HEAD"), "the branch reached origin");
    assert.deepEqual(ghCalls().find((a) => a[1] === "create")!.slice(2, 6), ["--base", "main", "--head", branch]);

    // Stage 3: the PR panel. A failing check expands to its steps; Explain asks the agent; People / Bots; Reply and Resolve behind Allow; Queue.
    await sheet.getByRole("button", { name: "Checks and comments" }).click();
    const panel = win.locator("[data-pr-panel]");
    await panel.getByTestId("check-line").waitFor({ timeout: 30_000 });
    assert.equal(await panel.getByTestId("check-line").innerText(), "3 passing · 1 failing");
    await panel.locator('[data-check="test"] button[aria-expanded]').first().click();
    await panel.getByLabel("Failing lines").waitFor({ timeout: 15_000 });
    const runsBefore = claude.calls().length;
    await panel.getByRole("button", { name: "Explain" }).click();
    await waitFor("Explain started an agent run", () => claude.calls().length > runsBefore, 30_000);
    await sleep(300);
    await shot(app, "08-checks-explain", "j");
    const tabs = panel.getByRole("tablist", { name: "Whose comments" });
    assert.deepEqual((await tabs.getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["All 5", "People 3", "Bots 2"]);
    await tabs.getByRole("tab", { name: /Bots/ }).click();
    await sleep(200);
    await shot(app, "09-bots", "j");
    await tabs.getByRole("tab", { name: /People/ }).click();

    const allow = panel.getByRole("region", { name: "Allow this?" });
    const t1 = panel.locator('[data-thread="PRRT_1"]');
    await t1.getByRole("button", { name: "Reply" }).click();
    await t1.getByLabel("Your reply").fill("Fixed: it reads userId now.");
    await t1.getByRole("button", { name: "Post reply" }).click();
    await allow.waitFor({ timeout: 15_000 });
    assert.equal(writes().length, 1, "only the PR so far");
    await shot(app, "10-reply-allow", "j");
    await allow.getByRole("button", { name: "Allow" }).click();
    await t1.locator("[data-comment]").getByText("Fixed: it reads userId now.").waitFor({ timeout: 15_000 });
    await t1.getByRole("button", { name: "Resolve" }).click();
    await allow.waitFor({ timeout: 15_000 });
    await allow.getByRole("button", { name: "Allow" }).click();
    await panel.locator('[data-thread="PRRT_1"][data-resolved="true"]').waitFor({ timeout: 15_000 });

    const queued = (await call<ChainsState>(win, "getChains")).items.length;
    await panel.locator('[data-comment="IC_2"]').getByRole("button", { name: "Queue for agent" }).click();
    await waitFor("an Up next item for the comment", async () => (await call<ChainsState>(win, "getChains")).items.length > queued, 15_000);
    await sleep(300);
    await shot(app, "11-after-writes", "j");
    const w = writes().map((a) => (a[0] === "api" ? /mutation[^{]*\{(\w+)/.exec(a[3]!)![1]! : a.slice(0, 2).join(" ")));
    assert.deepEqual(w, ["pr create", "addPullRequestReviewThreadReply", "resolveReviewThread"], "exactly the allowed writes, to the fake gh");
    await win.keyboard.press("Escape");

    // The composer: what you type is in the conversation.
    await waitFor("the agent idle", async () => !(await win.evaluate(() => window.shrike.listRuns())).some((r) => r.status === "running"), 120_000);
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Does Add Todo keep the owner after this fix?");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    await ask.waitFor({ state: "detached" });
    const composer = win.getByRole("form", { name: "Ask your agent" });
    await composer.getByRole("button", { name: /^Conversation, \d+ messages?/ }).click();
    const talk = win.getByRole("region", { name: "Conversation" });
    await talk.getByText("Does Add Todo keep the owner after this fix?").waitFor({ timeout: 15_000 });
    await sleep(400);
    await shot(app, "12-conversation", "j");
    await talk.getByRole("button", { name: "Close conversation" }).click();

    for (const s of await spaces(win)) if (s.running && !s.current) await call(win, "workspaceAction", s.path, "stop");
    await call(win, "stop");
    await waitFor("every port free", () => listening(ports) === "", 60_000);
  } catch (e) {
    await shot(app, "zz-failure", "j").catch(() => {});
    throw e;
  } finally {
    await cleanup();
    claude.remove();
  }
  assert.ok(ghCalls().some((a) => a.join(" ") === "pr checkout 5"), "PR #5 came through the fake gh");
  assert.equal(listening(ports), "", "every port free");
});
