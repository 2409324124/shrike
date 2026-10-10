// The agent surface on a real Claude Code run (A1 plan, A4 skill, A5 memory, A6 checkpoints, A7 usage, A11 watched-by, A13 diff comments, O2 cursor, O9 unread).
// Uses the user's subscription, so it only runs with SHRIKE_E2E_AGENT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { actions, addTodoAction, flatten, launch, openSampleAndRun, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

const fixtureController = join(import.meta.dirname, "../../../fixtures/todo-app/server/todos.controller.ts");
const SHOT = "v5-agent";
const BUG = "userId: req.body.user })";

/** A minimal external MCP client (as Cursor would be): initialize with a name, then one tool call. */
async function externalCall(url: string, token: string, client: string, name: string, args: Record<string, unknown>) {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  const post = (body: unknown, sid?: string) => fetch(url, { method: "POST", headers: sid ? { ...h, "mcp-session-id": sid } : h, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } } });
  const sid = init.headers.get("mcp-session-id") ?? undefined;
  await init.text();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).text();
  return (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, sid)).text();
}

test("agent surface: plan route, skill chip, usage ring, ghost cursor, pinned note, diff comment revision, checkpoint rewind and re-apply, watched-by, unread", { skip: process.env.SHRIKE_E2E_AGENT !== "1", timeout: 1_500_000 }, async () => {
  const original = readFileSync(fixtureController);
  const { app, win, userData: ud, cleanup } = await launch();
  const controller = join(ud, "sample/todo-app/server/todos.controller.ts"); // the sample opens as a copy in userData
  const memoryFile = join(ud, "sample/todo-app/.shrike/memory.md");
  rmSync(memoryFile, { force: true });
  const seen: Record<string, boolean> = {};
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    const guest = await openSampleAndRun(app, win);
    // The D12 setup sheet may open on first load; it covers the stage.
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 3000 }).catch(() => false)) await closeSetup.click();
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broken = await addTodoAction(win);
    assert.equal(broken.status, "error");

    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill(
      "When I click Add Todo nothing shows up. Click Add Todo in the app yourself once to see it happen. Save one note with remember about the rule you find.",
    );
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    await ask.waitFor({ state: "detached" });

    // Watch for the short-lived pieces while the run goes on.
    const surface = async (p: Page) => {
      if (await closeSetup.isVisible().catch(() => false)) await closeSetup.click().catch(() => {});
      if (await p.locator(".th-dive").count()) {
        await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await p.keyboard.press("Escape");
      }
      await p.getByRole("complementary", { name: "Agent" }).hover({ timeout: 1000 }).catch(() => {});
    };
    const poll = async (p: Page) => {
      if (!seen.route && (await p.locator(".td-route").count())) {
        seen.route = true;
        await surface(p);
        await sleep(600);
        await shot(app, "01-plan-route", SHOT);
      }
      if (!seen.skill && (await p.locator(".skill-chip.on").count())) {
        seen.skill = true;
        await surface(p);
        await sleep(300);
        await shot(app, "02-skill-chip", SHOT);
      }
      if (!seen.cursor && (await p.locator(".agent-cursor").count())) {
        seen.cursor = true;
        await sleep(300);
        await shot(app, "03-ghost-cursor", SHOT);
      }
      if (!seen.ring) {
        const fuel = Number((await p.locator(".fuel-ring").first().getAttribute("data-fuel", { timeout: 200 }).catch(() => null)) ?? 0);
        if (fuel > 0) {
          seen.ring = true;
          console.log(`fuel ring: ${fuel} · ${await p.locator(".fuel-ring").first().getAttribute("title")}`);
          await sleep(700); // the ring animates in
          await shot(app, "02b-fuel-ring", SHOT);
        }
      }
      if (!seen.pin && (await p.locator(".td-pin").count())) {
        seen.pin = true;
        await surface(p);
        await p.locator(".td-pin").first().hover().catch(() => {});
        await sleep(300);
        await shot(app, "04-memory-pin", SHOT);
      }
    };

    // A13: comment on the first proposed diff and send it back.
    const fix = win.getByRole("region", { name: /^(Found it|Fix)$/ });
    const apply = fix.getByRole("button", { name: /^Apply/ });
    const request = win.getByRole("region", { name: "Agent request" });
    await waitFor("the first proposed fix", async () => {
      await poll(win);
      if (await request.isVisible().catch(() => false)) await request.getByRole("button", { name: /^Allow/ }).click().catch(() => {});
      return apply.isVisible().catch(() => false);
    }, 600_000);
    if (await closeSetup.isVisible().catch(() => false)) await closeSetup.click();
    const firstDiff = await fix.locator(".diff").innerText();
    console.log(`first diff:\n${firstDiff}`);
    await fix.locator(".diff [role=button]").filter({ hasText: "userId" }).last().click();
    await fix.getByRole("textbox", { name: /Your comment on line/ }).fill("Also wrap it in Number() so the saved userId is always a number");
    await fix.getByRole("textbox", { name: /Your comment on line/ }).press("Enter");
    await sleep(300);
    await shot(app, "05-diff-comment", SHOT);
    await fix.getByRole("button", { name: "Send to agent" }).click();
    await waitFor("the first fix to be withdrawn", async () => !(await apply.isVisible().catch(() => false)), 30_000);

    const revised = await waitFor("a revised fix that uses Number()", async () => {
      await poll(win);
      if (await request.isVisible().catch(() => false)) await request.getByRole("button", { name: /^Allow/ }).click().catch(() => {});
      if (!(await apply.isVisible().catch(() => false))) return false;
      const t = await fix.locator(".diff").innerText();
      return /Number\(/.test(t) ? t : false;
    }, 600_000);
    console.log(`revised diff:\n${revised}`);
    await sleep(500);
    await shot(app, "06-revised-diff", SHOT);
    await apply.click();

    // A6: the applied fix is a checkpoint.
    const diamond = win.locator(".checkpoint-rail button").first();
    await waitFor("a checkpoint diamond", async () => (await diamond.getAttribute("data-current")) === "true", 60_000);
    assert.match(readFileSync(controller, "utf8"), /Number\(req\.body\.userId\)/);
    await waitFor("the run to finish", async () => {
      await poll(win);
      if (await request.isVisible().catch(() => false)) await request.getByRole("button", { name: /^Allow/ }).click().catch(() => {});
      return /Agent (done|failed|stopped)/i.test(await win.getByRole("complementary", { name: "Agent" }).innerText().catch(() => ""));
    }, 400_000).catch((e) => console.log(`run did not finish: ${(e as Error).message}`));
    await sleep(800);
    await shot(app, "07-applied-checkpoint", SHOT);

    // Rewind restores the bug; Apply again puts the fix back.
    await diamond.click();
    const card = win.getByRole("region", { name: "Checkpoint" });
    await card.waitFor();
    await sleep(600);
    await shot(app, "08-checkpoint-card", SHOT);
    await card.getByRole("button", { name: /^Rewind/ }).click();
    await waitFor("the bug back in the file", () => readFileSync(controller, "utf8").includes(BUG), 20_000);
    await waitFor("the diamond hollow", async () => (await diamond.getAttribute("data-current")) === "false", 10_000);
    await sleep(500);
    await shot(app, "09-rewound", SHOT);
    await card.getByRole("button", { name: "Apply again" }).click();
    await waitFor("the fix back in the file", () => /Number\(req\.body\.userId\)/.test(readFileSync(controller, "utf8")), 20_000);
    await waitFor("the diamond filled", async () => (await diamond.getAttribute("data-current")) === "true", 10_000);
    await waitFor("the server restart to finish", () => card.getByRole("button", { name: /^Rewind/ }).isEnabled(), 15_000);
    await card.getByRole("button", { name: "Close" }).click();

    // After apply-again the server restarted: Add Todo works.
    const before = Math.max(...(await actions(win)).map((x) => x.startMs));
    await typeTodo(guest, "buy eggs");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const fixed = await addTodoAction(win, before);
    if (fixed.status === "error") console.log(`after apply-again: ${JSON.stringify(flatten(fixed.tree).map((e) => [e.kind, e.name, e.http?.status, e.error?.message ?? e.log?.message]))}\nfile: ${readFileSync(controller, "utf8").split("\n")[17]}`);
    assert.notEqual(fixed.status, "error");

    // A11: an outside MCP client reads the latest trip; its eye shows on that trip.
    const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
    const cfg = JSON.parse(readFileSync(join(userData, "mcp.json"), "utf8")) as { mcpServers: { shrike: { url: string; headers: { Authorization: string } } } };
    const { url, headers } = cfg.mcpServers.shrike;
    const out = await externalCall(url, headers.Authorization.replace(/^Bearer /, ""), "Cursor", "get_action", { actionId: fixed.id });
    assert.match(out, /Clicked/);
    await win.locator(`.th-trip[data-trip="${fixed.id}"] .td-watch`).filter({ hasText: "Cursor" }).waitFor({ timeout: 10_000 });

    // O9: a trip that lands while Shrike is in the background is unread until you look at it.
    // Another window takes focus, as if you switched apps.
    await app.evaluate(({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 200, height: 200, x: 0, y: 0, show: true });
      other.focus();
      (globalThis as unknown as { __other: typeof other }).__other = other;
    });
    await waitFor("the window to lose focus", () => win.evaluate(() => !document.hasFocus()), 5000).catch(() => console.log("blur didn't take; skipping unread check"));
    if (!(await win.evaluate(() => document.hasFocus()))) {
      await externalCall(url, headers.Authorization.replace(/^Bearer /, ""), "Cursor", "send_request", { method: "GET", url: "/api/todos" });
      await win.locator(".td-unread").first().waitFor({ timeout: 10_000 });
      seen.unread = true;
    }
    await app.evaluate(({ BrowserWindow }) => {
      (globalThis as unknown as { __other?: InstanceType<typeof BrowserWindow> }).__other?.destroy();
      BrowserWindow.getAllWindows()[0]!.focus();
    });
    await win.locator(`.th-trip[data-trip="${fixed.id}"] .th-head`).scrollIntoViewIfNeeded();
    await sleep(800);
    await shot(app, "10-watched-unread", SHOT);

    // The note is in .shrike/memory.md, human-readable, and pinned in the file view on its line.
    const md = readFileSync(memoryFile, "utf8");
    console.log(`memory.md:\n${md}`);
    assert.match(md, /^- .+<!-- id:\w+ by:agent at:\d+ -->$/m);
    const pinned = /\(([\w/.-]+):(\d+)\)\s*<!--/.exec(md) ?? /([\w/.-]+\.ts):(\d+)/.exec(md);
    if (pinned) {
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await win.keyboard.press("Meta+p");
      await win.getByRole("dialog", { name: "Quick open" }).getByRole("combobox").pressSequentially(pinned[1]!);
      await sleep(300);
      await win.keyboard.press("Enter");
      const note = win.locator(`.fv [data-ln="${pinned[2]}"] .fv-note`);
      await note.waitFor({ timeout: 5000 });
      await note.scrollIntoViewIfNeeded();
      seen.filePin = true;
      await sleep(400);
      await shot(app, "11-file-view-pin", SHOT);
      await win.keyboard.press("Escape");
    }
    console.log(`seen: ${JSON.stringify(seen)}`);
    console.log(`--- agent ---\n${await win.getByRole("complementary", { name: "Agent" }).innerText().catch(() => "")}`);
    for (const k of ["route", "skill", "cursor", "pin", "ring"]) assert.ok(seen[k], `saw ${k}`);
  } catch (err) {
    await shot(app, "failure", SHOT).catch(() => {});
    console.log(`seen: ${JSON.stringify(seen)}`);
    throw err;
  } finally {
    await cleanup();
    assert.ok(readFileSync(fixtureController).equals(original), "the repo's fixture is never edited");
  }
});
