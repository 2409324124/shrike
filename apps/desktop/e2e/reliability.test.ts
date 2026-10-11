// Reliability (docs/09): quit paths, a force-killed Shrike, a second launch, main-process errors, a renderer crash, a flooding dev command.
// Run `pnpm build` first (or SHRIKE_E2E_APP). Uses ports 5173/3001.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import electronPath from "electron";
import { launch, listening, openSampleAndRun, shot, SHOTS, sleep, waitFor } from "./helpers.ts";

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (app: ElectronApplication) => new Promise<void>((r) => (app.process().exitCode !== null ? r() : app.process().once("exit", () => r())));

test("a force-killed Shrike leaves the app running; the next launch ends it", { timeout: 300_000 }, async () => {
  assert.equal(listening([5173, 3001]), "", "todo ports must be free");
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  const first = await launch({}, userData);
  let pids: number[] = [];
  try {
    await openSampleAndRun(first.app, first.win);
    pids = ((await first.win.evaluate(() => window.shrike.getRunStatus())).processes ?? []).map((p) => p.pid!).filter(Boolean);
    assert.ok(pids.length, "the run has processes");
    process.kill(first.app.process().pid!, "SIGKILL");
    await exited(first.app);
    await sleep(500);
    assert.ok(pids.some(groupAlive), "a SIGKILL gives Shrike no chance to stop the app: its process group outlives it");
    const second = await launch({}, userData);
    try {
      await waitFor("the left-behind app to be ended", () => !pids.some(groupAlive) && listening([5173, 3001]) === "", 15_000);
    } finally {
      await second.cleanup();
    }
  } finally {
    for (const p of pids) if (groupAlive(p)) process.kill(-p, "SIGKILL");
    rmSync(userData, { recursive: true, force: true });
  }
});

test("closing the window stops the app and every process under it", { timeout: 300_000 }, async () => {
  assert.equal(listening([5173, 3001]), "", "todo ports must be free");
  const { app, win, cleanup } = await launch();
  let pids: number[] = [];
  try {
    await openSampleAndRun(app, win);
    pids = ((await win.evaluate(() => window.shrike.getRunStatus())).processes ?? []).map((p) => p.pid!).filter(Boolean);
    const gone = exited(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.getParentWindow())!.close());
    await gone;
    await waitFor("every process group to end", () => !pids.some(groupAlive) && listening([5173, 3001]) === "", 10_000);
  } finally {
    for (const p of pids) if (groupAlive(p)) process.kill(-p, "SIGKILL");
    await cleanup();
  }
});

test("a second Shrike on the same data hands over to the first one", { timeout: 120_000 }, async () => {
  const { app, userData, cleanup } = await launch();
  try {
    const t = Date.now();
    // It quits before it opens a window, so Playwright's launch gives up on it.
    const second = await _electron.launch({ executablePath: electronPath as unknown as string, args: [".", `--user-data-dir=${userData}`], cwd: process.env.SHRIKE_E2E_APP ?? join(import.meta.dirname, ".."), env: process.env as Record<string, string> }).catch(() => undefined);
    if (second) await Promise.race([exited(second), sleep(15_000).then(() => assert.fail("the second launch kept running"))]);
    assert.ok(Date.now() - t < 15_000);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, "the first one still has its window");
  } finally {
    await cleanup();
  }
});

