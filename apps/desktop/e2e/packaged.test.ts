// Release smoke test against the PACKAGED app (docs/RELEASING.md): SHRIKE_PACKAGED_APP=/path/to/Shrike.app.
// Sample project, Run, the Add Todo bug, FOUND IT (recorded Claude stream), the voice helper hearing a WAV, the planner loading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { _electron } from "playwright";
import { addTodoAction, fakeClaude, freePort, questReady, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

const bundle = process.env.SHRIKE_PACKAGED_APP;
const models = process.env.SHRIKE_E2E_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models");
const voice = join(import.meta.dirname, "../../../fixtures/voice/audio");

function linkModels(userData: string): void {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const to = join(userData, "models", relative(models, p));
      if (statSync(p).isDirectory()) (mkdirSync(to, { recursive: true }), walk(p));
      else linkSync(p, to);
    }
  };
  mkdirSync(join(userData, "models"), { recursive: true });
  walk(models);
}

test("packaged app: sample, Run, Add Todo bug, FOUND IT, voice helper, planner", { skip: !bundle && "set SHRIKE_PACKAGED_APP", timeout: 600_000 }, async () => {
  const userData = mkdtempSync(join(tmpdir(), "shrike-packaged-"));
  const withModels = existsSync(join(models, "asr/ready"));
  if (withModels) linkModels(userData);
  // Free ports, so a dev app on 5173/3001 can't collide: the sample keeps a .shrike it finds in userData.
  const [web, api] = [await freePort(), await freePort()];
  mkdirSync(join(userData, "sample/todo-app/.shrike"), { recursive: true });
  writeFileSync(join(userData, "sample/todo-app/.shrike/config.json"), JSON.stringify({ devCommand: "npm run dev", appUrl: `http://localhost:${web}`, serverUrl: `http://localhost:${api}` }));
  const cc = fakeClaude(150);
  const env = { ...process.env, ...cc.env, SHRIKE_VOICE_ARGS: JSON.stringify(["--wav", ["en02.wav", "en01.wav"].map((f) => join(voice, f)).join("|")]) } as Record<string, string>;
  const app = await _electron.launch({ executablePath: join(bundle!, "Contents/MacOS/Shrike"), args: [`--user-data-dir=${userData}`], env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
    assert.ok(await app.evaluate(({ app }) => app.isPackaged), "running the packaged build");
    await win.getByRole("button", { name: "Open the sample project" }).click();
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    await shot(app, "01-running", "packaged");
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    await guest.getByText("Something went wrong").waitFor();
    const broken = await addTodoAction(win);
    assert.equal(broken.status, "error");

    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("When I click Add Todo nothing shows up");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    const found = win.getByRole("region", { name: "Found it" });
    await found.waitFor({ timeout: 120_000 });
    assert.match(await found.innerText(), /todos\.controller\.ts|req\.body\.user/);
    await shot(app, "02-found-it", "packaged");
    await win.keyboard.press("Escape");

    if (!withModels) return console.log(`skipped voice: no models in ${models}`);
    await win.evaluate(() => { const w = window as unknown as { __ev: string[]; shrike: { on(c: string, f: (e: { type: string; text?: string; message?: string }) => void): void } }; w.__ev = []; w.shrike.on("voice:event", (e) => e.type !== "level" && w.__ev.push(`${e.type}:${e.text ?? e.message ?? ""}`)); });
    await win.locator("body").click({ position: { x: 5, y: 600 } });
    for (const s of [1.05, 1.09]) {
      await win.keyboard.down("Alt");
      await win.keyboard.down("Space");
      await sleep(s * 1000 + 250);
      await win.keyboard.up("Space");
      await win.keyboard.up("Alt");
      await sleep(2500);
    }
    const ev = await waitFor("a final transcript from ShrikeVoice", async () => {
      const e = await win.evaluate(() => (window as unknown as { __ev: string[] }).__ev);
      return e.some((x) => /^final:\S/.test(x)) && e;
    }, 30_000);
    console.log(`voice events: ${ev.join(" | ")}`);
    assert.ok(!ev.some((x) => x.startsWith("error:")), "no voice errors");
    const warm = await win.evaluate(() => (window as unknown as { shrike: { voicePlanWarm(p: string): Promise<boolean> } }).shrike.voicePlanWarm("You turn spoken commands into JSON."));
    assert.ok(warm, "the planner (node-llama-cpp in a utilityProcess) loaded");
  } finally {
    await app.close().catch(() => {});
    cc.remove();
    rmSync(userData, { recursive: true, force: true });
  }
});
