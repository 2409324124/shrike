// fixtures/py-edge in the BUILT app: FastAPI with httpx to an outside API (a local stub), SQLAlchemy on Postgres (Docker,
// else SQLite), a background task and asyncio.gather. Shrike never claims "nothing changed" where it can't see.
// Run `pnpm build` first. Uses ports 4620/4621 (and 4622 for Postgres). Skips without app/.venv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, fixtureCopy, launch, listening, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/py-edge");
const PORTS = [4620, 4621];
const python = join(ROOT, "app/.venv/bin/python");
const ready = existsSync(python) && spawnSync(python, ["-c", "import sys, fastapi, httpx, sqlalchemy, psycopg; assert sys.version_info >= (3, 12)"]).status === 0;
const PG = "shrike-py-edge-e2e-pg";
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");
const panel = (win: Page) => win.locator(".insp");

/** Postgres 16 on 4622 in Docker; false (and the copy switched to SQLite) when Docker isn't there. */
function postgres(dir: string): boolean {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0) {
    spawnSync("docker", ["rm", "-f", PG], { stdio: "ignore" });
    if (spawnSync("docker", ["run", "-d", "--rm", "--name", PG, "-p", "4622:5432", "-e", "POSTGRES_USER=edge", "-e", "POSTGRES_PASSWORD=edge", "-e", "POSTGRES_DB=edge", "postgres:16"], { stdio: "ignore" }).status === 0) return true;
  }
  const cfg = join(dir, ".shrike/config.json");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(".venv/bin/uvicorn", "DATABASE_URL=sqlite:///.data/edge.db .venv/bin/uvicorn"));
  return false;
}

test("py-edge: httpx calls in the outside lane, ORM writes Shrike can't read said plainly, background task and gather nest right", { timeout: 300_000, skip: !ready && "needs fixtures/py-edge/app/.venv (see its README)" }, async () => {
  assert.equal(listening([...PORTS, 4622]), "", "py-edge ports must be free");
  const dir = fixtureCopy("py-edge"); // a temp copy: Shrike runs nothing under a .claude folder, and worktrees live in one
  const pg = postgres(dir);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: dir });
  try {
    await win.getByRole("button", { name: "Open a folder" }).click();
    const setup = win.getByRole("dialog", { name: "Set up py-edge" });
    await setup.waitFor();
    await sleep(400);
    await shot(app, "py-edge-01-setup");
    await setup.getByRole("button", { name: "Run all" }).click();
    const st = await waitFor("both processes running", async () => {
      const s = await status(win);
      return s.state === "error" ? s : s.state === "running" && s.processes?.every((p) => p.state === "running") ? s : undefined;
    }, 120_000);
    assert.equal(st.state, "running", st.error);
    const guest = await waitFor("the page in the app pane", () => app.windows().find((p) => p.url().startsWith("http://localhost:4620")), 60_000);
    await guest.getByRole("button", { name: "Order a mug in USD" }).waitFor({ timeout: 30_000 });
    await dismissResult(win, 5000);

    const click = async (name: string, expect: RegExp) => {
      await guest.getByRole("button", { name }).click();
      await guest.getByText(expect).waitFor({ timeout: 15_000 });
      const a = await waitFor(`the "${name}" trip`, async () => (await actions(win)).find((x) => x.label === `Clicked "${name}"` && x.complete), 20_000);
      await win.locator(`.th-trip[data-trip="${a.id}"]`).waitFor();
      await sleep(2500); // the background task finishes after the response
      const t = (await tripDom(win, a.id))!;
      console.log(`--- ${name} (${a.status})\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned}\ncaption ${await caption(win)}`);
      return { a, t };
    };

    // USD: the order is written through SQLAlchemy; the background task's send_receipt() still belongs to this trip.
    const usd = await click("Order a mug in USD", /Order #\d+ placed/);
    assert.equal(usd.a.status, "ok");
    assert.ok(usd.t.stations.some((s) => s.lane === "service:api" && /send_receipt/.test(s.label)), "the background task is in the trip");
    const receipt = usd.t.stations.findIndex((s) => s.lane === "outside:localhost:4621" && /POST \/receipts/.test(s.label));
    assert.ok(receipt > usd.t.stations.findIndex((s) => /send_receipt/.test(s.label)), "the background task's httpx call, in the declared outside lane");
    const dbLane = pg ? undefined : "data:sqlite:edge.db";
    if (dbLane) assert.ok(usd.t.stations.some((s) => s.lane === dbLane), "SQLAlchemy over sqlite3 is recorded");
    else assert.ok(!usd.t.stations.some((s) => s.kind === "data"), "psycopg isn't recorded");
    await shot(app, "py-edge-02-usd");

    // What this click changed: never "Nothing changed" for a write Shrike couldn't read.
    const lane = win.locator(".th-lanehead button.th-lanebtn", { hasText: /DATABASE|POSTGRES|SQLITE/ });
    if (await lane.count()) {
      await lane.first().click();
      await panel(win).getByRole("tab", { name: /What this click changed/ }).click({ timeout: 15_000 });
      await sleep(500);
      const text = await panel(win).innerText();
      console.log(`--- inspector\n${text}`);
      assert.doesNotMatch(text, /Nothing changed in the database/);
      assert.match(text, /This click went through localhost:4620, where Shrike can't see row changes/);
      await shot(app, "py-edge-03-usd-changes");
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await win.keyboard.press("0");
      await sleep(500);
    } else console.log("--- no database lane to inspect");

    // EUR: the outside API sends the rate as a string; only usd_rate()'s return value shows it, convert() fails on it.
    const eur = await click("Order a mug in EUR", /Couldn't place the order/);
    assert.equal(eur.a.status, "error");
    const snap = eur.t.stations.find((s) => /\berror\b/.test(s.cls) && s.lane === "service:api" && /convert/.test(s.label));
    assert.ok(snap, dump(eur.t));
    const rate = eur.t.stations.findIndex((s) => /usd_rate/.test(s.label));
    assert.ok(rate >= 0, dump(eur.t));
    assert.ok(eur.t.stations.findIndex((s) => s.lane === "outside:localhost:4621" && /GET \/rates/.test(s.label)) > rate, "the rates call under usd_rate()");
    assert.match(eur.t.verdict, /BROKE/);
    await shot(app, "py-edge-04-eur");

    // gather: two rate fetches and the counting thread hang off dashboard().
    const dash = await click("Load dashboard", /orders so far/);
    assert.equal(dash.a.status, "ok");
    assert.equal(dash.t.stations.filter((s) => /fetch_rates|count_orders/.test(s.label)).length >= 2, true, dump(dash.t));
    await shot(app, "py-edge-05-dashboard");

    await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor("py-edge ports to close", () => listening(PORTS) === "", 20_000);
  } catch (err) {
    await shot(app, "py-edge-failure").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    spawnSync("docker", ["rm", "-f", PG], { stdio: "ignore" });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});
