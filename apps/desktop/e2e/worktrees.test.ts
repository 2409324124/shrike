// W1–W5 in the built app on a throwaway git copy of shop-app (its ports moved to a random free block):
// two worktrees run side by side on offset ports, tabs switch trips, a proposed fix is tried in a sandbox and brought
// over. With SHRIKE_E2E_AGENT=1 a real two-way fix race runs with Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ActionView, ProjectInfo, Race, RunStatus, Worktree } from "@shrike/schema";
import { fixtureCopy, gitIn, launch, listening, mcpClient, shot, sleep, waitFor } from "./helpers.ts";

const BUG = "chargeCard({ amount: cart.total, currency";
const FIX = "chargeCard({ amount: Math.round(cart.total * 100), currency";
const PAY = 'Clicked "Pay now"';

const call = <T,>(win: Page, fn: string, ...args: unknown[]) => win.evaluate(([f, a]) => (window.shrike as any)[f](...a), [fn, args] as const) as Promise<T>;
const trees = (win: Page) => call<Worktree[]>(win, "listWorktrees");
const acts = (win: Page) => call<ActionView[]>(win, "getActions");
const firstError = (v: ActionView): string => JSON.stringify(JSON.stringify(v.tree).match(/"status":(4|5)\d\d[^}]{0,200}/)?.[0] ?? "");

/** A block of 4 ports, free along with its +100..+400 worktree shifts. */
function freeBlock(): number[] {
  for (let i = 0; i < 50; i++) {
    const b = 20000 + Math.floor(Math.random() * 2000) * 10;
    const all = [0, 100, 200, 300, 400].flatMap((o) => [b, b + 1, b + 2, b + 3].map((p) => p + o));
    if (!listening(all)) return [b, b + 1, b + 2, b + 3];
  }
  throw new Error("no free port block");
}

