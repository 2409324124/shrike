// Voice understanding in the built app (docs/16 phases 1 and 2): registry, grammar, the real bundled planner in its
// utilityProcess, the plan executor and its card. The helper is stood in for at main's voiceSend; pushes are counted, never sent.
// The planner part runs when its model is in ~/Library/Application Support/@shrike/desktop/models (else it's skipped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import type { VoiceCommand, VoiceEvent } from "@shrike/schema";
import { PLANNER_MODEL } from "../src/main/voice-planner-model.ts";
import { PLANNER_PREFIX } from "../src/renderer/src/voice/understand/plan.ts";
import { fixtureCopy, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

type Main = typeof globalThis & { __cmds: VoiceCommand[]; __pushes: number; __emit(e: VoiceEvent): void };
const MODEL = join(process.env.SHRIKE_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models"), PLANNER_MODEL.file);

async function fakeHelper(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as Main;
    g.__cmds = [];
    g.__pushes = 0;
    g.__emit = (e) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow())!.webContents.send("shrike:event:voice:event", e);
    ipcMain.removeHandler("shrike:voiceSend");
    ipcMain.handle("shrike:voiceSend", (_e, cmd: VoiceCommand) => void g.__cmds.push(cmd));
    ipcMain.removeHandler("shrike:scmSync");
    ipcMain.handle("shrike:scmSync", () => {
      g.__pushes++;
      throw new Error("Push counted by the test, not sent");
    });
  });
}

const pushes = (app: ElectronApplication) => app.evaluate(() => (globalThis as Main).__pushes);
const starts = (app: ElectronApplication) => app.evaluate(() => (globalThis as Main).__cmds.filter((c) => c.cmd === "start") as { cmd: "start"; id: number }[]);
const emit = (app: ElectronApplication, e: VoiceEvent) => app.evaluate((_, e) => (globalThis as Main).__emit(e), e);

/** Hold ⌥ Space, the helper streams the words, let go, the final lands. Returns ms from the final to the strip's echo. */
async function say(app: ElectronApplication, win: Page, text: string): Promise<number> {
  const before = (await starts(app)).length;
  await win.keyboard.down("Alt");
  await win.keyboard.down("Space");
  const id = await waitFor("a start", async () => {
    const s = await starts(app);
    return s.length > before ? s.at(-1)!.id : undefined;
  });
  await emit(app, { type: "vad", id, speech: true });
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i++) (await emit(app, { type: "partial", id, text: words.slice(0, i).join(" ") }), await sleep(60));
  await win.keyboard.up("Space");
  await win.keyboard.up("Alt");
  await sleep(140);
  const t = Date.now();
  await emit(app, { type: "final", id, text });
  await waitFor("an echo", async () => (await win.locator("[data-voice-echo]").count()) > 0, 5000).catch(() => {});
  return Date.now() - t;
}

const echo = (win: Page) => win.locator("[data-voice-caption]").innerText().catch(() => "");

test("voice plans: grammar, the bundled planner, and a card that waits for yes before anything leaves", { timeout: 240_000 }, async () => {
  const proj = fixtureCopy("todo-app", { git: true });
  const { app, win, userData, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await openFolder(win);
    await win.locator('section[aria-label="Shrike"]').waitFor({ timeout: 60_000 });
    await fakeHelper(app);
    const planner = existsSync(MODEL);
    if (planner) {
      mkdirSync(join(userData, "models"), { recursive: true });
      symlinkSync(MODEL, join(userData, "models", PLANNER_MODEL.file));
      const ok = await win.evaluate((prefix) => (window as unknown as { shrike: { voicePlanWarm(p: string): Promise<boolean> } }).shrike.voicePlanWarm(prefix), PLANNER_PREFIX);
      assert.equal(ok, true, "the planner loads in its utilityProcess");
    }
    await win.locator("body").click({ position: { x: 5, y: 600 } });

    // Hindi straight to an action through the grammar, no model.
    await say(app, win, "लॉग्स दिखाओ");
    await waitFor("logs shown", async () => /Showing logs/i.test(await echo(win)));
    await shot(app, "01-hindi-logs", "voice-plan");

    // The multi-step outward plan: a card, nothing sent until yes.
    await say(app, win, "stage all files and push them");
    const card = win.locator("[data-voice-plan]");
    await waitFor("the plan card", async () => (await card.getAttribute("data-state")) === "needs_yes");
    const steps = await card.locator("[data-step-state]").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("data-step-state")]));
    assert.ok(steps.length >= 2, JSON.stringify(steps));
    assert.match(String(steps.at(-1)?.[0]), /Push to origin/);
    assert.equal(await pushes(app), 0, "nothing pushed before yes");
    await shot(app, "02-card-waits", "voice-plan");
    await sleep(500);
    assert.equal(await pushes(app), 0, "still nothing");
    await say(app, win, "haan");
    await waitFor("the push after yes", async () => (await pushes(app)) === 1);
    await waitFor("the card to settle", async () => ["failed", "done"].includes((await card.getAttribute("data-state").catch(() => "")) ?? ""));
    await shot(app, "03-after-yes", "voice-plan");

    // "no" leaves nothing sent.
    await say(app, win, "push");
    await waitFor("another card", async () => (await card.getAttribute("data-state")) === "needs_yes");
    await say(app, win, "nahi");
    await sleep(400);
    assert.equal(await pushes(app), 1, "no means nothing more was pushed");

    if (planner) {
      // Words the grammar can't place go to the planner (warm), and its plan runs.
      const ms = await say(app, win, "what did the server print");
      await waitFor("the planner's plan", async () => /terminal/i.test(await echo(win)), 5000);
      console.log(`planner turn: ${ms} ms from final to echo`);
      assert.ok(ms < 1500, `${ms} ms`);
      await shot(app, "04-planner-terminal", "voice-plan");
    }
  } finally {
    await cleanup();
  }
});
