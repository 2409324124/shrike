// fixtures/shop-app in the BUILT app: four processes, discovered lanes, cache miss then hit, a crossing, a fork and the Stripe refusal.
// Run `pnpm build` first. Uses ports 5180/4100/4101/4199.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, launch, listening, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/shop-app");
const PORTS = [5180, 4100, 4101, 4199];
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
/** Lane headers as drawn: label, full or sliver, ghost. */
const laneHeads = (win: Page) =>
  win.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".th-lanehead > *")].map((el) => ({ label: el.querySelector("b")?.textContent ?? el.textContent ?? "", title: el.title, mode: el.classList.contains("sliver") ? "sliver" : "full", ghost: el.classList.contains("ghost") })),
  );
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");

test("shop-app: setup, cache miss then hit, Pay now crosses services, forks and snaps at Stripe", { timeout: 300_000 }, async () => {
  assert.equal(listening(PORTS), "", "shop ports must be free");
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: ROOT });
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    await win.getByRole("button", { name: "Open a folder" }).click();

    // D12 + D11: the setup screen lists the four processes and what Shrike expects to find.
    const setup = win.getByRole("dialog", { name: "Set up shop-app" });
    await setup.waitFor();
    const names = await setup.getByRole("textbox", { name: /^Name of process/ }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    assert.deepEqual(names, ["web", "api", "auth", "payments"]);
    const expected = (await setup.getByRole("list", { name: "Expected places" }).innerText()).toUpperCase();
    for (const want of ["WEB", "API", "AUTH", "POSTGRES", "SQLITE", "LRU", "STRIPE"]) assert.match(expected, new RegExp(want), `expected places: ${expected}`);
    await sleep(400);
    await shot(app, "shop-01-setup");

    await setup.getByRole("button", { name: "Run all" }).click();
    const st = await waitFor("all four processes running", async () => {
      const s = await status(win);
      return s.state === "error" ? s : s.state === "running" && s.processes?.every((p) => p.state === "running") ? s : undefined;
    }, 90_000);
    assert.equal(st.state, "running", st.error);
    assert.deepEqual(st.processes?.map((p) => p.name), ["web", "api", "auth", "payments"]);
    const guest = await waitFor("the shop page in the app pane", () => app.windows().find((p) => p.url().startsWith("http://localhost:5180")), 60_000);
    await guest.getByRole("button", { name: "Pay now" }).waitFor({ timeout: 30_000 });
    await dismissResult(win, 5000);

    // T16: the first load misses the orders cache, goes to Postgres, then fills the cache.
    const load = await waitFor("the page-load trip", async () => (await actions(win)).find((a) => a.label === "Opened /" && a.complete), 30_000);
    await win.locator(`.th-trip[data-trip="${load.id}"]`).waitFor();
    await sleep(1500);
    const loadDom = (await tripDom(win, load.id))!;
    console.log(`--- load\n${dump(loadDom)}`);
    const miss = loadDom.stations.findIndex((s) => s.lane === "cache:lru:orders" && /\bmiss\b/.test(s.cls));
    assert.ok(miss >= 0, "a hollow miss in LRU orders");
    assert.ok(loadDom.stations.findIndex((s, i) => i > miss && s.lane.startsWith("data:postgres")) > miss, "then Postgres");
    assert.ok(loadDom.stations.some((s) => s.lane === "cache:lru:orders" && /\bset\b/.test(s.cls)), "then the cache is filled");
    await shot(app, "shop-02-load-miss");

    // T15: refreshing hits the cache and never reaches Postgres.
    await guest.getByRole("button", { name: "Refresh orders" }).click();
    const refresh = await waitFor("the refresh trip", async () => (await actions(win)).find((a) => a.label === 'Clicked "Refresh orders"' && a.complete), 20_000);
    await win.locator(`.th-trip[data-trip="${refresh.id}"]`).waitFor();
    await sleep(1500);
    const refDom = (await tripDom(win, refresh.id))!;
    console.log(`--- refresh\n${dump(refDom)}`);
    assert.ok(refDom.stations.some((s) => s.lane === "cache:lru:orders" && /\bhit\b/.test(s.cls)), "a green hit bounce");
    assert.ok(!refDom.stations.some((s) => s.lane.startsWith("data:postgres")), "no database on a hit");
    await shot(app, "shop-03-refresh-hit");

    // Pay now: WEB -> API -> AUTH (crossing), sessions hit, fork into Stripe and the SQLite event, snap at Stripe.
    await guest.getByRole("button", { name: "Pay now" }).click();
    await guest.getByText("Payment failed").waitFor({ timeout: 15_000 });
    const pay = await waitFor("the Pay now trip", async () => (await actions(win)).find((a) => a.label === 'Clicked "Pay now"' && a.complete), 20_000);
    assert.equal(pay.status, "error");
    const trip = win.locator(`.th-trip[data-trip="${pay.id}"]`);
    await trip.waitFor();
    await trip.locator(".th-dive").waitFor({ timeout: 15_000 });
    await sleep(900);
    const t = (await tripDom(win, pay.id))!;
    console.log(`--- pay\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned}`);
    const at = (pred: (s: (typeof t.stations)[number]) => boolean, what: string, from = 0) => {
      const i = t.stations.findIndex((s, k) => k >= from && pred(s));
      assert.ok(i >= 0, `${what} after station ${from}\n${dump(t)}`);
      return i;
    };
    let i = at((s) => s.lane.startsWith("client:"), "WEB");
    i = at((s) => s.lane === "service:api", "API", i + 1);
    i = at((s) => s.lane === "service:auth", "AUTH", i + 1);
    i = at((s) => s.lane === "cache:lru:sessions" && /\bhit\b/.test(s.cls), "sessions hit", i + 1);
    const stripe = at((s) => s.kind === "outside" && /\berror\b/.test(s.cls), "the Stripe snap", i + 1);
    assert.match(t.stations[stripe]!.chip, /50 cents/i);
    assert.ok(t.stations.some((s) => s.lane === "data:sqlite:events.db"), "the event write on its own branch");
    assert.ok(await trip.locator(".th-forklab", { hasText: "at the same time" }).count(), "the fork is labelled");
    assert.match(t.verdict, /BROKE/);

    // The dive lands on the code that sent the charge: the amount line, with the amount chip.
    const dive = trip.locator(".th-dive");
    const live = await dive.locator(".th-ln.live").innerText();
    console.log(`dive head ${await dive.locator(".head .f").innerText()}\nlive ${live}\ncaption ${await caption(win)}`);
    assert.match(await dive.locator(".head .f").innerText(), /services\/api\/index\.ts/i);
    assert.match(live, /^33\s+chargeCard\(\{ amount: cart\.total/);
    assert.match(await dive.innerText(), /amount: 49\b/);
    assert.match(await caption(win), /^chargeCard\(\) sent \{ amount: 49.* to Stripe \(test double\), which refused: Amount must be at least 50 cents\.$/);
    await shot(app, "shop-04-pay-dive");

    // D10: lanes this trip doesn't touch (LRU orders, Postgres) are slivers.
    const heads = await laneHeads(win);
    console.log(heads.map((h) => `${h.mode}${h.ghost ? " ghost" : ""} ${h.label} (${h.title})`).join("\n"));
    assert.ok(heads.some((h) => h.mode === "sliver"), "untouched lanes fold to slivers");
    assert.ok(heads.some((h) => h.mode === "full" && /STRIPE/i.test(h.label + h.title)), "Stripe is a full lane");
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Escape");
    await dive.waitFor({ state: "detached" });
    await sleep(800);
    await shot(app, "shop-05-pay-shape");

    // O4: one terminal tab per process.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("`");
    const tabs = win.getByRole("tablist", { name: "Processes" });
    await tabs.waitFor();
    assert.deepEqual(await tabs.getByRole("tab").allInnerTexts().then((x) => x.map((s) => s.trim().toLowerCase())), ["all", "web", "api", "auth", "payments"]);
    await tabs.getByRole("tab", { name: "api" }).click();
    await win.getByRole("region", { name: "Terminal" }).getByText(/payment refused/).first().waitFor({ timeout: 10_000 });
    await shot(app, "shop-06-terminal-api");
    await win.keyboard.press("Escape");

    await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor("shop ports to close", () => listening(PORTS) === "", 20_000);
  } catch (err) {
    await shot(app, "shop-failure").catch(() => {});
    throw err;
  } finally {
    await cleanup();
  }
  await waitFor("shop ports to close", () => listening(PORTS) === "", 20_000);
});
