// P1–P5 in the built app with the recorded Claude Code stream (fake-claude.mjs): two prompts queued while a run works fire in order in
// the same session; a chain whose critique scores 5 polishes and stops when the score passes, or at the round limit; a failed run takes
// the failure branch; a scheduled prompt fires; after a relaunch, missed and run-gated items ask instead of firing. The critic is a separate read-only call that scores from FAKE_CRITIQUE_SCORES.
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { AgentRunInfo, ChainsState } from "@shrike/schema";
import { fakeClaude, fixtureCopy, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const runs = (win: Page) => win.evaluate(() => window.shrike.listRuns()) as Promise<AgentRunInfo[]>;
const chains = (win: Page) => win.evaluate(() => window.shrike.getChains()) as Promise<ChainsState>;
const P = "p-chains";

async function askPill(win: Page): Promise<ReturnType<Page["getByRole"]>> {
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press("Meta+k");
  const ask = win.getByRole("dialog", { name: "Ask your agent" });
  await ask.waitFor();
  const brain = ask.getByRole("combobox", { name: "Which agent to use" });
  if (await brain.count()) await brain.selectOption("claude-code");
  await waitFor("an agent to ask", async () => (await win.evaluate(() => window.shrike.detectBrains())).some((b) => b.available), 10_000);
  return ask;
}

test("chains: up next fires in order, critique branches, round limit, failure branch, schedule", { timeout: 600_000 }, async () => {
  const proj = fixtureCopy("todo-app");
  const cc = fakeClaude(350);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env, FAKE_CRITIQUE_SCORES: "5,9,5,5", FAKE_CLAUDE_FAIL: "^Deploy it" });
  const panel = win.getByRole("region", { name: "Prompt chain" });
  const upNext = win.getByRole("region", { name: "Up next" });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    await win.getByRole("banner").getByText(/Claude Code/i).first().waitFor({ timeout: 15_000 }); // the agent is picked
    await sleep(1000);

    // ---- P1: queue two prompts while the agent works ----
    let ask = await askPill(win);
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Build the about page");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    const main = await waitFor("the first run", () => cc.calls().find((c) => c.kind === "main"), 30_000);
    await waitFor("the agent working", async () => (await runs(win)).some((r) => r.status === "running"), 20_000);

    ask = await askPill(win);
    await ask.getByRole("button", { name: "Add to up next" }).waitFor();
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("write the tests");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Meta+Shift+Enter");
    await ask.waitFor({ state: "detached" });
    ask = await askPill(win);
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("update the readme");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter"); // Enter while it works adds to up next too
    await ask.waitFor({ state: "detached" });
    assert.ok(!cc.finished(main.session), "both were queued while the first run still worked");
    await upNext.getByRole("listitem", { name: /^Up next 2: update the readme/ }).waitFor({ timeout: 5000 });
    assert.deepEqual(await upNext.getByRole("listitem").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), ["Up next 1: write the tests", "Up next 2: update the readme"]);
    await win.locator('aside[aria-label="Agent"]').hover();
    await sleep(400);
    await shot(app, "queue-stack", P);

    const fired = await waitFor("both queued prompts to run", () => {
      const r = cc.calls().filter((c) => c.kind === "resume");
      return r.length >= 2 && r;
    }, 60_000);
    assert.deepEqual(fired.slice(0, 2).map((c) => c.goal), ["write the tests", "update the readme"], "they fire in order");
    assert.ok(fired.slice(0, 2).every((c) => c.resume === main.session), "each continues the same Claude Code session");
    await win.getByRole("status", { name: /^Next up: / }).first().waitFor({ timeout: 10_000 }).then(() => shot(app, "toast-next", P)).catch(() => {});
    await waitFor("the queue to drain", async () => {
      const st = await chains(win);
      return st.items.length >= 2 && st.items.every((i) => i.state === "done") && (await runs(win)).every((r) => r.status !== "running");
    }, 60_000);
    const list = await runs(win);
    const [r1, r2, r3] = ["Build the about page", "write the tests", "update the readme"].map((g) => list.find((r) => r.goal === g)!);
    assert.equal(r2!.continues, r1!.id, "write the tests continued the first run");
    assert.equal(r3!.continues, r2!.id, "update the readme continued after it");

    // ---- P3: a chain; the critique scores 5, the below branch polishes, the next critique scores 9 and it stops ----
    ask = await askPill(win);
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Build the settings page");
    await ask.getByRole("button", { name: "Make it a chain" }).click();
    await panel.waitFor();
    await ask.waitFor({ state: "detached" });
    await panel.getByRole("textbox", { name: "Chain name" }).fill("Settings polish");
    assert.equal(await panel.getByRole("slider", { name: "Threshold" }).inputValue(), "8");
    await panel.getByRole("button", { name: /^Repeat until score ≥ 8/ }).click();
    await sleep(300);
    await shot(app, "chain-editor", P);
    const critiquesBefore = cc.calls().filter((c) => c.kind === "critique").length;
    await panel.getByRole("button", { name: "Start chain" }).click();
    await panel.getByRole("img", { name: "Score 5 of 10" }).waitFor({ timeout: 60_000 });
    await panel.locator('li[data-branch="below"][aria-current="step"]').waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot(app, "chain-running-below", P);
    const c1 = await waitFor("the chain to finish", async () => {
      const c = (await chains(win)).chain;
      return c && (c.state === "done" || c.state === "stopped") && c;
    }, 90_000);
    assert.equal(c1.state, "done", c1.why);
    assert.deepEqual(c1.steps.map((s) => [s.node, s.score, s.took]), [["prompt", 5, "below"], ["below", 9, "stop"]]);
    const critiques = cc.calls().filter((c) => c.kind === "critique").slice(critiquesBefore);
    assert.equal(critiques.length, 2, "one critique per round");
    assert.match(critiques[0]!.disallowed ?? "", /mcp__shrike__propose_patch/, "the critic only reads");
    assert.match(critiques[0]!.goal, /^Score this run from 0 to 10/);
    const polish = cc.calls().find((c) => c.kind === "resume" && /scored the last attempt 5 \/ 10/.test(c.goal));
    assert.ok(polish, "the polish prompt carries the critique");
    await panel.getByRole("img", { name: "Score 9 of 10" }).waitFor();
    await panel.locator('li[data-branch="pass"][aria-current="step"]').waitFor();
    await sleep(400);
    await shot(app, "chain-passed", P);

    // ---- round limit: max 2 rounds, every score 5; the panel is closed, so the critique speaks as a toast ----
    await panel.getByRole("button", { name: "Edit" }).click();
    await panel.getByRole("spinbutton", { name: "Max rounds" }).fill("2");
    await panel.getByRole("button", { name: "Start chain" }).click();
    await panel.getByRole("button", { name: "Stop chain" }).waitFor();
    await panel.getByRole("button", { name: "Close the chain panel" }).click();
    await win.getByRole("status", { name: /^Critique: 5 \/ 10 → polishing/ }).waitFor({ timeout: 60_000 });
    await shot(app, "toast-critique", P);
    const c2 = await waitFor("the round limit", async () => {
      const c = (await chains(win)).chain;
      return c && c.id !== c1.id && (c.state === "done" || c.state === "stopped") && c;
    }, 120_000);
    assert.match(c2.why ?? "", /Stopped after 2 rounds at 5 \/ 10/);
    assert.equal(c2.round, 2);
    await win.getByRole("status", { name: /^Chain complete:/ }).waitFor({ timeout: 15_000 }).then(() => shot(app, "toast-complete", P)).catch(() => {});

    // ---- P3 failure branch, built in the editor ----
    ask = await askPill(win);
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Deploy it to staging");
    await ask.getByRole("button", { name: "Make it a chain" }).click();
    await panel.waitFor();
    const failNode = panel.getByRole("group", { name: "Stop step" });
    await failNode.getByRole("button").click();
    await failNode.getByRole("textbox").fill("Explain what broke in plain words");
    await panel.getByRole("textbox", { name: "Chain name" }).click(); // blur saves it
    await panel.getByRole("group", { name: "Recover step" }).waitFor();
    await panel.getByRole("button", { name: "Start chain" }).click();
    const c3 = await waitFor("the failure branch to finish", async () => {
      const c = (await chains(win)).chain;
      return c && c.id !== c2.id && (c.state === "done" || c.state === "stopped") && c;
    }, 90_000);
    assert.deepEqual(c3.steps.map((s) => [s.node, s.status, s.took]), [["prompt", "failed", "failed"], ["failed", "done", "stop"]]);
    await panel.locator('li[data-branch="failed"][aria-current="step"]').waitFor();
    await sleep(400);
    await shot(app, "chain-failed-branch", P);

    // ---- P4: save it as a chain skill; /chain finds it ----
    await panel.getByRole("button", { name: "Edit" }).click();
    await panel.getByRole("textbox", { name: "Chain name" }).fill("Deploy or explain");
    await panel.getByRole("button", { name: "Save as chain" }).click();
    await waitFor("the saved chain", async () => (await win.evaluate(() => window.shrike.listChains())).some((d) => d.id === "deploy-or-explain"), 10_000);
    await panel.getByRole("button", { name: "Close the chain panel" }).click();

    // ---- P2: a scheduled prompt fires when its time comes ----
    await win.evaluate(() => window.shrike.queuePrompt("Check the logs for warnings", { on: "time", at: Date.now() + 7000 }));
    await upNext.getByRole("listitem", { name: /Check the logs for warnings/ }).waitFor({ timeout: 5000 });
    await win.locator('aside[aria-label="Agent"]').hover();
    await sleep(300);
    await shot(app, "schedule-card", P);
    const sched = await waitFor("the scheduled prompt to fire", () => cc.calls().find((c) => c.goal === "Check the logs for warnings"), 30_000);
    assert.equal(sched.kind, "resume", "it continues the session too");
  } catch (err) {
    await shot(app, "failed", P).catch(() => {});
    throw err;
  } finally {
    await cleanup();
    cc.remove();
  }
});

