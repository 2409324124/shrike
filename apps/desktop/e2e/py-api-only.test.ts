// Python backends with no web page (fixtures/py-api-only FastAPI, fixtures/flask-api-only Flask) in the BUILT app: explorer, curl and cron trips
// carry python-agent's steps and values. Run `pnpm build` first. Uses ports 4410 and 4411. Skips when a fixture's .venv is missing (see its README).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ActionView, DebugEvent, RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, flatten, launch, listening, questReady, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");
const card = (win: Page, id: string) => win.locator(`.th-trip[data-trip="${id}"] .th-term`).innerText();
const events = async (win: Page, id: string) => flatten((await actions(win)).find((a) => a.id === id)?.tree ?? []);

interface Case {
  fixture: string;
  port: number;
  command: string;
  routes: string[];
  ok: { url: string; body: object };
  bad: { url: string; body: object; status: RegExp; label: string };
  steps: { name: string; args: string[]; returned?: string }[];
  snap: { lane: string; label: RegExp; chip?: RegExp; where: RegExp; stack?: string };
  cron: string;
  cronLabel: string;
}

const cases: Case[] = [
  {
    fixture: "py-api-only",
    port: 4410,
    command: ".venv/bin/uvicorn main:app --port 4410",
    routes: ["GET /health", "GET /orders/:order_id", "GET /products", "POST /orders"],
    ok: { url: "/orders", body: { customer: "ana@corner.cafe", lines: [{ sku: "BEANS", qty: 3 }], coupon: "WELCOME10" } },
    bad: { url: "/orders", body: { customer: "ana@corner.cafe", lines: [{ sku: "BEANS", qty: 3 }], coupon: "welcome10" }, status: /500/, label: "Sent POST /orders" },
    steps: [
      { name: "create_order()", args: [] },
      { name: "order_total()", args: ["coupon='welcome10'"] },
      { name: "coupon_percent()", args: ["code='welcome10'"], returned: "None" },
    ],
    // The raising line is in the error's stack; the station, like a Node function, shows where it was called.
    snap: { lane: "service:api", label: /^order_total\(\)$/, where: /^called at main\.py:81\b/, stack: 'main.py", line 66, in order_total' },
    cron: "sleep 2; SHRIKE_CALLER=cron REORDER_EVERY=3 .venv/bin/python reorder.py",
    cronLabel: "cron · POST /orders",
  },
  {
    fixture: "flask-api-only",
    port: 4411,
    command: ".venv/bin/python app.py",
    routes: ["GET /api/bookings", "GET /api/rooms/:room/free", "GET /health", "POST /api/bookings"],
    ok: { url: "/api/bookings", body: { room: "Oak", night: "2026-10-22", guest: "sam@example.com" } },
    bad: { url: "/api/bookings", body: { room: "Oak", night: "2026-10-21", guest: "kai@example.com" }, status: /500/, label: "Sent POST /api/bookings" },
    steps: [
      { name: "create_booking()", args: [] },
      { name: "is_free()", args: ["room='Oak'", "night='2026-10-21'"], returned: "True" },
      { name: "book()", args: ["room='Oak'", "night='2026-10-21'", "guest='kai@example.com'"], returned: "None" },
    ],
    snap: { lane: "data:sqlite:bookings.db", label: /^INSERT INTO bookings/, chip: /UNIQUE constraint failed: bookings\.room, bookings\.night/, where: /^app\.py:14\b/ },
    cron: "sleep 2; SHRIKE_CALLER=cron SYNC_EVERY=3 .venv/bin/python channel_sync.py",
    cronLabel: "cron · POST /api/bookings",
  },
];

