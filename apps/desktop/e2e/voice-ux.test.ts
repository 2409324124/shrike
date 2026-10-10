// Voice UX (docs/16 §2.7) in the built app. The helper is stood in for at the IPC boundary (main's voiceSend handler),
// so the real renderer loop runs: ⌥ Space, the orb, live words, the cascade, the plan card, hands-free, settings. No mic.
// The helper's own WAV-injection e2e covers the audio side.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ElectronApplication, Page } from "playwright";
import type { VoiceCommand, VoiceEvent } from "@shrike/schema";
import { fixtureCopy, launch, openFolder, shot as snap, sleep, waitFor } from "./helpers.ts";

const shot = async (app: ElectronApplication, name: string, prefix: string) => (await sleep(120), snap(app, name, prefix)); // let the frame present

type Main = typeof globalThis & { __cmds: VoiceCommand[]; __pushes: number; __emit(e: VoiceEvent): void };

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
      throw new Error("e2e: nothing may push");
    });
  });
}

const cmds = (app: ElectronApplication) => app.evaluate(() => (globalThis as Main).__cmds);
const emit = (app: ElectronApplication, e: VoiceEvent) => app.evaluate((_, e) => (globalThis as Main).__emit(e), e);
const orb = (win: Page) => win.locator("[data-voice-orb] .v-orb");

/** Word by word, the way the helper streams partials, then the final. */
async function speak(app: ElectronApplication, id: number, text: string, o: { final?: boolean; gap?: number } = {}): Promise<void> {
  await emit(app, { type: "vad", id, speech: true });
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i++) {
    await emit(app, { type: "level", value: 0.3 + (i % 3) * 0.2 });
    await emit(app, { type: "partial", id, text: words.slice(0, i).join(" ") });
    await sleep(o.gap ?? 70);
  }
  if (o.final !== false) await emit(app, { type: "final", id, text });
}

/** Hold ⌥ Space, say it, let go. Returns the turn id the renderer asked the helper for. */
async function ptt(app: ElectronApplication, win: Page, text: string): Promise<number> {
  await win.keyboard.down("Alt");
  await win.keyboard.down("Space");
  const start = await waitFor("a start command", async () => (await cmds(app)).filter((c) => c.cmd === "start").at(-1));
  const id = (start as { id: number }).id;
  await speak(app, id, text, { final: false });
  await win.keyboard.up("Space");
  await win.keyboard.up("Alt");
  await sleep(140); // the helper's final lands ~140ms after release
  await emit(app, { type: "final", id, text });
  return id;
}