test("an error thrown in main is logged and Shrike keeps running, with no error dialog", { timeout: 60_000 }, async () => {
  // Playwright's own session trips over a main-process exception, so this launch is plain: a --require'd file throws once main is up.
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  const probe = join(userData, "probe.cjs");
  writeFileSync(probe, `if (process.type === "browser") setTimeout(() => { Promise.reject(new Error("probe rejection")); throw new Error("probe uncaught"); }, 2000);`);
  const child = spawn(electronPath as unknown as string, [".", `--user-data-dir=${userData}`], { cwd: process.env.SHRIKE_E2E_APP ?? join(import.meta.dirname, ".."), env: { ...process.env, SHRIKE_HEADLESS: "1", NODE_OPTIONS: `--require ${probe}` }, stdio: "ignore" });
  try {
    const log = join(userData, "logs", "main.log");
    const text = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    await waitFor("both errors in main.log", () => /probe uncaught/.test(text()) && /probe rejection/.test(text()), 20_000);
    await sleep(1000);
    assert.equal(child.exitCode, null, "Shrike is still running");
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a crashed window loads again", { timeout: 60_000 }, async () => {
  // Playwright loses its page when the renderer dies, so a --require'd file crashes the window after its first load and records each load.
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  const probe = join(userData, "probe.cjs");
  const loads = join(userData, "loads.txt");
  const png = join(SHOTS, "reliability-after-renderer-crash.png");
  writeFileSync(
    probe,
    `if (process.type === "browser") setImmediate(() => require("electron").app.on("web-contents-created", (_e, wc) => {
      if (wc.getType() !== "window" || globalThis.probed) return;
      globalThis.probed = true;
      let n = 0;
      wc.on("did-finish-load", () => {
        require("fs").appendFileSync(${JSON.stringify(loads)}, "load " + ++n + "\\n");
        if (n === 1) setTimeout(() => wc.forcefullyCrashRenderer(), 1000);
        else setTimeout(() => wc.capturePage().then((i) => require("fs").writeFileSync(${JSON.stringify(png)}, i.toPNG())), 1500);
      });
    }));`, // electron is requirable only once main has started
  );
  const child = spawn(electronPath as unknown as string, [".", `--user-data-dir=${userData}`], { cwd: process.env.SHRIKE_E2E_APP ?? join(import.meta.dirname, ".."), env: { ...process.env, SHRIKE_HEADLESS: "1", NODE_OPTIONS: `--require ${probe}` }, stdio: "ignore" });
  try {
    await waitFor("the window to load a second time", () => existsSync(loads) && readFileSync(loads, "utf8").includes("load 2"), 20_000);
    assert.match(readFileSync(join(userData, "logs", "main.log"), "utf8"), /window crashed/);
    await waitFor("a screenshot of the reloaded window", () => existsSync(png), 10_000);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once("exit", r));
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("a dev command that floods its output keeps the window responsive", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-e2e-flood-"));
  mkdirSync(join(root, ".shrike"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "flood", scripts: { dev: "yes 'a long line of output a flooding dev command prints over and over'" } }));
  writeFileSync(join(root, ".shrike", "config.json"), JSON.stringify({ processes: [{ name: "app", command: "yes 'a long line of output a flooding dev command prints over and over'" }] }));
  const { app, win, cleanup } = await launch();
  try {
    await win.evaluate((r) => window.shrike.openProject(r), root);
    await win.evaluate(() => window.shrike.run());
    await waitFor("the flood to run", async () => (await win.evaluate(() => window.shrike.getRunStatus())).state === "running", 15_000);
    // While it floods: how late the renderer's timers fire, how many output messages arrive, and how long a round trip to main takes.
    const { lag, chunks, skipped } = await win.evaluate(() => new Promise<{ lag: number; chunks: number; skipped: boolean }>((done) => {
      let chunks = 0;
      let skipped = false;
      const off = window.shrike.on("run:output", (c) => ((chunks += 1), (skipped ||= String(c).includes("[shrike] Skipped"))));
      let max = 0;
      let last = performance.now();
      const t0 = last;
      const iv = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last - 50);
        last = now;
        if (now - t0 > 3000) (clearInterval(iv), off(), done({ lag: max, chunks, skipped }));
      }, 50);
    }));
    const t = Date.now();
    await win.evaluate(() => window.shrike.getRunStatus());
    const ipc = Date.now() - t;
    console.log(`flood: renderer timer lag ${Math.round(lag)} ms, ${chunks} output messages in 3 s, ipc round trip ${ipc} ms`);
    await shot(app, "flood", "reliability");
    assert.ok(lag < 500, `renderer timers ran ${Math.round(lag)} ms late`);
    assert.ok(ipc < 500, `a round trip to main took ${ipc} ms`);
    assert.ok(chunks <= 80, `${chunks} output messages in 3 s`);
    assert.ok(skipped, "the terminal says output was skipped");
    await win.evaluate(() => window.shrike.stop());
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
