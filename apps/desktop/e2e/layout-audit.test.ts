// Layout audit: drives the built app through every screen and state, shoots each at 1100x700, 1440x900 and 1920x1200 in the
// themes (layout.ts matrix), and runs box checks (overlap, covered, occluded, clipped, off-screen, cramped, floating layers).
// Screenshots go to $SHRIKE_E2E_SHOTS/layout-audit (marked copies outline what was found); results.jsonl has every finding.
// LAYOUT_ONLY=a,b runs only those scenes' sweeps (the driving still happens); LAYOUT_QUICK=1 shoots Abyss and Daylight at 1440x900.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { addTodoAction, dismissResult, fakeClaude, fixtureCopy, freePort, gitIn, key, launch, listening, mcpClient, SHOTS, sleep, typeTodo, waitFor } from "./helpers.ts";
import type { ThemeId } from "@shrike/design";
import { sweep, type Allow, type Size, type Sweep } from "./layout.ts";

const OUT = join(SHOTS, "layout-audit");
const only = process.env.LAYOUT_ONLY?.split(",");
if (!only) rmSync(OUT, { recursive: true, force: true }); // LAYOUT_ONLY re-shoots some states into the last run
const results: Sweep[] = [];
const skipped: string[] = [];

function auditor(app: ElectronApplication, win: Page) {
  return async (state: string, allow?: Allow[], m?: [Size, ThemeId][]) => {
    if (only && !only.some((o) => state.startsWith(o))) return;
    results.push(...(await sweep(app, win, OUT, state, { allow, only: m })));
  };
}

let current: Page | null = null;
/** A scene that cannot be reached is recorded and skipped, whatever it left open is closed, and the audit goes on. */
async function scene(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    skipped.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    console.error(`scene ${name} skipped: ${(e as Error).message}`);
    const win = current;
    if (!win) return;
    await win.getByRole("button", { name: "Close the chain panel" }).click({ timeout: 1000 }).catch(() => {});
    for (const d of ["Ship", "New workspace", "Issue for this trip", "Quick open"]) {
      const close = win.getByRole("dialog", { name: d }).getByRole("button", { name: /^(Close|Cancel)$/ }).first();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    }
    for (let i = 0; i < 3; i++) await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).then(() => win.keyboard.press("Escape")).catch(() => {});
  }
}

/** Locator.isVisible ignores its timeout: wait for it instead, up to ms. */
const shows = (loc: { waitFor(o: { state: "visible"; timeout: number }): Promise<unknown> }, ms: number) => loc.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
const blur = (win: Page) => win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const esc = async (win: Page, n = 1) => {
  for (let i = 0; i < n; i++) {
    await win.keyboard.press("Escape");
    await sleep(150);
  }
};

