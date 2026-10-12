// QB1–QB9 and L8–L15 in the built app with a recorded Claude Code stream (fake-quest.mjs, for real over Shrike's MCP tools):
// "Plan this: edit a todo" in the composer, the scope as option cards, the plan on the quest board (Not this, then Start this
// quest), objectives ghosted until their flows pass, Check it checks them off, the quest completes, plan-feature levels up in
// the project, the Build rail follows it, Open as GitHub issue goes through an approval (fake gh), and an issue imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Quest } from "@shrike/schema";
import { dismissResult, fakeClaude, fixtureCopy, freePort, launch, openFolder, questReady, shot, sleep, waitFor } from "./helpers.ts";

const P = "quests";
const quests = (win: Page) => win.evaluate(() => window.shrike.listQuests()) as Promise<Quest[]>;

test("quests: plan a feature, objectives check off as their flows pass, the quest completes and ends with a skill", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const ghDir = mkdtempSync(join(tmpdir(), "shrike-e2e-gh-quests-"));
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-quests.mjs")}" "$@"\n`, { mode: 0o755 });
  const cc = fakeClaude(150);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(ghDir, "gh"), SHRIKE_FAKE_GH_DIR: ghDir, ...cc.env });
  const errs: string[] = [];
  win.on("pageerror", (e) => errs.push(e.message));
  const board = win.getByRole("dialog", { name: "Quest board" });
  const rail = win.locator('[data-mode="build"]');
  const obj = (id: string) => board.locator(`li[data-objective="${id}"]`);
  const diag = async (e: Error): Promise<never> => {
    await shot(app, "fail", P);
    throw new Error(`${e.message}\n${JSON.stringify({ errs, quests: await quests(win).catch(() => []), calls: cc.calls().map((c) => c.kind) }, null, 1)}`);
  };
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    await dismissResult(win, 2000);

    // QB1: "Plan this: …" in the composer becomes a [ QUEST ] card and starts plan-feature
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    await ask.waitFor();
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Plan this: edit a todo");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    const call = await waitFor("the plan-feature run", () => cc.calls().find((c) => c.kind === "quest"), 30_000).catch(diag);
    assert.match(call.goal, /^Plan this feature as Shrike quest [0-9a-f]{8}: edit a todo/);
    const [q0] = await quests(win);
    assert.equal(q0!.state, "planning");

    // QB2: the scope as option cards first (the quest board waits behind them)
    const scope = win.getByRole("dialog", { name: /^Options: How much should editing a todo cover\?/ });
    await scope.waitFor({ timeout: 30_000 }).catch(diag);
    await sleep(300);
    await shot(app, "scope-cards", P);
    await scope.getByRole("article", { name: "Option B: With the extras" }).getByRole("button", { name: "Approve this" }).click();

    // QB3: the plan waits on the board, objectives ghosted; Not this asks again; Start this quest starts it
    await board.waitFor({ timeout: 30_000 }).catch(diag);
    const start = board.getByRole("button", { name: "Start this quest" });
    await waitFor("the plan", () => start.isEnabled(), 30_000).catch(diag);
    assert.deepEqual(await board.locator("li[data-look]").evaluateAll((els) => els.map((e) => e.getAttribute("data-look"))), ["ghost", "ghost"]);
    assert.equal(await rail.locator('[data-stage="plan"]').getAttribute("data-state"), "active", "the rail switched to Build by itself");
    await sleep(400);
    await shot(app, "plan-waiting", P);
    await board.getByRole("button", { name: "Not this" }).click();
    await waitFor("the plan again", () => start.isEnabled(), 30_000).catch(diag);
    await start.click();

    // QB4/QB6: flows linked; the first objective is next, the second a ghost
    await waitFor("both flows linked", async () => (await quests(win))[0]?.objectives.every((o) => o.flowId), 30_000).catch(diag);
    await obj("o1").getByText("Tick a todo").waitFor();
    assert.equal(await obj("o1").getAttribute("data-look"), "next");
    assert.equal(await obj("o2").getAttribute("data-look"), "ghost");
    assert.equal(await obj("o2").getByRole("button", { name: "Check it" }).count(), 0, "only the next objective shows its buttons");
    await sleep(400);
    await shot(app, "quest-active", P);

    // a flow passes: its objective checks off by itself and the next one lights
    await obj("o1").getByRole("button", { name: "Check it" }).click();
    await waitFor("o1 to pass", async () => (await obj("o1").getAttribute("data-look")) === "passed", 60_000).catch(diag);
    assert.equal(await obj("o2").getAttribute("data-look"), "next");
    await waitFor("Prove to lead the rail", async () => (await rail.locator('[data-stage="prove"]').getAttribute("data-state")) === "active", 10_000).catch(diag);
    assert.match((await rail.innerText()).replace(/\s+/g, " "), /1 of 2 objectives pass/);
    await sleep(400);
    await shot(app, "one-passed", P);

    // QB7: the last one passes: [Quest Complete], plan-feature's draft is kept in the project, the result screen
    await obj("o2").getByRole("button", { name: "Check it" }).click();
    await waitFor("the quest to complete", async () => (await quests(win))[0]?.state === "complete", 60_000).catch(diag);
    await win.getByRole("status", { name: "Quest complete: Build: Edit a todo" }).waitFor({ timeout: 20_000 }).catch(diag);
    await sleep(500);
    await shot(app, "quest-complete", P);
    const skill = join(proj, ".shrike", "skills", "plan-feature.md");
    await waitFor("plan-feature to level up in the project", () => existsSync(skill), 20_000).catch(diag);
    const text = readFileSync(skill, "utf8");
    assert.match(text, /^version: 2$/m);
    assert.match(text, /v2: start a todo-app quest with a flow that ticks a todo/);
    assert.equal(await board.count(), 0, "the board steps aside for the System's moment");
    const result = await waitFor("the result (screen or chip)", async () => (await win.locator(".xr-scrim").count()) || (await win.getByRole("button", { name: /Quest result/ }).count()), 20_000).catch(diag);
    assert.ok(result);
    const shown = (await win.locator(".xr-scrim").count()) ? await win.locator(".xr-scrim").innerText() : await win.getByRole("button", { name: /Quest result/ }).getAttribute("title");
    assert.match(shown ?? "", /Edit a todo/, "the newest quest's result, not the start's");
    if (await win.locator(".xr-scrim").count()) {
      await sleep(1500);
      await shot(app, "result-screen", P);
    }
    await dismissResult(win, 500);
    assert.deepEqual(readdirSync(join(proj, ".shrike", "quests")), [`${q0!.id}.json`]);

    // QB8: Open as GitHub issue, behind an approval (fake gh)
    if (!(await board.isVisible())) { await win.getByRole("banner").getByRole("button", { name: "More" }).click(); await win.getByRole("banner").getByRole("button", { name: "Quests (Q)" }).click(); }
    await board.getByRole("button", { name: "More" }).click();
    await board.getByRole("menuitem", { name: "Open as GitHub issue" }).click();
    const allow = board.getByRole("region", { name: "Allow this?" });
    await allow.waitFor({ timeout: 10_000 }).catch(diag);
    assert.match(await allow.innerText(), /- \[x\] Your todos still load and tick off/);
    await sleep(300);
    await shot(app, "open-issue", P);
    await allow.getByRole("button", { name: "Allow" }).click();
    await board.getByRole("button", { name: "#42" }).waitFor({ timeout: 10_000 }).catch(diag);
    const ghCalls = readFileSync(join(ghDir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    assert.equal(ghCalls.filter((c) => c[0] === "issue" && c[1] === "create").length, 1);

    // QB1: import an open issue as a new quest; the finished one becomes a sliver
    await board.getByRole("button", { name: "From a GitHub issue" }).click();
    await board.getByRole("listbox", { name: "Open issues" }).getByRole("button", { name: /#12\s*Let people edit a todo/ }).click();
    await waitFor("the imported quest", async () => (await quests(win)).find((q) => q.issue?.number === 12), 10_000).catch(diag);
    const imported = (await quests(win)).find((q) => q.issue?.number === 12)!;
    assert.match(imported.idea, /From GitHub issue #12:\n### Acceptance criteria\n\n\* \[ \] Click a title to edit it/);
    assert.doesNotMatch(imported.idea, /template/);
    assert.ok(ghCalls.every((c) => !(c[0] === "issue" && c[1] === "edit")), "nothing but issue create was written");
    await waitFor("the second plan run", () => cc.calls().filter((c) => c.kind === "quest").length === 2, 30_000).catch(diag);
    await win.getByRole("dialog", { name: /^Options: How much should editing a todo cover\?/ }).waitFor({ timeout: 30_000 }).catch(diag);
    await win.keyboard.press("Escape"); // put the cards away; the board comes back with the new quest focused
    await board.getByRole("button", { name: "Focus quest: Edit a todo" }).waitFor({ timeout: 10_000 }).catch(diag);
    await sleep(400);
    await shot(app, "imported", P);
    // every theme reads: Daylight and High contrast with the board up
    for (const [label, id] of [["Daylight", "daylight"], ["High contrast", "contrast"]] as const) {
      await win.getByRole("button", { name: "Appearance" }).click();
      const dlg = win.getByRole("dialog", { name: "Appearance" });
      await dlg.getByRole("radio", { name: `${label} theme` }).click();
      await win.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      await board.waitFor();
      await sleep(400);
      await shot(app, `theme-${id}`, P);
    }
    assert.deepEqual(errs, []);
  } finally {
    await cleanup();
    cc.remove();
    rmSync(ghDir, { recursive: true, force: true });
  }
});
