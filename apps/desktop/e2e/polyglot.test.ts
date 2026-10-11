// fixtures/polyglot in the BUILT app: React page -> Express gateway (node-agent) -> FastAPI pricing (python-agent) -> SQLite, one trip.
// Run `pnpm build` first. Uses ports 4610/4611/4612. Skips without the fixture's node_modules or pricing/.venv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, fixtureCopy, launch, listening, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/polyglot");
const PORTS = [4610, 4611, 4612];
const python = join(ROOT, "pricing/.venv/bin/python");
const ready = existsSync(join(ROOT, "node_modules/express")) && existsSync(python) && spawnSync(python, ["-c", "import sys, fastapi, uvicorn; assert sys.version_info >= (3, 12)"]).status === 0;
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");

test("polyglot: one trip from the click through Express into the Python service, snapped at the Python line", { timeout: 300_000, skip: !ready && "needs fixtures/polyglot node_modules and pricing/.venv (see its README)" }, async () => {
  assert.equal(listening(PORTS), "", "polyglot ports must be free");
  // A copy under the temp dir: Shrike refuses to run anything under a .claude folder, and worktrees live in one.
  const dir = fixtureCopy("polyglot");
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: dir });
  try {
    await win.getByRole("button", { name: "Open a folder" }).click();
    const setup = win.getByRole("dialog", { name: "Set up polyglot" });
    await setup.waitFor();
    await sleep(400);
    await shot(app, "polyglot-01-setup");
    await setup.getByRole("button", { name: "Run all" }).click();
    const st = await waitFor("all three processes running", async () => {
      const s = await status(win);
      return s.state === "error" ? s : s.state === "running" && s.processes?.every((p) => p.state === "running") ? s : undefined;
    }, 90_000);
    assert.equal(st.state, "running", st.error);
    await waitFor("both servers recorded", async () => (await status(win)).processes?.filter((p) => p.instrumented).length === 2, 30_000);
    const guest = await waitFor("the page in the app pane", () => app.windows().find((p) => p.url().startsWith("http://localhost:4610")), 60_000);
    await guest.getByRole("button", { name: "Quote 2 tins of tea" }).waitFor({ timeout: 30_000 });
    await dismissResult(win, 5000);

    // Works: the same path end to end, no error.
    await guest.getByRole("button", { name: "Quote 2 tins of tea" }).click();
    await guest.getByText("Total: 10.80").waitFor({ timeout: 15_000 });
    const tea = await waitFor("the tea trip", async () => (await actions(win)).find((a) => a.label === 'Clicked "Quote 2 tins of tea"' && a.complete), 20_000);
    assert.equal(tea.status, "ok");
    await win.locator(`.th-trip[data-trip="${tea.id}"]`).waitFor();
    await sleep(1200);
    const teaDom = (await tripDom(win, tea.id))!;
    console.log(`--- tea\n${dump(teaDom)}\nverdict ${teaDom.verdict}`);
    for (const lane of ["service:gateway", "service:pricing", "data:sqlite:pricing.db"]) assert.ok(teaDom.stations.some((s) => s.lane === lane), `${lane}\n${dump(teaDom)}`);
    await shot(app, "polyglot-02-tea-ok");

    // The planted bug: WEB -> GATEWAY -> PRICING -> SQLite, snap on with_tax(), dive at its call, pricing/main.py:47.
    await guest.getByRole("button", { name: "Quote 2 tea books" }).click();
    await guest.getByText("Couldn't get a quote").waitFor({ timeout: 15_000 });
    const book = await waitFor("the book trip", async () => (await actions(win)).find((a) => a.label === 'Clicked "Quote 2 tea books"' && a.complete), 20_000);
    assert.equal(book.status, "error");
    assert.deepEqual((await actions(win)).filter((a) => a.label.startsWith("Clicked")).length, 2, "one trip per click: the Python side joined, not a trip of its own");
    const trip = win.locator(`.th-trip[data-trip="${book.id}"]`);
    await trip.waitFor();
    await trip.locator(".th-dive").waitFor({ timeout: 15_000 });
    await sleep(900);
    const t = (await tripDom(win, book.id))!;
    console.log(`--- book\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned}`);
    const at = (pred: (s: (typeof t.stations)[number]) => boolean, what: string, from = 0) => {
      const i = t.stations.findIndex((s, k) => k >= from && pred(s));
      assert.ok(i >= 0, `${what} after station ${from}\n${dump(t)}`);
      return i;
    };
    let i = at((s) => s.lane.startsWith("client:"), "WEB");
    i = at((s) => s.lane === "service:gateway", "GATEWAY", i + 1);
    i = at((s) => s.lane === "service:pricing", "PRICING", i + 1);
    at((s) => s.lane === "data:sqlite:pricing.db", "the SQLite query", i + 1);
    at((s) => s.lane === "service:pricing" && /\berror\b/.test(s.cls) && /with_tax/.test(s.label), "the snap on with_tax()", i + 1);
    assert.match(t.verdict, /BROKE/);

    const dive = trip.locator(".th-dive");
    const head = await dive.locator(".head .f").innerText();
    const live = await dive.locator(".th-ln.live").innerText();
    console.log(`dive head ${head}\nlive ${live}\ncaption ${await caption(win)}`);
    assert.match(head, /pricing\/main\.py/);
    assert.match(live, /^47\s+return \{"sku": sku, "qty": qty, "cents": with_tax\(cents \* qty, tax_class\)\}/, "the line that called it, where the bad value went in");
    assert.match(live, /with_tax\(cents=2400, tax_class='reduced'\)/);
    assert.equal(await caption(win), "with_tax() failed: KeyError: 'reduced'");
    await shot(app, "polyglot-03-book-dive");
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Escape");
    await dive.waitFor({ state: "detached" });
    await sleep(800);
    await shot(app, "polyglot-04-book-shape");

    await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor("polyglot ports to close", () => listening(PORTS) === "", 20_000);
  } catch (err) {
    await shot(app, "polyglot-failure").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    rmSync(dirname(dir), { recursive: true, force: true });
  }
  await waitFor("polyglot ports to close", () => listening(PORTS) === "", 20_000);
});