test("layout audit: every screen and state at three sizes and six themes", { timeout: 3_600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const origin = join(proj, "..", "origin.git");
  gitIn(join(proj, ".."), "init", "-q", "--bare", "-b", "main", origin);
  gitIn(proj, "remote", "add", "origin", origin);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  gitIn(proj, "checkout", "-qb", "dark-list");
  writeFileSync(join(proj, "LIST.md"), "dark-list\n");
  gitIn(proj, "add", "-A");
  gitIn(proj, "commit", "-qm", "dark-list");
  gitIn(proj, "push", "-q", "origin", "HEAD:refs/pull/5/head");
  gitIn(proj, "checkout", "-q", "main");
  gitIn(proj, "branch", "-qD", "dark-list");
  const ghDir = mkdtempSync(join(tmpdir(), "shrike-e2e-lgh-"));
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-journey.mjs")}" "$@"\n`, { mode: 0o755 });
  const cc = fakeClaude(120);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(ghDir, "gh"), SHRIKE_FAKE_GH_DIR: ghDir, FAKE_CRITIQUE_SCORES: "5,9,5,5", ...cc.env });
  const audit = auditor(app, win);
  current = win;
  const QUICK: [Size, ThemeId][] = [[{ w: 1100, h: 700 }, "abyss"], [{ w: 1440, h: 900 }, "abyss"], [{ w: 1440, h: 900 }, "daylight"]];
  /** A System window on screen right now (they auto-dismiss): shot at a short matrix. */
  const systemWindow = async (tag: string): Promise<boolean> => {
    const w = win.locator(".sys:not(.sys-leave)").first();
    if (!(await shows(w, 2500))) return false;
    await w.hover().catch(() => {}); // hover holds it
    await audit(`system-window-${tag}`, undefined, QUICK);
    return true;
  };
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });

    await scene("welcome", async () => {
      await win.getByRole("button", { name: "Open a folder" }).waitFor();
      await sleep(800);
      await audit("welcome");
    });

    await scene("result-screen", async () => {
      await win.getByRole("button", { name: "Open a folder" }).click();
      await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
      await waitFor("the start quest", async () => (await win.evaluate(() => window.shrike.getStartPlan()))?.state === "ready", 120_000);
      await systemWindow("after-start");
      const chip = win.locator(".xr-chip");
      if (!(await win.locator(".xr-scrim").count())) await chip.click({ timeout: 10_000 });
      await win.locator(".xr-scrim").waitFor({ timeout: 10_000 });
      await sleep(2500); // the score lines and medal settle
      await audit("result-screen");
      await dismissResult(win, 500);
      await sleep(400);
      await audit("result-chip");
    });

    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await shows(closeSetup, 2000)) await closeSetup.click();

    await scene("running", async () => {
      await sleep(1500);
      await audit("running-trips");
    });

    await scene("setup", async () => {
      await win.getByRole("banner").getByRole("button", { name: "Set up processes" }).click();
      await sleep(600);
      await audit("settings-setup");
      await esc(win);
      if (await shows(closeSetup, 500)) await closeSetup.click();
    });

    await scene("appearance", async () => {
      await win.getByRole("banner").getByRole("button", { name: "Appearance" }).click();
      await win.getByRole("dialog", { name: "Appearance" }).waitFor();
      await sleep(400);
      await audit("settings-appearance");
      await esc(win);
    });

    await scene("profile", async () => {
      await win.getByRole("banner").locator("button", { hasText: /XP/ }).first().click();
      await win.getByRole("dialog", { name: "Hunter profile" }).waitFor({ timeout: 5000 });
      await sleep(800);
      await audit("profile");
      await esc(win);
    });

    let brokenId = "";
    await scene("dive", async () => {
      await typeTodo(guest, "buy milk");
      await guest.getByRole("button", { name: "Add Todo" }).click();
      const broken = await addTodoAction(win);
      brokenId = broken.id;
      await win.locator(`.th-trip[data-trip="${broken.id}"] .th-dive`).waitFor({ timeout: 15_000 });
      await sleep(1200);
      await audit("dive-card");
    });

    await scene("file-view", async () => {
      await key(win, "e");
      await win.locator(".fv").waitFor({ timeout: 5000 });
      await sleep(500);
      await audit("file-view");
      await key(win, "Escape");
    });

    await scene("time-view", async () => {
      await key(win, "Escape");
      await key(win, "t");
      await sleep(900);
      await audit("time-view");
      await key(win, "t");
    });

    await scene("new-trip-toast", async () => {
      await key(win, "Enter"); // dived: a new trip shows as a toast instead of moving the view
      await guest.getByRole("button", { name: "Load dashboard" }).click();
      await win.getByRole("status").filter({ hasText: "New trip" }).waitFor({ timeout: 10_000 });
      await audit("new-trip-toast", undefined, QUICK);
      await key(win, "Escape");
    });

    await scene("sheets", async () => {
      for (const [k, name] of [["g", "logs"], ["n", "network"], ["`", "terminal"], ["d", "details"]] as const) {
        await key(win, k);
        await sleep(600);
        await audit(`sheet-${name}`);
        await key(win, "Escape");
      }
    });

    await scene("quick-open", async () => {
      await blur(win);
      await win.keyboard.press("Meta+p");
      await win.getByRole("dialog", { name: "Quick open" }).waitFor({ timeout: 4000 });
      await win.keyboard.type("todo");
      await sleep(500);
      await audit("quick-open");
      await esc(win);
    });

    await scene("issue-card", async () => {
      await win.getByRole("banner").getByRole("button", { name: "Write this trip up as an issue" }).click();
      await win.getByRole("dialog", { name: "Issue for this trip" }).waitFor({ timeout: 5000 });
      await sleep(500);
      await audit("issue-card");
      await esc(win);
    });

    await scene("rec-menu", async () => {
      await win.getByRole("banner").locator("button", { hasText: /^Rec$/i }).click();
      await win.getByRole("dialog", { name: "Record a clip" }).waitFor({ timeout: 4000 });
      await audit("rec-menu", undefined, QUICK);
      await esc(win);
    });

    const composer = win.getByRole("form", { name: "Ask your agent" });
    await scene("composer", async () => {
      await key(win, "Escape");
      await audit("composer-empty", undefined, QUICK);
      await blur(win);
      await win.keyboard.press("Meta+k");
      const ask = win.getByRole("dialog", { name: "Ask your agent" });
      await ask.waitFor();
      const brain = ask.getByRole("combobox", { name: "Which agent to use" });
      if (await brain.count()) await brain.selectOption("claude-code");
      await sleep(400);
      await audit("composer-tray");
      const input = ask.getByRole("textbox", { name: "Ask your agent" });
      for (let i = 1; i <= 6; i++) {
        await input.pressSequentially(`line ${i} of a long prompt about the Add Todo button and what it should do`);
        if (i < 6) await input.press("Shift+Enter");
      }
      await sleep(300);
      await audit("composer-6-lines");
      await input.fill("/");
      await ask.getByRole("listbox", { name: "Commands" }).waitFor();
      await audit("composer-slash");
      await input.fill("");
      await input.pressSequentially("look at @todos.contr");
      await ask.getByRole("listbox", { name: "Files" }).getByRole("option").first().waitFor();
      await audit("composer-at-files");
      await input.press("Enter");
      await sleep(300);
      await audit("composer-chip", undefined, QUICK);
      await input.fill("");
      await esc(win, 2);
    });

    await scene("agent", async () => {
      await blur(win);
      await win.keyboard.press("Meta+k");
      const ask = win.getByRole("dialog", { name: "Ask your agent" });
      await ask.getByRole("textbox", { name: "Ask your agent" }).fill("When I click Add Todo nothing shows up");
      await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
      await win.locator('aside[aria-label="Agent"]').waitFor({ timeout: 20_000 });
      await sleep(600);
      await audit("agent-working", undefined, QUICK);
      await win.getByRole("region", { name: "Found it" }).waitFor({ timeout: 60_000 });
      await sleep(800);
      await audit("found-it");
      await waitFor("the run to finish", async () => (await win.evaluate(() => window.shrike.listRuns())).some((r) => r.status === "done"), 60_000);
      const mcp = await mcpClient(app); // the agent's patch, over Shrike's own MCP server (as journey.test does)
      void mcp.call("propose_patch", { files: [{ path: "server/todos.controller.ts", edits: [{ oldText: "insertTodo({ title, userId: req.body.user });", newText: "insertTodo({ title, userId: req.body.userId });" }] }], rationale: "The page sends userId, so read userId." }).catch(() => {}).finally(() => mcp.close());
      await win.getByRole("button", { name: /Apply fix/ }).waitFor({ timeout: 60_000 });
      await sleep(600);
      await audit("fix-card");
    });

    await scene("conversation", async () => {
      await composer.getByRole("button", { name: /^Conversation, \d+ message/ }).click();
      const talk = win.getByRole("region", { name: "Conversation" });
      await talk.waitFor();
      await talk.getByRole("button", { name: /\d+ steps?/ }).first().click().catch(() => {});
      await sleep(500);
      await audit("conversation");
      await talk.getByRole("button", { name: "Close conversation" }).click();
    });

    await scene("apply-fix", async () => {
      await win.getByRole("button", { name: /Apply fix/ }).click({ timeout: 10_000 });
      await waitFor("the run to end", async () => (await win.evaluate(() => window.shrike.listRuns())).every((r) => r.status !== "running"), 60_000);
      await sleep(2500);
      await audit("fix-applied");
      await systemWindow("after-fix");
    });

    await scene("up-next", async () => {
      await win.evaluate(async () => {
        await window.shrike.pauseUpNext(true);
        await window.shrike.queuePrompt("write the tests for adding a todo with a really long prompt that wraps", { on: "finished" });
        await window.shrike.queuePrompt("Check the logs for warnings", { on: "time", at: Date.now() + 3_600_000 });
      });
      await win.getByRole("region", { name: "Up next" }).getByRole("listitem").nth(1).waitFor({ timeout: 10_000 });
      await win.locator('aside[aria-label="Agent"], [aria-label="Up next"]').first().hover().catch(() => {});
      await sleep(500);
      await audit("up-next");
    });

    await scene("chain", async () => {
      await blur(win);
      await win.keyboard.press("Meta+k");
      const ask = win.getByRole("dialog", { name: "Ask your agent" });
      await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Build the settings page");
      await ask.getByRole("button", { name: "Make it a chain" }).click();
      const panel = win.getByRole("region", { name: "Prompt chain" });
      await panel.waitFor();
      await panel.getByRole("textbox", { name: "Chain name" }).fill("Settings polish");
      await sleep(400);
      await audit("chain-panel");
      await panel.getByRole("button", { name: "Start chain" }).click();
      // The chain's System windows and toasts come and go in seconds: shoot the first one with the panel open, at once.
      const flash = win.locator('.sys:not(.sys-leave), [role=status][aria-label^="Next up"], [role=status][aria-label^="Critique"]').first();
      if (await shows(flash, 30_000)) await audit("chain-toast-panel-open", undefined, QUICK);
      await panel.getByRole("img", { name: /^Score \d+ of 10$/ }).waitFor({ timeout: 60_000 });
      await sleep(400);
      await audit("chain-running", undefined, QUICK);
      const toast = win.getByRole("status", { name: /^(Next up|Critique|Chain complete)/ }).first();
      await waitFor("the chain to finish", async () => {
        const c = (await win.evaluate(() => window.shrike.getChains())).chain;
        return c && (c.state === "done" || c.state === "stopped");
      }, 120_000);
      await sleep(300);
      if (await shows(toast, 3000)) await audit("chain-toast-complete");
      await panel.getByRole("button", { name: "Close the chain panel" }).click();
      const items = win.getByRole("region", { name: "Up next" }).getByRole("button", { name: /^Remove / });
      while (await items.count()) await items.first().click();
    });

    await scene("options", async () => {
      await waitFor("the agent idle", async () => (await win.evaluate(() => window.shrike.listRuns())).every((r) => r.status !== "running"), 60_000);
      await blur(win);
      await win.keyboard.press("Meta+k");
      const ask = win.getByRole("dialog", { name: "Ask your agent" });
      await ask.getByRole("button", { name: "Show me options" }).click();
      await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Make the todo header look better");
      await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
      const board = win.getByRole("dialog", { name: /^Options: / });
      await board.waitFor({ timeout: 30_000 });
      await waitFor("three cards", async () => (await board.locator("article.opt-card").count()) === 3, 10_000);
      await sleep(800);
      await audit("options-board");
      await board.getByRole("button", { name: "Enlarge A" }).click();
      await board.getByRole("dialog", { name: "Option A enlarged" }).waitFor();
      await sleep(500);
      await audit("options-enlarged");
      await esc(win);
      await board.getByRole("article", { name: "Option B: Colour band" }).getByRole("button", { name: "More like this" }).click();
      await board.locator('[data-parent="B"]').waitFor({ timeout: 30_000 });
      await board.getByRole("article", { name: "Option B2: Band, tall title" }).getByRole("button", { name: "Add to combine" }).click();
      await board.getByRole("button", { name: "Round 1" }).click();
      await board.getByRole("article", { name: "Option C: Centred" }).getByRole("button", { name: "Add to combine" }).click();
      await sleep(600);
      await audit("options-combine");
      await board.getByRole("button", { name: "Combine B2 + C" }).click();
      const merged = board.getByRole("article", { name: "Option B2+C: Tall band, centred" });
      await merged.waitFor({ timeout: 30_000 });
      await merged.getByRole("button", { name: "Approve this" }).click();
      const fix = win.getByRole("region", { name: "Fix" });
      await fix.getByRole("region", { name: "Approved mockup" }).waitFor({ timeout: 30_000 });
      await sleep(600);
      await audit("fix-card-mockup");
      await fix.getByRole("button", { name: /Apply fix/ }).click();
      await waitFor("the run to end", async () => (await win.evaluate(() => window.shrike.listRuns())).every((r) => r.status !== "running"), 60_000);
      await systemWindow("after-options");
    });

    await scene("quest", async () => {
      await dismissResult(win, 1500);
      await blur(win);
      await win.keyboard.press("Meta+k");
      const ask = win.getByRole("dialog", { name: "Ask your agent" });
      const toggle = ask.getByRole("button", { name: "Show me options" });
      if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
      await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Plan this: edit a todo");
      await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
      const scope = win.getByRole("dialog", { name: /^Options: How much should editing a todo cover\?/ });
      await scope.waitFor({ timeout: 30_000 });
      await sleep(600);
      await audit("quest-scope-cards", undefined, QUICK);
      await scope.getByRole("article", { name: "Option B: With the extras" }).getByRole("button", { name: "Approve this" }).click();
      const board = win.getByRole("dialog", { name: "Quest board" });
      await board.waitFor({ timeout: 30_000 });
      const start = board.getByRole("button", { name: "Start this quest" });
      await waitFor("the plan", () => start.isEnabled(), 30_000);
      await sleep(500);
      await audit("quest-board");
      await start.click();
      const obj = (id: string) => board.locator(`li[data-objective="${id}"]`);
      await obj("o1").getByText("Tick a todo").waitFor({ timeout: 30_000 });
      await obj("o1").getByRole("button", { name: "Check it" }).click();
      await waitFor("o1 to pass", async () => (await obj("o1").getAttribute("data-look")) === "passed", 60_000);
      await sleep(500);
      await audit("quest-one-passed", undefined, QUICK);
      await obj("o2").getByRole("button", { name: "Check it" }).click();
      await win.getByRole("status", { name: /^Quest complete/ }).waitFor({ timeout: 60_000 });
      await audit("quest-complete", undefined, QUICK); // at once: the results screen takes over in a second or two
      // A promotion opens its own System window over the quest's end: shoot them together when it shows.
      const promo = win.locator('[aria-label^="Promoted from"]').first();
      if (await shows(promo, 1500)) await audit("quest-promotion", undefined, QUICK); // short: the results screen that follows closes on the next trip
      for (let i = 0; i < 3; i++) {
        if (!(await systemWindow(`quest-${i}`))) break;
        await sleep(4000);
      }
      if (await shows(win.locator(".xr-scrim"), 15_000)) {
        await sleep(2000);
        await audit("quest-result-screen", undefined, QUICK);
      }
      await dismissResult(win, 500);
      if (await board.isVisible().catch(() => false)) await esc(win);
    });

    await scene("workspaces", async () => {
      await key(win, "Meta+n");
      const dlg = win.getByRole("dialog", { name: "New workspace" });
      await dlg.waitFor();
      await sleep(400);
      await audit("create-workspace");
      const smart = dlg.getByRole("textbox", { name: "Name, PR number, branch or link" });
      await smart.fill("#5");
      await dlg.getByText("Pull request #5").waitFor({ timeout: 15_000 });
      await dlg.getByText("Create more").click();
      await sleep(300);
      await audit("create-workspace-pr", undefined, QUICK);
      await win.keyboard.press("Meta+Enter");
      await dlg.getByText("pr-5 is ready").waitFor({ timeout: 60_000 });
      for (const name of ["try cents with a much longer workspace name", "fix add todo"]) {
        await dlg.getByRole("tab", { name: "New name" }).click();
        await dlg.getByRole("textbox", { name: "Workspace name" }).fill(name);
        const adv = dlg.getByText("Advanced");
        if (await adv.isVisible().catch(() => false)) await adv.click().catch(() => {});
        const runIt = dlg.getByRole("checkbox", { name: /Run the app with its run skill/ });
        if ((await runIt.count()) && (await runIt.isChecked())) await runIt.uncheck();
        await dlg.getByRole("button", { name: /Create workspace/ }).click();
        await dlg.getByText(/is ready/).last().waitFor({ timeout: 60_000 }).catch(() => {});
      }
      if (await dlg.isVisible().catch(() => false)) await dlg.getByRole("button", { name: "Cancel" }).click();
      await dlg.waitFor({ state: "detached", timeout: 5000 });
      await waitFor("back on main", async () => !(await win.evaluate(() => window.shrike.getProject()))?.root.includes("/.shrike/worktrees/"), 5000).catch(async () => {
        await win.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^main/ }).click();
        await waitFor("on main", async () => !(await win.evaluate(() => window.shrike.getProject()))?.root.includes("/.shrike/worktrees/"), 30_000);
      });
      await sleep(800);
      await audit("rail-expanded");
      await key(win, "Meta+b");
      await sleep(500);
      await audit("rail-collapsed");
      await key(win, "Meta+b");
    });

    const dock = win.getByRole("complementary", { name: "Right dock" });
    await scene("dock-changes", async () => {
      await key(win, "Meta+Shift+KeyG");
      await dock.waitFor({ timeout: 5000 });
      await sleep(800);
      await audit("dock-changes");
      await dock.getByRole("region", { name: "Changes", exact: true }).getByRole("button", { name: /\.tsx?\b/ }).first().click();
      await win.getByRole("dialog", { name: /^Changes to / }).waitFor({ timeout: 5000 });
      await sleep(500);
      await audit("dock-diff");
      await esc(win);
    });

    await scene("dock-commit", async () => {
      await dock.getByRole("button", { name: /Write it for me/ }).click();
      const box = dock.getByRole("textbox", { name: "Commit message" });
      await waitFor("the agent's message", async () => (await box.inputValue()).length > 5, 60_000);
      await sleep(300);
      await audit("dock-commit-message", undefined, QUICK);
      await dock.getByRole("button", { name: /^Commit all/ }).click();
      await dock.getByRole("button", { name: /Undo last commit/ }).waitFor({ timeout: 15_000 });
      await sleep(400);
      await audit("dock-committed", undefined, QUICK);
    });

    await scene("ship", async () => {
      gitIn(proj, "checkout", "-qb", "fix-add-todo-owner"); // main has nothing to open a PR from
      await blur(win);
      await win.getByRole("banner").getByRole("button", { name: "More" }).click();
      await win.getByRole("banner").getByRole("button", { name: "Ship (S)" }).click();
      const sheet = win.getByRole("dialog", { name: "Ship" });
      await sheet.waitFor({ timeout: 5000 });
      await sheet.getByRole("button", { name: "Open a pull request" }).waitFor({ timeout: 20_000 });
      await sleep(600);
      await audit("ship-sheet");
      await sheet.getByRole("button", { name: "Open a pull request" }).click({ timeout: 20_000 });
      const allow = sheet.getByRole("region", { name: "Allow this?" });
      await allow.waitFor({ timeout: 20_000 });
      await sleep(300);
      await audit("approval-ship-allow");
      await allow.getByRole("button", { name: "Allow" }).click();
      await sheet.getByText(/Pull request #\d+ · open/).waitFor({ timeout: 30_000 });
      await sleep(300);
      await audit("ship-pr-open", undefined, QUICK);
      await sheet.getByRole("button", { name: "Checks and comments" }).click();
      if (await sheet.isVisible().catch(() => false)) await sheet.getByRole("button", { name: "Close" }).click();
    });

    await scene("dock-pr", async () => {
      const panel = win.locator("[data-pr-panel]");
      await panel.getByTestId("check-line").first().waitFor({ timeout: 30_000 });
      await sleep(600);
      await audit("dock-pr");
      await panel.locator('[data-check="test"] button[aria-expanded]').first().click();
      await panel.getByLabel("Failing lines").waitFor({ timeout: 15_000 });
      await sleep(400);
      await audit("dock-pr-failing-check");
      const tabs = panel.getByRole("tablist", { name: "Whose comments" });
      await tabs.getByRole("tab", { name: /Bots/ }).click();
      await sleep(300);
      await audit("dock-pr-bots", undefined, QUICK);
      await tabs.getByRole("tab", { name: /People/ }).click();
      const t1 = panel.locator('[data-thread="PRRT_1"]');
      await t1.getByRole("button", { name: "Reply" }).click();
      await t1.getByLabel("Your reply").fill("Fixed: it reads userId now, and the test covers the empty title case as well.");
      await sleep(300);
      await audit("dock-pr-reply", undefined, QUICK);
      await t1.getByRole("button", { name: "Post reply" }).click();
      await panel.getByRole("region", { name: "Allow this?" }).waitFor({ timeout: 15_000 });
      await sleep(300);
      await audit("approval-pr-reply");
      await panel.getByRole("region", { name: "Allow this?" }).getByRole("button", { name: "Allow" }).click();
    });

    for (const [tab, name] of [["Lessons", "dock-lessons"], ["Tools", "dock-tools"]] as const) {
      await scene(name, async () => {
        if (!(await dock.isVisible())) await key(win, "Meta+Shift+KeyG");
        await dock.getByRole("tab", { name: tab }).click();
        await sleep(900);
        await audit(name);
      });
    }

    await scene("dock-api", async () => {
      await dock.getByRole("tab", { name: "API" }).click();
      await sleep(700);
      await audit("dock-api-empty", undefined, QUICK);
      await dock.getByRole("combobox", { name: "Method" }).selectOption("GET");
      await dock.getByRole("textbox", { name: "URL", exact: true }).fill("/api/todos");
      await dock.getByRole("button", { name: "Send", exact: true }).click();
      await dock.getByText(/OK \(200\)/).first().waitFor({ timeout: 15_000 });
      await sleep(500);
      await audit("dock-api-response");
      await dock.getByRole("textbox", { name: "URL", exact: true }).click();
      await win.keyboard.press("Meta+e");
      await win.getByText("Environments").first().waitFor({ timeout: 4000 });
      await sleep(400);
      await audit("dock-api-env");
      await esc(win);
      await dock.getByRole("button", { name: "Show collections" }).click();
      await sleep(500);
      await audit("dock-api-tree");
      await dock.getByRole("button", { name: "New", exact: true }).click();
      await win.getByRole("menuitem", { name: /Import/ }).click();
      await win.getByRole("textbox", { name: "Paste a curl command or a collection" }).waitFor({ timeout: 4000 });
      await sleep(400);
      await audit("dock-api-import");
      await esc(win, 2);
    });

    await scene("api-sheet", async () => {
      await key(win, "Meta+Shift+KeyG"); // close the dock: the client opens over the stage
      await key(win, "a");
      const sheet = win.getByRole("region", { name: "API client" });
      await sheet.waitFor({ timeout: 5000 });
      await sheet.getByRole("textbox", { name: "URL", exact: true }).fill("/api/todos");
      await sheet.getByRole("button", { name: "Send", exact: true }).click();
      await sheet.getByText(/OK \(200\)/).first().waitFor({ timeout: 15_000 });
      await sleep(500);
      await audit("api-workspace");
      await blur(win);
      await key(win, "Escape");
    });

    await scene("inspector", async () => {
      await win.locator(".th-lanehead button.th-lanebtn", { hasText: /DATABASE/ }).click();
      await win.locator(".insp").getByRole("table").first().waitFor({ timeout: 15_000 });
      await sleep(500);
      await audit("inspector-db");
      await win.locator(".insp").getByRole("tab", { name: /What this click changed/ }).click().catch(() => {});
      await win.locator(".th-lanehead button.th-lanebtn", { hasText: /SERVER/ }).click(); // digit keys skip the SCREEN lane, so click it like a person
      await win.locator(".insp .insp-out").waitFor({ timeout: 10_000 });
      await sleep(400);
      await audit("inspector-service");
      await key(win, "0");
    });

    await scene("skills", async () => {
      await key(win, "k");
      await win.getByRole("region", { name: "Skills" }).or(win.getByRole("dialog", { name: "Skills" })).first().waitFor({ timeout: 5000 });
      await sleep(600);
      await audit("skills-shelf");
      await win.getByRole("button", { name: "Recipes" }).click();
      await sleep(500);
      await audit("skills-recipes");
      await key(win, "Escape");
    });

    await scene("flows", async () => {
      await key(win, "w");
      await sleep(700);
      await audit("flows-shelf");
      await key(win, "Escape");
    });

    await scene("voice", async () => {
      const orb = win.getByRole("button", { name: /Voice: hold to talk|Getting voice ready|Listening/ }).first();
      await orb.waitFor({ timeout: 3000 });
      const b = (await orb.boundingBox())!;
      await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await win.mouse.down();
      await sleep(900);
      await audit("voice-holding", undefined, QUICK);
      await win.mouse.up();
      await sleep(1200);
      await audit("voice-after", undefined, QUICK);
      await key(win, "Escape");
    });

    await scene("race", async () => {
      if (!brokenId) throw new Error("no broken trip");
      void win.evaluate((id) => window.shrike.startRace(id, 2), brokenId).catch((e) => console.error(`startRace: ${(e as Error).message}`));
      await win.getByRole("button", { name: /^Allow/ }).click({ timeout: 20_000 }); // "Let both try?" asks first
      const race = win.getByRole("region", { name: "Fix race" });
      await race.waitFor({ timeout: 60_000 });
      await sleep(3000);
      await audit("race-card");
      // The recorded race can end with neither fix finishing: then there is no Found it card to shoot beside it.
      if (await win.getByRole("region", { name: "Found it" }).waitFor({ timeout: 30_000 }).then(() => true, () => false)) await audit("race-with-found-it");
    });
  } finally {
    writeFileSync(join(OUT, "summary.json"), JSON.stringify({ skipped, states: [...new Set(results.map((r) => r.state))], findings: results.reduce((n, r) => n + r.findings.length, 0) }, null, 1));
    await cleanup();
    cc.remove();
    rmSync(ghDir, { recursive: true, force: true });
    rmSync(join(proj, ".."), { recursive: true, force: true });
    assert.equal(listening([web, api]), "", "the app's ports are free after the run");
  }
});