for (const c of cases) {
  const ROOT = join(import.meta.dirname, "../../../fixtures", c.fixture);
  const CONFIG = join(ROOT, ".shrike/config.json");
  const python = join(ROOT, ".venv/bin/python");
  const ready = existsSync(python) && spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3, 12)"]).status === 0;
  const skip = !ready && `needs fixtures/${c.fixture}/.venv on Python 3.12+ (see its README)`;
  const p = (s: string) => `${c.fixture}-${s}`;

  test(`${c.fixture}: no page; explorer, curl and cron trips carry the Python steps, values and the line that broke`, { skip, timeout: 300_000 }, async () => {
    assert.equal(listening([c.port]), "", `${c.port} must be free`);
    const original = readFileSync(CONFIG, "utf8");
    const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: ROOT });
    try {
      await win.emulateMedia({ reducedMotion: "no-preference" });
      await win.getByRole("button", { name: "Open a folder" }).click();
      const setup = win.getByRole("dialog", { name: `Set up ${c.fixture}` });
      await setup.getByText("No web page found").waitFor();
      assert.equal(await setup.getByRole("textbox", { name: "Command for api" }).inputValue(), c.command);
      await sleep(1000);
      await shot(app, p("01-setup"), "py");
      await setup.getByRole("button", { name: "Run", exact: true }).click();
      await questReady(win);

      await win.getByText("This project has no web page.").waitFor();
      await sleep(500);
      await shot(app, p("02-no-page"), "py");
      await dismissResult(win, 3000);
      await win.getByRole("button", { name: /Open the API explorer/ }).click();

      const sheet = win.getByRole("region", { name: "API client" });
      const show = sheet.getByRole("button", { name: "Show collections" });
      if (await show.count()) await show.click();
      await sheet.getByText("Routes in your code").waitFor();
      const listed = await sheet.locator(".ap-row-main").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));
      console.log(`routes listed: ${JSON.stringify(listed)}`);
      assert.deepEqual(listed.map((r) => r.replace(/^(GET|POST|PUT|PATCH|DELETE)/, "$1 ")).sort(), [...c.routes].sort(), "the routes in the code are listed");
      await shot(app, p("03-explorer"), "py");
      await sheet.getByRole("button", { name: "Hide collections" }).first().click();
      const send = async (url: string, body: object, label: string) => {
        await sheet.getByRole("combobox", { name: "Method" }).selectOption("POST");
        await sheet.getByRole("textbox", { name: "URL", exact: true }).fill(url);
        await sheet.getByRole("tab", { name: /^Body/ }).click();
        await sheet.getByRole("textbox", { name: "Body" }).fill(JSON.stringify(body));
        const before = (await actions(win)).length;
        await sheet.getByRole("button", { name: "Send", exact: true }).click();
        return waitFor(`the explorer trip ${label}`, async () => (await actions(win)).slice(before).find((a) => a.label === label && a.complete), 20_000);
      };
      const good = await send(c.ok.url, c.ok.body, c.bad.label);
      assert.equal(good.status, "ok");
      const bad = await send(c.bad.url, c.bad.body, c.bad.label);
      await sheet.getByText(c.bad.status).first().waitFor();
      assert.equal(bad.status, "error");
      await shot(app, p("04-explorer-sent"), "py");
      await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await win.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      await win.getByRole("status").getByText("New trip").waitFor();
      await win.keyboard.press("Enter");
      await win.locator(`.th-trip[data-trip="${bad.id}"]`).waitFor();
      await dismissResult(win);
      await sleep(1500);
      const t = (await tripDom(win, bad.id))!;
      const evs = await events(win, bad.id);
      console.log(`--- explorer\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned} | card ${await card(win, bad.id)}\ncaption ${await caption(win)}`);
      console.log(evs.map((e) => `${e.kind} ${e.name} ${JSON.stringify(e.args ?? [])} -> ${e.returned ?? ""} @${e.source?.file}:${e.source?.line} ${e.source?.precision ?? ""} ${e.status} ${e.error?.type ?? ""}`).join("\n"));
      await shot(app, p("05-explorer-trip"), "py");
      checkTrip(c, t, evs);
      assert.match(await card(win, bad.id), /EXPLORER/i);
      assert.equal(await win.locator(`.th-trip[data-trip="${bad.id}"] .th-shot img`).count(), 0);

      execFileSync("curl", ["-s", "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify(c.bad.body), `http://localhost:${c.port}${c.bad.url}`]);
      const curl = await waitFor("the curl trip", async () => (await actions(win)).find((a) => a.label === `curl POST ${c.bad.url}` && a.complete), 20_000);
      await win.locator(`.th-trip[data-trip="${curl.id}"]`).waitFor();
      await waitFor("the curl trip in focus", async () => (await win.locator(".th-trip.focus").getAttribute("data-trip")) === curl.id, 15_000);
      await sleep(1000);
      const curlCard = await card(win, curl.id);
      console.log(`curl card: ${curlCard}\ncaption ${await caption(win)}`);
      assert.match(curlCard, /CURL/);
      assert.match(curlCard, new RegExp(`\\$ curl -X POST 'http://localhost:${c.port}${c.bad.url}'`));
      assert.ok(curlCard.includes(` -d '${JSON.stringify(c.bad.body)}'`), "the card carries the body (Flask reads it with readinto)");
      checkTrip(c, (await tripDom(win, curl.id))!, await events(win, curl.id));
      await shot(app, p("06-curl-trip"), "py");

      await win.getByRole("button", { name: "Set up processes" }).click();
      await setup.getByRole("button", { name: "Add a process" }).click();
      await setup.getByRole("textbox", { name: "Name of process 2" }).fill("cron");
      await setup.getByRole("textbox", { name: "Command for cron" }).fill(c.cron);
      await setup.getByRole("button", { name: "Restart all" }).click();
      const allow = win.getByRole("region", { name: "Your app" }).getByRole("button", { name: "Allow", exact: true });
      await allow.waitFor({ timeout: 90_000 });
      await allow.click();
      const cron = await waitFor("two cron trips", async () => {
        const vs = (await actions(win)).filter((a) => a.complete && /cron/i.test(a.label));
        return vs.length >= 2 ? vs : undefined;
      }, 60_000).catch(async (e) => {
        console.log((await actions(win)).map((a: ActionView) => `${a.label} ${a.status} ${JSON.stringify(a.root.caller)}`).join("\n"));
        throw e;
      });
      console.log(cron.map((v) => `${v.label} ${v.status}`).join("\n"));
      const broke = cron.find((v) => v.status === "error")!;
      assert.ok(broke);
      assert.ok(cron.every((v) => v.label === c.cronLabel), cron.map((v) => v.label).join());
      await win.getByRole("navigation", { name: "Trips" }).getByRole("button", { name: new RegExp(`^${c.cronLabel}, broke`) }).first().click();
      await sleep(1500);
      const ct = (await tripDom(win, broke.id))!;
      console.log(`--- cron\n${dump(ct)}\ncard ${await card(win, broke.id)}\ncaption ${await caption(win)}`);
      assert.match(await card(win, broke.id), /CRON/);
      assert.ok(ct.stations.some((s) => s.lane === "caller:cron"), "the script's call starts in the CRON lane");
      checkTrip(c, ct, await events(win, broke.id));
      assert.equal((await status(win)).state, "running");
      await dismissResult(win);
      await shot(app, p("07-cron-trip"), "py");

      await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
      await waitFor(`${c.port} to close`, () => listening([c.port]) === "", 20_000);
    } catch (err) {
      await shot(app, p("failure"), "py").catch(() => {});
      throw err;
    } finally {
      writeFileSync(CONFIG, original);
      await cleanup();
    }
    await waitFor(`${c.port} to close`, () => listening([c.port]) === "", 20_000);
  });
}