test("worktrees: two side by side on offset ports, tabs switch trips, sandbox fix brought over", { timeout: 1_500_000 }, async () => {
  const [web, api, auth, pay] = freeBlock();
  const proj = fixtureCopy("shop-app", { ports: { 5180: web!, 4100: api!, 4101: auth!, 4199: pay! }, git: true });
  const head = gitIn(proj, "rev-parse", "HEAD");
  const ports = (o: number) => [web!, api!, auth!, pay!].map((p) => p + o);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("dialog", { name: "Set up shop-app" }).getByRole("button", { name: "Run all" }).click();
    await waitFor("main running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 120_000);
    const guest = await waitFor("the shop page", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 60_000);
    await guest.getByRole("button", { name: "Pay now" }).click();
    await guest.getByText("Payment failed").waitFor({ timeout: 20_000 });
    const mainPay = await waitFor("main's Pay now trip", async () => (await acts(win)).find((a) => a.label === PAY && a.complete), 20_000);
    assert.equal(mainPay.status, "error");

    // WS2 makes try-a (from your code as it is now); WS1 switches to it; W2: it runs on +100 while main keeps running.
    const tabs = win.getByRole("navigation", { name: "Workspaces" });
    await tabs.getByRole("button", { name: /New workspace/ }).click();
    const dlg = win.getByRole("dialog", { name: "New workspace" });
    await dlg.getByRole("tab", { name: "New name" }).click();
    await dlg.getByRole("textbox", { name: "Workspace name" }).fill("try-a");
    await dlg.getByText("Advanced").click();
    await dlg.getByText("Run the app with its run skill").click();
    await dlg.getByRole("button", { name: /Create workspace/ }).click();
    await waitFor("switched to try-a", async () => (await call<ProjectInfo>(win, "getProject")).root.endsWith("/.shrike/worktrees/try-a"), 30_000);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    const both = await waitFor("both running", async () => {
      const l = await trees(win);
      return l.length === 2 && l.every((w) => w.running) && l;
    }, 120_000);
    assert.deepEqual(both.map((w) => [w.name, w.portOffset]).sort(), [["main", 0], ["try-a", 100]].sort());
    const hdr = { authorization: "Bearer demo-token" };
    const cart = (port: number) => fetch(`http://localhost:${port}/api/cart`, { headers: hdr }).then((r) => r.status === 200, () => false);
    await waitFor("main answers on its ports", () => cart(web!), 90_000); // main restarts in the background after the switch
    await waitFor("try-a answers on +100", () => cart(web! + 100), 90_000);
    const g2 = await waitFor("try-a's page", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web! + 100}`)), 60_000);
    await g2.getByRole("button", { name: "Pay now" }).click({ timeout: 30_000 });
    await g2.getByText("Payment failed").waitFor({ timeout: 20_000 });
    const aPay = await waitFor("try-a's own Pay now trip", async () => (await acts(win)).find((a) => a.label === PAY && a.complete && a.id !== mainPay.id), 20_000);
    assert.ok(!(await acts(win)).some((a) => a.id === mainPay.id), "main's trips are not in try-a's tab");
    await sleep(1200);
    await shot(app, "wt-01-try-a-side-by-side", "v5");

    // Tabs switch trips: main's come back; try-a keeps running in the background.
    await tabs.getByRole("button", { name: /^main/ }).click();
    await waitFor("main's trips back", async () => {
      const a = await acts(win);
      return a.some((x) => x.id === mainPay.id) && !a.some((x) => x.id === aPay.id);
    }, 30_000);
    await waitFor("main running", async () => (await call<RunStatus>(win, "getRunStatus")).state === "running", 120_000);
    assert.ok((await trees(win)).find((w) => w.name === "try-a")?.running, "try-a still running");
    await sleep(1200);
    await shot(app, "wt-02-back-on-main", "v5");

    // W5: try-a has no changes, so removing it doesn't ask.
    await tabs.getByRole("button", { name: "More for try-a" }).click({ force: true });
    await win.getByRole("menuitem", { name: "Delete workspace" }).click();
    await waitFor("try-a removed", async () => !(await trees(win)).some((w) => w.name === "try-a"), 60_000);
    await waitFor("try-a's ports freed", () => listening(ports(100)) === "", 30_000);

    // W4: an outside agent proposes the fix; "Try in a sandbox first" re-runs Pay now in a copy; Bring it over applies it.
    const mcp = await mcpClient(app);
    const proposed = mcp.call("propose_patch", { files: [{ path: "services/api/index.ts", edits: [{ oldText: BUG, newText: FIX }] }], rationale: "Stripe wants whole cents." });
    await win.getByRole("button", { name: "Try in a sandbox first" }).click({ timeout: 30_000 });
    assert.match(await proposed, /rejected/, "the waiting patch steps aside for the sandbox");
    await mcp.close();
    const view = win.getByRole("region", { name: "Sandbox fix" });
    await view.waitFor({ timeout: 60_000 });
    const sandbox = await waitFor("the sandbox re-run to settle", async () => {
      const labels = await view.locator("section[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
      return labels.length > 0 && labels.every((l) => /Worked|Still broken|Didn't finish/.test(l)) && labels;
    }, 300_000);
    assert.match(sandbox[0]!, /Worked/);
    assert.ok(readFileSync(join(proj, "services/api/index.ts"), "utf8").includes(BUG), "your checkout is untouched until you bring it over");
    await sleep(800);
    await shot(app, "wt-03-sandbox-worked", "v5");
    await view.getByRole("button", { name: "Bring it over" }).click();
    await win.getByRole("button", { name: /Apply fix/ }).click({ timeout: 20_000 });
    await waitFor("the fix in your checkout", () => readFileSync(join(proj, "services/api/index.ts"), "utf8").includes(FIX), 20_000);
    assert.equal(gitIn(proj, "rev-parse", "HEAD"), head, "nothing committed");
    assert.equal(gitIn(proj, "diff", "--name-only"), "services/api/index.ts");
    await sleep(800);
    await shot(app, "wt-04-brought-over", "v5");
    await view.getByRole("button", { name: "Clean up" }).click({ timeout: 20_000 });
    const ask = win.getByRole("button", { name: /^Allow/ });
    if (await ask.waitFor({ timeout: 5000 }).then(() => true, () => false)) await ask.click();
    await waitFor("sandbox worktree gone", async () => (await trees(win)).length === 1, 60_000);

    // W3: a real race with Claude Code, two approaches on the broken trip.
    if (process.env.SHRIKE_E2E_AGENT === "1") {
      gitIn(proj, "checkout", "--", "services/api/index.ts"); // the bug back
      await sleep(2500);
      await waitFor("Pay now clicked on main's page", async () => {
        const page = app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)); // the pane is replaced on tab switches
        return page && (await page.getByRole("button", { name: "Pay now" }).click({ timeout: 3000 }).then(() => true));
      }, 30_000);
      const broken = await waitFor("a fresh broken Pay now", async () => (await acts(win)).filter((a) => a.label === PAY && a.complete && a.status === "error").at(-1), 20_000);
      await win.evaluate(() => window.shrike.on("race:update", (r) => ((window as any).__race = r)));
      const raced = call<Race>(win, "startRace", broken.id, 2);
      await ask.click({ timeout: 20_000 });
      const race = win.getByRole("region", { name: "Fix race" });
      await race.waitFor({ timeout: 60_000 });
      await sleep(15_000);
      await shot(app, "wt-05-race-running", "v5");
      const states = await waitFor("the race to finish", async () => {
        const labels = await race.locator("section[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
        return labels.length === 2 && labels.every((l) => /Worked|Still broken|Didn't finish/.test(l)) && labels;
      }, 15 * 60_000);
      console.log("race:", states.join(" | "), (await raced).id);
      const final = (await win.evaluate(() => (window as any).__race)) as Race;
      for (const c of final.candidates) console.log("candidate:", c.worktree, c.state, c.summary, c.files, c.rerun ? `${c.rerun.label} ${c.rerun.status} ${firstError(c.rerun)}` : "no re-run");
      await sleep(800);
      await shot(app, "wt-06-race-done", "v5");
      assert.ok(states.some((s) => /Worked/.test(s)), "at least one approach worked");
      const winner = race.locator('section[aria-label$=": Worked"]').first();
      await winner.getByRole("button", { name: "Use this fix" }).click();
      await win.getByRole("button", { name: /Apply fix/ }).click({ timeout: 20_000 });
      await waitFor("the winning fix in your checkout", () => gitIn(proj, "diff", "--name-only") !== "", 20_000);
      console.log("adopted:", gitIn(proj, "diff", "--stat"));
      await sleep(800);
      await shot(app, "wt-07-race-adopted", "v5");
      await race.getByRole("button", { name: "Clean up" }).click({ timeout: 20_000 });
      if (await ask.waitFor({ timeout: 5000 }).then(() => true, () => false)) await ask.click();
      await waitFor("race worktrees gone", async () => (await trees(win)).length === 1, 60_000);
    }
    await call(win, "stop");
  } finally {
    await cleanup();
  }
  assert.equal(gitIn(proj, "worktree", "list").split("\n").length, 1, "no worktrees left");
  assert.equal(gitIn(proj, "branch", "--list", "shrike/*"), "", "no worktree branches left");
  assert.equal(listening([0, 100, 200, 300, 400].flatMap(ports)), "", "every port free");
});
