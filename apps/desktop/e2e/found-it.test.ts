// The Found it card in the built app with the recorded Claude stream (fake-claude.mjs): it stays up through a later run until
// Hide, and the fix card that asks for a click goes round an open sheet (K's History and Recipes stay clickable).
// Run `pnpm build` first (or SHRIKE_E2E_APP=<a build kept apart from out/>).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { fakeClaude, fixtureCopy, freePort, key, launch, mcpClient, shot, todoAskAgent, waitFor } from "./helpers.ts";

/** The button is what a click at its centre lands on. */
const clickable = (b: Locator) =>
  b.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });

const askAgain = async (win: Page, goal: string) => {
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press("Meta+k");
  const ask = win.getByRole("dialog", { name: "Ask your agent" });
  await ask.getByRole("textbox", { name: "Ask your agent" }).fill(goal);
  await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
};

test("found it: kept through a later run until Hide; the fix card stays clear of the Skills sheet's header", { timeout: 300_000 }, async () => {
  const [web, api] = [Number(process.env.SHRIKE_E2E_WEB) || (await freePort()), Number(process.env.SHRIKE_E2E_API) || (await freePort())];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const cc = fakeClaude(150);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env, FAKE_CLAUDE_FAIL: "^Say hello" });
  const found = win.getByRole("region", { name: "Found it" });
  let mcp: Awaited<ReturnType<typeof mcpClient>> | undefined;
  try {
    await todoAskAgent(app, win, web, "Why does Add Todo break?");
    await found.waitFor({ state: "visible", timeout: 60_000 });

    const runs = cc.calls().length;
    await askAgain(win, "Say hello");
    await waitFor("the later run to finish", () => cc.calls().length > runs && cc.finished(cc.calls().at(-1)!.session), 30_000);
    await win.waitForTimeout(800);
    assert.ok(await found.isVisible(), "Found it stays up through a later run");
    await found.getByRole("button", { name: "Hide" }).click();
    await found.waitFor({ state: "hidden" });

    // A fix waiting for your click sits over the stage; an open sheet's header stays clickable.
    mcp = await mcpClient(app);
    const proposed = mcp.call("propose_patch", { files: [{ path: "server/todos.controller.ts", edits: [{ oldText: "insertTodo({ title, userId: req.body.user });", newText: "insertTodo({ title, userId: req.body.userId });" }] }], rationale: "The page sends userId, so read userId." }).catch(() => {});
    await win.getByRole("region", { name: "Fix" }).waitFor({ state: "visible", timeout: 15_000 });
    await key(win, "k");
    const shelf = win.getByRole("region", { name: "Skills" });
    await shelf.waitFor();
    await win.waitForTimeout(600); // the sheet slides in, the card moves round it
    for (const name of ["History", "Recipes"]) assert.ok(await clickable(shelf.getByRole("button", { name, exact: true })), `${name} is not under the card`);
    await shot(app, "sheet", "found-it");
    await key(win, "Escape");
    await shelf.waitFor({ state: "detached" });
    await win.getByRole("region", { name: "Fix" }).getByRole("button", { name: "Not now" }).click();
    await proposed;
  } catch (err) {
    await shot(app, "failure", "found-it").catch(() => {});
    throw err;
  } finally {
    await mcp?.close().catch(() => {});
    await cleanup();
    cc.remove();
  }
});