test("chains: up next survives a relaunch; a passed time and a run-gated item ask first", { timeout: 300_000 }, async () => {
  const proj = fixtureCopy("todo-app");
  const cc = fakeClaude(200);
  const data = mkdtempSync(join(tmpdir(), "shrike-e2e-chains-"));
  const boot = async () => {
    const l = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env }, data);
    await l.win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(l.win);
    const closeSetup = l.win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    return l;
  };
  let l = await boot();
  try {
    await l.win.evaluate(async () => {
      await window.shrike.pauseUpNext(true); // nothing fires before the quit
      await window.shrike.queuePrompt("Check the logs for warnings", { on: "time", at: Date.now() + 3_600_000 });
      await window.shrike.queuePrompt("Write the release notes", { on: "finished" });
    });
    await waitFor("up next saved", () => readdirSync(join(data, "chains")).some((f) => /Write the release notes/.test(readFileSync(join(data, "chains", f), "utf8"))), 10_000);
    await l.app.close();
    const f = join(data, "chains", readdirSync(join(data, "chains")).find((x) => x.endsWith(".json"))!);
    const saved = JSON.parse(readFileSync(f, "utf8")) as ChainsState;
    for (const i of saved.items) if (i.when.on === "time") i.when.at = Date.now() - 2 * 3_600_000; // Shrike was closed past it
    writeFileSync(f, JSON.stringify(saved));

    l = await boot();
    const upNext = l.win.getByRole("region", { name: "Up next" });
    await upNext.getByRole("listitem", { name: "Missed: Check the logs for warnings" }).waitFor({ timeout: 20_000 });
    await upNext.getByRole("listitem", { name: "Missed: Write the release notes" }).waitFor();
    await l.win.evaluate(() => window.shrike.pauseUpNext(false));
    await sleep(6000); // a timer tick and more
    assert.ok(!cc.calls().some((c) => c.goal === "Check the logs for warnings" || c.goal === "Write the release notes"), "nothing ran by itself after the relaunch");
    await l.win.locator('aside[aria-label="Agent"], [aria-label="Up next"]').first().hover().catch(() => {});
    await shot(l.app, "relaunch-missed", P);
    await upNext.getByRole("listitem", { name: "Missed: Write the release notes" }).getByRole("button", { name: "Skip" }).click();
    await upNext.getByRole("listitem", { name: "Missed: Check the logs for warnings" }).getByRole("button", { name: "Run it now" }).click();
    await waitFor("the missed prompt to run", () => cc.calls().find((c) => c.goal === "Check the logs for warnings"), 30_000);
    const st = await chains(l.win);
    assert.equal(st.items.find((i) => i.prompt === "Write the release notes")?.state, "skipped");
    assert.ok(!cc.calls().some((c) => c.goal === "Write the release notes"), "skipped never runs");
  } catch (err) {
    await shot(l.app, "relaunch-failed", P).catch(() => {});
    throw err;
  } finally {
    await l.cleanup();
    rmSync(data, { recursive: true, force: true });
    cc.remove();
  }
});
