// Voice end to end with real audio (docs/16, "Hearing"): the real ShrikeVoice helper plays fixture WAVs into its pipeline
// instead of the mic (SHRIKE_VOICE_ARGS --wav), through pre-roll, Silero, Nemotron and the token-checked socket, into the
// real renderer. No mic, no stand-in at the IPC boundary. Needs the helper built and the models (SHRIKE_E2E_MODELS, else
// the dev app's userData/models); they are hard-linked into the test's userData, so nothing is downloaded or copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { fixtureCopy, launch, openFolder, shot, sleep } from "./helpers.ts";

const repo = join(import.meta.dirname, "../../..");
const voice = join(repo, "fixtures/voice");
const models = process.env.SHRIKE_E2E_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models");
const helper = join(import.meta.dirname, "../native/voice/build/ShrikeVoice.app/Contents/MacOS/ShrikeVoice");
const skip = process.platform !== "darwin" ? "macOS only" : !existsSync(helper) ? "helper not built" : !existsSync(join(models, "asr/ready")) ? `no speech model in ${models}` : false;

/** Hard links: the test's userData gets the models without another 600 MB on disk. */
function linkModels(userData: string): void {
  for (const id of ["asr", "vad", "turn"]) {
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const to = join(userData, "models", relative(models, p));
        if (statSync(p).isDirectory()) (mkdirSync(to, { recursive: true }), walk(p));
        else linkSync(p, to);
      }
    };
    mkdirSync(join(userData, "models", id), { recursive: true });
    walk(join(models, id));
  }
}

type Main = typeof globalThis & { __pushes: number };
const pushes = (app: ElectronApplication) => app.evaluate(() => (globalThis as Main).__pushes);

/** Hold ⌥ Space while the helper plays the next WAV, let go when it ends; resolves with ms from keyup to the echo. */
async function say(win: Page, seconds: number, echo: RegExp | null): Promise<number> {
  await win.keyboard.down("Alt");
  await win.keyboard.down("Space");
  await sleep(seconds * 1000 + 250);
  const up = await win.evaluate(() => performance.now());
  await win.keyboard.up("Space");
  await win.keyboard.up("Alt");
  if (!echo) return 0;
  const at = await win.waitForFunction((re) => ([...document.querySelectorAll("[data-voice-echo]")].some((e) => new RegExp(re, "i").test(e.textContent ?? "")) ? performance.now() : 0), echo.source, { polling: "raf", timeout: 8000 });
  return (await at.jsonValue()) - up;
}

test("voice with real audio: Nemotron in the helper, push-to-talk to an action, a Hinglish card that waits, hands-free turns", { skip, timeout: 300_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  linkModels(userData);
  const clip = (f: string) => join(voice, f);
  const wavs = ["audio/en02.wav", "audio/en01.wav", "audio/hx11.wav", "audio/hx02.wav", "handsfree/pause-en5.wav"].map(clip);
  const proj = fixtureCopy("todo-app", { git: true });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_VOICE_ARGS: JSON.stringify(["--wav", wavs.join("|")]) }, userData);
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.locator('section[aria-label="Shrike"]').waitFor({ timeout: 60_000 });
    await app.evaluate(({ ipcMain }) => {
      (globalThis as Main).__pushes = 0;
      ipcMain.removeHandler("shrike:scmSync");
      ipcMain.handle("shrike:scmSync", () => {
        (globalThis as Main).__pushes++;
        throw new Error("e2e: nothing may push");
      });
    });
    await win.locator("body").click({ position: { x: 5, y: 600 } });
    await win.evaluate(() => { const w = window as unknown as { __ev: string[]; shrike: { on(c: string, f: (e: { type: string; id?: number; text?: string }) => void): void } }; w.__ev = []; w.shrike.on("voice:event", (e) => e.type !== "level" && w.__ev.push(`${e.type}:${e.id ?? ""}:${e.text ?? ""}`)); });

    // First press starts the helper and loads the models while it listens: "next step" still lands.
    await say(win, 1.05, null);
    await sleep(2500);
    assert.equal(await win.getByText("English only until the voice download finishes").count(), 0, "Nemotron, not the Apple fallback");
    await win.keyboard.press("Escape");

    // "show the logs": key up to the action on screen, measured with the real recognizer.
    const ms = await say(win, 1.09, /logs/i);
    await shot(app, "ptt-logs", "vasr");
    console.log(`release to "Showing logs" on screen: ${Math.round(ms)} ms (gate: simple command p50 250 ms)`);
    assert.ok(ms < 1000, `release to action took ${Math.round(ms)} ms`);
    await win.keyboard.press("Escape");

    // Hindi: "नेटवर्क रिक्वेस्ट दिखाओ" (Devanagari from Nemotron, shown in Roman script) opens Network.
    await say(win, 1.6, /network/i);
    await shot(app, "ptt-hindi-network", "vasr");
    await win.keyboard.press("Escape");

    // Hinglish stage-and-push: the plan card, the push marked as leaving the Mac, nothing pushed without a yes.
    await say(win, 2.6, null);
    const card = win.locator("[data-voice-plan]");
    await card.waitFor({ timeout: 10_000 });
    assert.equal(await card.getAttribute("data-state"), "needs_yes");
    await card.getByText("Leaves your Mac").waitFor();
    await shot(app, "ptt-hinglish-card", "vasr");
    await sleep(800);
    assert.equal(await pushes(app), 0, "nothing pushed without a yes");
    await win.getByRole("button", { name: "No", exact: true }).click();

    // Hands-free: "show the … network requests" with a 0.8 s pause inside stays one turn (Smart Turn vetoes the pause).
    await win.getByRole("button", { name: "Hands-free: keep listening" }).click();
    const heard = win.locator("[data-voice-heard]").getByText(/network requests/i).first();
    await heard.waitFor({ timeout: 20_000 });
    await sleep(1500); // the turn has ended (Smart Turn) and acted
    await shot(app, "hands-free-one-turn", "vasr");
    assert.equal(await win.locator("[data-voice-heard]").getByText(/^\W*(show|shall) the\W*$/i).count(), 0, "the pause did not cut the sentence");
    const handsFinals = await win.evaluate(() => (window as unknown as { __ev: string[] }).__ev.filter((e) => /^final:1\d{6}:\S/.test(e)));
    assert.equal(handsFinals.length, 1, `one hands-free turn: ${handsFinals.join(" / ")}`); // the model may drop the synthetic "show the" (chunk phase), never split it off
    assert.equal(await pushes(app), 0);
  } catch (e) {
    await shot(app, "fail", "vasr");
    console.log(await win.evaluate(() => (window as unknown as { __ev?: string[] }).__ev?.join("\n")).catch(() => ""));
    throw e;
  } finally {
    await cleanup();
    rmSync(userData, { recursive: true, force: true });
  }
});
