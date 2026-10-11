// fixtures/big-app in the BUILT app on a copy (random ports): twelve processes, one "Place order" click that crosses eight
// services, three Postgres databases, an SQLite outbox, three LRU caches, a queue, Stripe and email doubles, forks, coils
// and polls, then snaps at orders/src/domain/totals.ts:25. The Files view opens on it; the one-line fix turns it green.
// Run `pnpm build` first (or SHRIKE_E2E_APP=<a build kept apart from out/>).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ActionView, RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, fixtureCopy, flatten, freePort, key, launch, listening, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const NAMES = ["web", "gateway", "auth", "catalog", "search", "cart", "orders", "recommendations", "notifications", "queue", "stripe", "email", "cron"];
const DEFAULTS: Record<string, number> = { web: 5190, gateway: 4400, auth: 4401, catalog: 4402, search: 4403, cart: 4404, orders: 4405, recommendations: 4406, notifications: 4407, queue: 4408, stripe: 4498, email: 4499 };
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const laneHeads = (win: Page) =>
  win.evaluate(() => [...document.querySelectorAll<HTMLElement>(".th-lanehead > *")].map((el) => ({ text: `${el.textContent ?? ""} ${el.title}`, mode: el.classList.contains("sliver") ? "sliver" : el.classList.contains("group") ? "group" : "full" })));
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");

/** Named functions the trip ran (anonymous callbacks are plumbing): distinct file:line:name, and the files they live in. */
function functionStations(v: ActionView) {
  const fns = flatten(v.tree).filter((e) => e.kind === "function" && e.source && !/^(anonymous|\w+ callback)(\(\))?$/.test(e.name));
  const distinct = new Map(fns.map((e) => [`${e.source!.file}:${e.source!.line}:${e.name}`, e]));
  return { distinct: distinct.size, files: new Set([...distinct.values()].map((e) => e.source!.file)), calls: fns.length };
}