test("layout audit: the place inspector on shop-app (cache, service, outside)", { timeout: 900_000 }, async () => {
  const [sw, sa, su, sp] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const proj = fixtureCopy("shop-app", { ports: { 5180: sw, 4100: sa, 4101: su, 4199: sp } });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  const audit = auditor(app, win);
  current = win;
  const lane = (text: RegExp) => win.locator(".th-lanehead button.th-lanebtn", { hasText: text });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await win.getByRole("button", { name: "Open a folder" }).click();
    const setup = win.getByRole("dialog", { name: "Set up shop-app" });
    await setup.waitFor();
    await sleep(500);
    await audit("shop-setup-dialog");
    await setup.getByRole("button", { name: "Run all" }).click();
    const guest = await waitFor("the shop page", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${sw}`)), 120_000);
    await guest.getByRole("button", { name: "Pay now" }).waitFor({ timeout: 60_000 });
    await dismissResult(win, 5000);
    await sleep(2000);
    await guest.getByRole("button", { name: "Pay now" }).click();
    await guest.getByText("Payment failed").waitFor({ timeout: 20_000 });
    await sleep(2500);
    await dismissResult(win, 1000);
    await scene("shop-trip", () => audit("shop-pay-trip"));
    for (const [re, name, ready] of [[/POSTGRES/, "inspector-db-postgres", "table"], [/sessions/i, "inspector-cache", "li[data-mark=hit]"], [/STRIPE/, "inspector-outside", ".insp-call.focus"], [/^API/, "inspector-service-api", ".insp-out"]] as const) {
      await scene(name, async () => {
        await lane(re).first().click();
        await win.locator(`.insp ${ready}`).first().waitFor({ timeout: 15_000 });
        await sleep(500);
        await audit(name);
      });
    }
  } finally {
    await cleanup();
    rmSync(join(proj, ".."), { recursive: true, force: true });
    assert.equal(listening([sw, sa, su, sp]), "", "the shop's ports are free after the run");
  }
});

// After both runs: summary.md (every state, its counts per check, the marked shot), and with LAYOUT_STRICT=1 a gate on the
// checks that are never intentional. covered / glass / occluded / cramped stay informational: cards sit over the Thread by design.
const GATE = ["overlap", "floating", "offscreen", "cutoff", "clipped", "zero"];
test("layout audit: summary and gate", () => {
  const byState = new Map<string, Sweep[]>();
  for (const r of results) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);
  const lines = ["# Layout audit", "", `Skipped scenes: ${skipped.length ? skipped.join("; ") : "none"}`, "", "| State | Size | Theme | Findings by check | Marked shot |", "|---|---|---|---|---|"];
  for (const [state, rs] of byState)
    for (const r of rs) {
      const n = new Map<string, number>();
      for (const f of r.findings) n.set(f.check, (n.get(f.check) ?? 0) + 1);
      lines.push(`| ${state} | ${r.size.w}x${r.size.h} | ${r.theme} | ${[...n].map(([k, v]) => `${k} ${v}`).join(", ") || "none"} | ${r.marked ?? ""} |`);
    }
  writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
  if (process.env.LAYOUT_STRICT !== "1") return;
  const bad = results.flatMap((r) => r.findings.filter((f) => GATE.includes(f.check)).map((f) => `${r.state} ${r.size.w}x${r.size.h} ${r.theme}: ${f.check} ${f.a}${f.b ? ` / ${f.b}` : ""}`));
  assert.deepEqual(bad, [], `layout findings (see ${OUT}/summary.md)`);
});