test("voice UX: instant orb, live words, plan card that waits for yes, hands-free, misses with a way out, settings", { timeout: 240_000 }, async () => {
  const proj = fixtureCopy("todo-app", { git: true });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" }); // a background test window doesn't tick CSS animations; this is also the Calm variant
    await openFolder(win);
    await win.locator('section[aria-label="Shrike"]').waitFor({ timeout: 60_000 });
    await fakeHelper(app);
    await win.locator("body").click({ position: { x: 5, y: 600 } });

    // The orb answers the key within a frame or two: under 50ms from keydown to the listening state.
    await win.evaluate(() => {
      const w = window as unknown as { __t: { down?: number; lit?: number }; __states: string[] };
      w.__t = {};
      w.__states = [];
      addEventListener("keydown", (e) => e.code === "Space" && e.altKey && (w.__t.down ??= e.timeStamp), true);
      const el = document.querySelector("[data-voice-orb] .v-orb")!;
      new MutationObserver(() => (w.__states.push(el.getAttribute("data-state")!), el.getAttribute("data-state") === "listening" && (w.__t.lit ??= performance.now()))).observe(el, { attributes: true });
    });
    await win.keyboard.down("Alt");
    await win.keyboard.down("Space");
    await waitFor("the orb to listen", async () => (await orb(win).getAttribute("data-state")) === "listening", 2000);
    const t = await win.evaluate(() => (window as unknown as { __t: { down: number; lit: number } }).__t);
    assert.ok(t.lit - t.down < 50, `orb reacted in ${Math.round(t.lit - t.down)}ms`);
    const id0 = ((await cmds(app)).find((c) => c.cmd === "start") as { id: number }).id;
    await emit(app, { type: "level", value: 0.7 });
    await shot(app, "listening", "vux");

    // The first partial is on screen as soon as it arrives, in Roman script.
    await emit(app, { type: "partial", id: id0, text: "पीआर" });
    await win.locator("[data-voice-heard]").getByText("peeaar").waitFor({ timeout: 500 });
    await emit(app, { type: "partial", id: id0, text: "logs dikhao" });
    await win.locator("[data-voice-heard]").getByText("logs dikhao").waitFor({ timeout: 500 });
    await shot(app, "hearing", "vux");
    await win.keyboard.up("Space");
    await win.keyboard.up("Alt");
    await emit(app, { type: "final", id: id0, text: "logs dikhao" });
    await win.locator("[data-voice-echo]").getByText(/logs/i).first().waitFor();
    await shot(app, "logs", "vux");
    await win.keyboard.press("Escape");
    const later = win.getByRole("button", { name: "Not now" });
    if (await later.isVisible()) await later.click(); // the first-run download card, when main reports the models missing

    // A two-step Hinglish command: the card, outward step marked, nothing pushed until yes; "nahi" cancels.
    await ptt(app, win, "sab files stage karo aur push kar do");
    const card = win.locator("[data-voice-plan]");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-state"), "needs_yes");
    await card.getByText("Leaves your Mac").waitFor();
    assert.equal(await orb(win).getAttribute("data-state"), "confirm");
    const states = await win.evaluate(() => (window as unknown as { __states: string[] }).__states);
    assert.ok(!states.includes("thinking"), `a grammar turn never flashes the sweep: ${states.join(" ")}`);
    await shot(app, "card", "vux");
    await sleep(600);
    assert.equal(await app.evaluate(() => (globalThis as Main).__pushes), 0, "nothing pushed without a yes");
    await ptt(app, win, "nahi");
    await waitFor("the card to cancel", async () => (await card.getAttribute("data-state").catch(() => "gone")) !== "needs_yes");
    assert.equal(await app.evaluate(() => (globalThis as Main).__pushes), 0);

    // Hands-free: double tap turns it on (helper told), the orb stays lit and says LISTENING; a press turns it off.
    for (let i = 0; i < 2; i++) {
      await win.keyboard.down("Alt");
      await win.keyboard.down("Space");
      await sleep(60);
      await win.keyboard.up("Space");
      await win.keyboard.up("Alt");
      await sleep(90);
    }
    await waitFor("hands-free on", async () => (await cmds(app)).some((c) => c.cmd === "hands" && c.on));
    await emit(app, { type: "level", value: 0.05 }); // the helper's mic is open: the watchdog stays quiet
    assert.equal(await orb(win).getAttribute("data-hands"), "true", JSON.stringify((await cmds(app)).slice(-8)));
    await win.locator("[data-voice-orb]").getByText("Listening").waitFor();
    await shot(app, "hands-free", "vux");
    await speak(app, 1_000_001, "show me the lags from yesterday");
    const chips = win.locator("[data-voice-chips]");
    await chips.getByRole("button", { name: "What can I say?" }).waitFor();
    await shot(app, "miss", "vux");
    await chips.getByRole("button", { name: "What can I say?" }).click();
    await win.getByRole("dialog", { name: "What you can say" }).waitFor();
    await shot(app, "hints", "vux");
    await win.getByRole("button", { name: "Close what you can say" }).click();

    // Hands-free may push after a spoken "haan" while the card is up (owner's answer). The stand-in push throws, so the card shows the failure.
    await speak(app, 1_000_002, "sab files stage karo aur push kar do");
    await waitFor("the hands-free card", async () => (await card.getAttribute("data-state").catch(() => null)) === "needs_yes");
    assert.equal(await app.evaluate(() => (globalThis as Main).__pushes), 0, "nothing pushed before the yes");
    await speak(app, 1_000_003, "haan");
    await waitFor("the push to run after haan", async () => (await app.evaluate(() => (globalThis as Main).__pushes)) === 1);
    await waitFor("the card to show the failure", async () => (await card.getAttribute("data-state").catch(() => null)) === "failed");
    await shot(app, "hands-yes-failed", "vux");
    await win.getByRole("button", { name: "Close the plan" }).click();
    await app.evaluate(() => void ((globalThis as Main).__pushes = 0));

    // A cough: speech with no words stays quiet in hands-free.
    await emit(app, { type: "vad", id: 1_000_004, speech: true });
    await emit(app, { type: "final", id: 1_000_004, text: "" });
    await sleep(150);
    assert.equal(await orb(win).getAttribute("data-state"), "listening");
    assert.equal(await win.getByText("Didn't hear anything").count(), 0);

    await win.keyboard.down("Alt");
    await win.keyboard.down("Space");
    await win.keyboard.up("Space");
    await win.keyboard.up("Alt");
    await waitFor("hands-free off", async () => (await cmds(app)).some((c) => c.cmd === "hands" && !c.on));
    assert.equal(await orb(win).getAttribute("data-hands"), "false");

    // A helper that never opens the mic: hands-free turns itself off and says why, instead of a lit orb listening to nothing.
    await win.getByRole("button", { name: "Hands-free: keep listening" }).click();
    await waitFor("the mic watchdog", async () => (await orb(win).getAttribute("data-hands")) === "false" && (await win.getByRole("alert").count()) > 0, 5000);
    await win.getByRole("alert").getByRole("button", { name: "Dismiss" }).click();

    // Settings: mode, key, languages, models; every theme keeps it readable (Abyss and Daylight shot).
    await win.getByRole("button", { name: "Voice settings" }).click();
    const settings = win.getByRole("dialog", { name: "Voice settings" });
    await settings.getByRole("radiogroup", { name: "Mode" }).waitFor();
    await shot(app, "settings", "vux");
    const configs = (await cmds(app)).filter((c) => c.cmd === "config").length;
    await settings.getByRole("button", { name: /Hindi/ }).click();
    await waitFor("the helper to hear the new languages", async () => (await cmds(app)).filter((c) => c.cmd === "config").length > configs);
    await win.keyboard.press("Escape");

    await win.getByRole("button", { name: "Appearance" }).click();
    await win.getByRole("radio", { name: "Daylight theme" }).click();
    await win.keyboard.press("Escape");
    await ptt(app, win, "sab files stage karo aur push kar do");
    await card.waitFor();
    await shot(app, "card-daylight", "vux");
    await win.getByRole("button", { name: "No", exact: true }).click();
    assert.equal(await app.evaluate(() => (globalThis as Main).__pushes), 0);
  } finally {
    await cleanup();
  }
});