test("big-app: one Place order click is a 60+ station trip across 30+ files that snaps at totals.ts:25", { timeout: 600_000 }, async () => {
  const ports: Record<number, number> = {};
  for (const n of Object.keys(DEFAULTS)) ports[DEFAULTS[n]!] = await freePort();
  const web = ports[DEFAULTS.web!]!;
  const proj = fixtureCopy("big-app", { ports });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    await win.getByRole("button", { name: "Open a folder" }).click();

    // Setup lists every process, and the places Shrike expects: the queue, Stripe and email doubles from .shrike/config.json.
    const setup = win.getByRole("dialog", { name: "Set up big-app" });
    await setup.waitFor();
    const names = await setup.getByRole("textbox", { name: /^Name of process/ }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    assert.deepEqual(names, NAMES);
    const expected = (await setup.getByRole("list", { name: "Expected places" }).innerText()).toUpperCase();
    for (const want of ["GATEWAY", "ORDERS", "QUEUE", "POSTGRES", "LRU", "STRIPE", "EMAIL"]) assert.match(expected, new RegExp(want), `expected places: ${expected}`);
    await shot(app, "01-setup", "big");

    await setup.getByRole("button", { name: "Run all" }).click();
    const st = await waitFor("all thirteen processes running", async () => {
      const s = await status(win);
      return s.state === "error" ? s : s.state === "running" && s.processes?.every((p) => p.state === "running") ? s : undefined;
    }, 120_000);
    assert.equal(st.state, "running", st.error);
    const guest = await waitFor("the Bazaar page in the app pane", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 60_000);
    await guest.getByRole("button", { name: "Place order" }).waitFor({ timeout: 30_000 });
    await guest.getByText("Total", { exact: true }).waitFor({ timeout: 30_000 });
    await dismissResult(win, 5000);

    // The nightly reindex runs once after boot: a trip that starts in the CRON lane.
    const cron = await waitFor("the cron reindex trip", async () => (await actions(win)).find((a) => a.root.caller?.kind === "cron" && a.complete), 60_000);
    assert.equal(cron.status === "error" ? cron.label : "ok", "ok");

    await guest.getByRole("button", { name: "Place order" }).click();
    await guest.getByText("We couldn't place your order.").waitFor({ timeout: 30_000 });
    const order = await waitFor("the Place order trip", async () => (await actions(win)).find((a) => a.label === 'Clicked "Place order"' && a.complete), 30_000);
    assert.equal(order.status, "error");

    const fs = functionStations(order);
    console.log(`place order: ${fs.calls} function calls, ${fs.distinct} distinct functions in ${fs.files.size} files, ${Math.round(order.durationMs)}ms\n${[...fs.files].sort().join("\n")}`);
    console.log(`flags: ${order.flags.map((f) => `${f.kind}: ${f.message}`).join(" | ")}`);
    assert.ok(fs.distinct >= 60, `>= 60 function stations, got ${fs.distinct}`);
    assert.ok(fs.files.size >= 30, `>= 30 files, got ${fs.files.size}`);
    const events = flatten(order.tree);
    const timed = events.filter((e) => e.kind === "function" && e.durationMs !== undefined).map((e) => e.durationMs!);
    assert.ok(Math.min(...timed) < 2 && Math.max(...timed) > 1000, `timings span ~1ms to over a second: ${Math.min(...timed)}..${Math.max(...timed)}`);

    const trip = win.locator(`.th-trip[data-trip="${order.id}"]`);
    await trip.waitFor();
    await trip.locator(".th-dive").waitFor({ timeout: 20_000 });
    await sleep(1200);
    const t = (await tripDom(win, order.id))!;
    console.log(`--- place order (${t.stations.length} drawn)\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned}`);

    // Lanes: the trip's places plus the CRON caller, the queue, three caches, three Postgres databases, SQLite, Stripe, email.
    const lanes = [...new Set(t.stations.map((s) => s.lane))];
    for (const want of [/^cache:lru:sessions$/, /^cache:lru:carts$/, /^cache:lru:products$/, /^data:postgres:catalog$/, /^data:postgres:orders$/, /^data:sqlite:/, /^queue:/, /^outside:.*/, /^service:orders$/])
      assert.ok(lanes.some((l) => want.test(l)), `lane ${want} in ${lanes.join(", ")}`);
    const heads = await laneHeads(win);
    const headText = heads.map((h) => h.text).join(" | ").toUpperCase();
    console.log(heads.map((h) => `${h.mode} ${h.text}`).join("\n"));
    for (const want of ["CRON", "LRU", "POSTGRES", "SQLITE", "QUEUE", "STRIPE", "EMAIL"]) assert.match(headText, new RegExp(want), `lane head ${want}`);

    // The fork (Promise.all to catalog, search and recommendations), the N+1 coil, and the poll with backoff to Stripe.
    assert.ok(await trip.locator(".th-forklab", { hasText: "at the same time" }).count(), "the fork is labelled");
    assert.ok(t.stations.some((s) => /^getProduct\(\) ×[3-9]/.test(s.label)), `the N+1 coil\n${dump(t)}`);
    assert.ok(t.stations.filter((s) => s.lane.startsWith("outside:") && /payment_intents/.test(s.label)).length >= 3, "Stripe polled with backoff");
    assert.ok(t.stations.some((s) => s.lane === "cache:lru:sessions" && /\bhit\b/.test(s.cls)), "a session cache hit");
    assert.ok(t.stations.some((s) => s.lane === "cache:lru:products" && /\bmiss\b/.test(s.cls)), "a product cache miss");

    // The snap: money() got a fraction of a cent from lineTax(), on the planted line.
    const snap = t.stations.findIndex((s) => /^money\(\)/.test(s.label) && /\berror\b/.test(s.cls));
    assert.ok(snap >= 0, `money() snaps\n${dump(t)}`);
    assert.match(t.stations[snap]!.where, /totals\.ts:25/);
    assert.match(t.stations[snap]!.chip, /206\.167/);
    assert.match(t.verdict, /BROKE/);
    const dive = trip.locator(".th-dive");
    assert.match(await dive.locator(".head .f").innerText(), /services\/orders\/src\/domain\/totals\.ts/);
    assert.match(await dive.locator(".th-ln.live").innerText(), /^25\s+return money\(line\.cents \* line\.taxRate\)/);
    console.log(`caption ${await caption(win)}`);
    await shot(app, "02-snap-dive", "big");
    await key(win, "Escape");
    await dive.waitFor({ state: "detached" });
    await sleep(800);
    await shot(app, "03-thread", "big");
    await trip.locator(".th-forklab").first().scrollIntoViewIfNeeded();
    await sleep(600);
    await shot(app, "03b-thread-fork", "big");
    await key(win, "t");
    await sleep(1200);
    await trip.locator(".th-forklab").first().scrollIntoViewIfNeeded();
    await sleep(600);
    await shot(app, "04-time-view-fork", "big");
    await trip.locator(".th-st.error").first().scrollIntoViewIfNeeded();
    await sleep(600);
    await shot(app, "04b-time-view-snap", "big");
    await key(win, "t");
    await sleep(600);

    // Files view: the toggle opens it on the same step, the failing line in totals.ts.
    const toggle = win.getByRole("group", { name: "View" });
    await toggle.getByRole("button", { name: "FILES" }).click();
    await win.locator(".fm").waitFor();
    await waitFor("the tree slice", async () => (await win.locator(".fm-row").count()) > 3, 15_000);
    await sleep(1500);
    assert.equal(await win.locator(".fm-card.focus").getAttribute("data-key"), "services/orders/src/domain/totals.ts");
    assert.ok(await win.locator(".fm-row.hot.err", { hasText: "totals.ts" }).count(), "its tree row is hot and red");
    await shot(app, "05-files", "big");
    await key(win, "Home");
    await sleep(1500);
    await shot(app, "06-files-home", "big");
    await key(win, "v");
    await win.locator(".th-stage:not([hidden])").waitFor();

    // The one-line fix: round each line's tax to whole cents. node --watch restarts orders; the same click is green.
    const totals = join(proj, "services/orders/src/domain/totals.ts");
    writeFileSync(totals, readFileSync(totals, "utf8").replace("money(line.cents * line.taxRate)", "money(Math.round(line.cents * line.taxRate))"));
    await sleep(3000); // node --watch restarts orders; a click before it's back fails, so try again
    for (let i = 0; i < 5 && !(await guest.getByText(/Order #\d+ placed/).count()); i++) {
      await guest.getByRole("button", { name: "Place order" }).click();
      await guest.getByText(/Order #\d+ placed|We couldn't place your order/).waitFor({ timeout: 30_000 });
      await sleep(1500);
    }
    await guest.getByText(/Order #\d+ placed/).waitFor({ timeout: 5_000 });
    const fixed = await waitFor("the fixed Place order trip", async () => (await actions(win)).findLast((a) => a.label === 'Clicked "Place order"' && a.complete && a.status !== "error"), 30_000);
    assert.notEqual(fixed.status, "error");
    await win.locator(`.th-trip[data-trip="${fixed.id}"]`).waitFor();
    await sleep(2500);
    const ft = (await tripDom(win, fixed.id))!;
    console.log(`--- fixed: ${fixed.status}, ${ft.stations.length} drawn, verdict ${ft.verdict}`);
    assert.ok(!ft.stations.some((s) => /\berror\b/.test(s.cls)), "nothing red after the fix");
    assert.ok(ft.stations.some((s) => s.lane.startsWith("outside:") && /messages/.test(s.label)), "the email went out through the queue");
    await shot(app, "07-fixed-green", "big");

    await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor("big-app ports to close", () => listening(Object.values(ports)) === "", 30_000);
  } catch (err) {
    await shot(app, "failure", "big").catch(() => {});
    throw err;
  } finally {
    await cleanup();
  }
});
