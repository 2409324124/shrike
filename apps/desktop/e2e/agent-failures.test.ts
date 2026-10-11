// Reliability (docs/09, area C): a Claude Code run that can't sign in ends at once with the reason and Try again on the agent pill,
// the process is stopped (not left retrying for minutes), and Try again runs the same ask through to Found it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeClaude, fixtureCopy, freePort, launch, shot, sleep, todoAskAgent, waitFor } from "./helpers.ts";

test("agent failure: sign-in refused ends with the reason and Try again, which works", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const cc = fakeClaude(150);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env, FAKE_CLAUDE_AUTH_FAIL_ONCE: "1" });
  const pill = win.locator('aside[aria-label="Agent"]');
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await todoAskAgent(app, win, web, "When I click Add Todo nothing shows up");
    const t0 = Date.now();
    const reason = pill.getByRole("alert");
    await reason.waitFor({ timeout: 30_000 });
    assert.match(await reason.innerText(), /Sign in to Claude Code again: open a terminal, run claude, and type \/login/);
    console.log(`failed state after ${Date.now() - t0}ms`);
    const run = (await win.evaluate(() => window.shrike.listRuns())).find((r) => !r.parentRunId)!;
    assert.equal(run.status, "failed");
    const pid = Number(readFileSync(join(cc.dir, "auth-failed"), "utf8"));
    await waitFor("the stuck Claude Code to be stopped", () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    await win.mouse.move(5, 500); // the reason stays on show without hovering
    await sleep(1500);
    assert.equal(await pill.evaluate((el) => getComputedStyle(el).opacity), "1");
    await shot(app, "agent-fail-signin", "rel");

    await pill.getByRole("button", { name: "Try again" }).click();
    await win.getByRole("region", { name: "Found it" }).waitFor({ timeout: 90_000 });
    assert.equal(cc.calls().filter((c) => c.kind === "main").length, 2);
    assert.equal(await pill.getByRole("alert").count(), 0);
    await shot(app, "agent-fail-retried", "rel");
  } finally {
    await cleanup();
    cc.remove();
  }
});
