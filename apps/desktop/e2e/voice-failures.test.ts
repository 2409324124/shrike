// Voice when its parts fail (area C reliability): a planner model that won't load, a helper that dies in hands-free,
// and a mic that's denied mid-session. The helper is stood in for at main's voiceSend; the planner is the real utilityProcess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import type { VoiceCommand, VoiceEvent } from "@shrike/schema";
import { PLANNER_MODEL } from "../src/main/voice-planner-model.ts";
import { fixtureCopy, launch, openFolder, shot as snap, sleep, waitFor } from "./helpers.ts";

type Main = typeof globalThis & { __cmds: VoiceCommand[]; __emit(e: VoiceEvent): void };
const shot = async (app: ElectronApplication, name: string) => (await sleep(150), snap(app, name, "voice-fail"));

async function fakeHelper(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as Main;
    g.__cmds = [];
    g.__emit = (e) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow())!.webContents.send("shrike:event:voice:event", e);
    ipcMain.removeHandler("shrike:voiceSend");
    ipcMain.handle("shrike:voiceSend", (_e, cmd: VoiceCommand) => void g.__cmds.push(cmd));
  });
}

const cmds = (app: ElectronApplication) => app.evaluate(() => (globalThis as Main).__cmds);
const emit = (app: ElectronApplication, e: VoiceEvent) => app.evaluate((_, e) => (globalThis as Main).__emit(e), e);
const orb = (win: Page) => win.locator("[data-voice-orb] .v-orb");
const echo = (win: Page) => win.locator("[data-voice-caption]").innerText().catch(() => "");
const alertText = (win: Page) => win.getByRole("alert").allInnerTexts().then((t) => t.join(" | "));
const dismiss = (win: Page) => win.getByRole("alert").getByRole("button", { name: "Dismiss" }).click({ timeout: 2000 }).catch(() => {});

async function ptt(app: ElectronApplication, win: Page, text: string): Promise<void> {
  const before = (await cmds(app)).filter((c) => c.cmd === "start").length;
  await win.keyboard.down("Alt");
  await win.keyboard.down("Space");
  const id = await waitFor("a start", async () => {
    const s = (await cmds(app)).filter((c) => c.cmd === "start") as { id: number }[];
    return s.length > before ? s.at(-1)!.id : undefined;
  });
  await emit(app, { type: "vad", id, speech: true });
  await emit(app, { type: "partial", id, text });
  await win.keyboard.up("Space");
  await win.keyboard.up("Alt");
  await sleep(140);
  await emit(app, { type: "final", id, text });
}

async function handsOn(app: ElectronApplication, win: Page): Promise<void> {
  await win.getByRole("button", { name: "Hands-free: keep listening" }).click();
  await emit(app, { type: "level", value: 0.05 }); // the mic is open: the watchdog stays quiet
  await waitFor("hands-free on", async () => (await orb(win).getAttribute("data-hands")) === "true");
}

test("voice failures: a broken planner model, a helper that dies, a denied mic; voice says why and the app carries on", { timeout: 180_000, skip: process.platform !== "darwin" ? "voice is macOS only" : false }, async () => {
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  mkdirSync(join(userData, "models"), { recursive: true });
  const fd = openSync(join(userData, "models", PLANNER_MODEL.file), "w"); // right size and magic, zeros after: the real worker's node-llama-cpp rejects it
  writeSync(fd, "GGUF");
  ftruncateSync(fd, PLANNER_MODEL.bytes);
  closeSync(fd);
  const proj = fixtureCopy("todo-app", { git: true });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj }, userData);
  const fails: string[] = []; // every case runs, then all failures are reported together
  const check = (ok: boolean, what: string) => void (ok || fails.push(what));
  try {
    await openFolder(win);
    await win.locator('section[aria-label="Shrike"]').waitFor({ timeout: 60_000 });
    await fakeHelper(app);
    await win.locator("body").click({ position: { x: 5, y: 600 } });

    // 1. Words only the planner understands, with a model that won't load.
    const t = Date.now();
    await ptt(app, win, "what did the server print");
    await win.getByRole("button", { name: "Not now" }).click({ timeout: 3000 }).catch(() => {}); // the speech model download card
    await waitFor("an answer", async () => /catch|took/i.test(await echo(win)), 40_000);
    await sleep(1500);
    console.log(`planner turn 1 (${Date.now() - t} ms): echo=${JSON.stringify(await echo(win))} alert=${JSON.stringify(await alertText(win))}`);
    await shot(app, "planner-broken");
    check(/command model/i.test(await alertText(win)), "says why the planner can't help");
    const t2 = Date.now();
    await ptt(app, win, "what did the server print");
    await waitFor("a second answer", async () => /catch/i.test(await echo(win)), 40_000).catch(() => {});
    console.log(`planner turn 2: ${Date.now() - t2} ms`);
    check(Date.now() - t2 < 3000, "a broken model isn't reloaded on every turn");
    await dismiss(win);

    // Grammar commands still work without the planner.
    await ptt(app, win, "show logs");
    await waitFor("logs shown", async () => /logs/i.test(await echo(win)), 5000);

    // 2. Hands-free, then the helper dies and can't come back.
    await handsOn(app, win);
    await emit(app, { type: "error", message: "Voice stopped. Hold ⌥ Space to start it again." });
    await sleep(400);
    const hands = await orb(win).getAttribute("data-hands");
    console.log(`after helper death in hands-free: data-hands=${hands} state=${await orb(win).getAttribute("data-state")} alert=${JSON.stringify(await alertText(win))}`);
    await shot(app, "helper-died");
    check(hands === "false", "hands-free turns off with the helper");
    await dismiss(win);
    if (hands === "true") await win.getByRole("button", { name: "Turn hands-free off" }).click(); // before the fix: turn it off by hand

    // 3. The mic permission goes away mid hands-free.
    await handsOn(app, win);
    await emit(app, { type: "permission", speech: "granted", mic: "denied" });
    await sleep(400);
    const hands2 = await orb(win).getAttribute("data-hands");
    console.log(`after mic denied in hands-free: data-hands=${hands2} alert=${JSON.stringify(await alertText(win))}`);
    await shot(app, "mic-denied");
    check(hands2 === "false", "hands-free turns off when the mic is denied");
    check(/microphone/.test(await alertText(win)), "says the mic is denied");
    check((await win.getByRole("alert").getByRole("button", { name: /Open Privacy settings/ }).count()) === 1, "offers Privacy settings");

    // The rest of the app is unaffected.
    await win.locator('section[aria-label="Shrike"]').waitFor();
    assert.deepEqual(fails, []);
  } finally {
    await cleanup();
    rmSync(userData, { recursive: true, force: true });
  }
});