function checkTrip(c: Case, t: NonNullable<Awaited<ReturnType<typeof tripDom>>>, evs: DebugEvent[]): void {
  const lanes = new Set(t.stations.map((s) => s.lane));
  assert.ok(lanes.has("service:api"), `an API lane\n${dump(t)}`);
  assert.ok(!t.stations.some((s) => s.lane.startsWith("client:")), "no page lane");
  for (const s of c.steps) {
    const e = evs.find((x) => x.kind === "function" && x.name === s.name);
    assert.ok(e, `${s.name} recorded: ${evs.map((x) => x.name).join(", ")}`);
    for (const a of s.args) assert.ok(e.args?.some((x) => x.includes(a)), `${s.name} args ${JSON.stringify(e.args)} carry ${a}`);
    if (s.returned) assert.equal(e.returned, s.returned);
    assert.equal(e.source?.precision, "exact");
  }
  const snap = t.stations.find((s) => s.lane === c.snap.lane && /\berror\b/.test(s.cls) && c.snap.label.test(s.label));
  assert.ok(snap, `the snap is on ${c.snap.lane}\n${dump(t)}`);
  if (c.snap.chip) assert.match(snap.chip, c.snap.chip);
  assert.match(snap.where, c.snap.where);
  if (c.snap.stack) assert.ok(evs.some((e) => e.kind === "function" && c.snap.label.test(e.name) && e.error?.stack?.includes(c.snap.stack!)), `the error's stack names ${c.snap.stack}`);
  assert.match(t.returned, c.bad.status);
  assert.match(t.verdict, /BROKE/);
}
