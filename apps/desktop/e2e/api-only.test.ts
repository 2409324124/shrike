// fixtures/api-only in the BUILT app: no web page, trips start at their caller (explorer, curl, cron). Run `pnpm build` first. Uses port 4300.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, caption, launch, listening, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/api-only");
const CONFIG = join(ROOT, ".shrike/config.json");
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const dump = (t: NonNullable<Awaited<ReturnType<typeof tripDom>>>) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");
const card = (win: Page, id: string) => win.locator(`.th-trip[data-trip="${id}"] .th-term`).innerText();

test("api-only: no page; explorer and curl trips start at their caller, the 409 snaps in SQLITE, the nightly job is a cron trip", { timeout: 300_000 }, async () => {
  assert.equal(listening([4300]), "", "4300 must be free");
  const original = readFileSync(CONFIG, "utf8");
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: ROOT });
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    await win.getByRole("button", { name: "Open a folder" }).click();
    const setup = win.getByRole("dialog", { name: "Set up api-only" });
    await setup.getByText("No web page found").waitFor();
    await setup.getByRole("button", { name: "Run", exact: true }).click();
    await waitFor("the API running", async () => ((await status(win)).state === "running" ? true : undefined), 60_000);

    // The dock says there is no page, calmly, and offers the explorer.
    const dock = win.getByText("This project has no web page.");
    await dock.waitFor();
    await sleep(500);
    await shot(app, "api-01-no-page");
    await win.getByRole("button", { name: /Open the API explorer/ }).click();

    // Two POSTs from the explorer: the second differs only in case and gets 409 instead of the promised 200.
    const sheet = win.getByRole("region", { name: "API client" });
    const send = async (email: string) => {
      await sheet.getByRole("combobox", { name: "Method" }).selectOption("POST");
      await sheet.getByRole("textbox", { name: "URL", exact: true }).fill("/v1/users");
      await sheet.getByRole("tab", { name: /^Body/ }).click();
      await sheet.getByRole("textbox", { name: "Body" }).fill(JSON.stringify({ email, name: "Sam Rivera" }));
      const before = (await actions(win)).length;
      await sheet.getByRole("button", { name: "Send", exact: true }).click();
      return waitFor(`the explorer trip for ${email}`, async () => (await actions(win)).slice(before).find((a) => a.label === "Sent POST /v1/users" && a.complete), 20_000);
    };
    const first = await send("sam@example.com");
    assert.equal(first.status, "ok");
    const second = await send("Sam@Example.com");
    await sheet.getByText(/409/).first().waitFor();
    assert.equal(second.status, "error");
    await shot(app, "api-02-explorer-409");
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    // The trip arrived while the explorer was open, so it waits behind "New trip · Enter to view".
    await win.getByRole("status").getByText("New trip").waitFor();
    await win.keyboard.press("Enter");
    const trip = win.locator(`.th-trip[data-trip="${second.id}"]`);
    await trip.waitFor();
    await waitFor("the explorer trip to land on its failure", async () => /database refused/.test(await caption(win)), 15_000);
    assert.equal(await caption(win), "insertUser() stopped because the database refused.");
    await sleep(600);
    const t = (await tripDom(win, second.id))!;
    console.log(`--- explorer\n${dump(t)}\nverdict ${t.verdict} | returned ${t.returned} | card ${await card(win, second.id)}\ncaption ${await caption(win)}`);
    assert.match(await card(win, second.id), /EXPLORER/i, "a terminal card in the EXPLORER lane, not a screenshot");
    assert.equal(await trip.locator(".th-shot img").count(), 0);
    const snap = t.stations.findIndex((s) => s.lane === "data:sqlite:users.db" && /\berror\b/.test(s.cls));
    assert.ok(snap >= 0, `the snap is in SQLITE\n${dump(t)}`);
    assert.match(t.stations[snap]!.chip, /UNIQUE constraint failed/);
    assert.match(t.returned, /409/);
    assert.match(t.verdict, /BROKE/);
    await shot(app, "api-03-explorer-trip");

    // curl starts its own trip with the command on the card.
    execFileSync("curl", ["-s", "-X", "POST", "-H", "content-type: application/json", "-d", '{"email":"Lee@Example.com","name":"Lee Chen"}', "http://localhost:4300/v1/users"]);
    const curl = await waitFor("the curl trip", async () => (await actions(win)).find((a) => a.label === "curl POST /v1/users" && a.complete), 20_000);
    await win.locator(`.th-trip[data-trip="${curl.id}"]`).waitFor();
    await waitFor("the curl trip to land on its failure", async () => (await win.locator(".th-trip.focus").getAttribute("data-trip")) === curl.id && /database refused/.test(await caption(win)), 15_000);
    await sleep(600);
    const curlCard = await card(win, curl.id);
    console.log(`curl card: ${curlCard}\ncaption ${await caption(win)}`);
    assert.match(curlCard, /CURL/);
    assert.match(curlCard, /\$ curl -X POST 'http:\/\/localhost:4300\/v1\/users'/);
    assert.ok((await tripDom(win, curl.id))!.stations.some((s) => s.lane === "data:sqlite:users.db" && /\berror\b/.test(s.cls)));
    await shot(app, "api-04-curl-trip");

    // The nightly job, added in Setup as a second process with SHRIKE_CALLER=cron, makes cron trips; its failure leaves the API up.
    await win.getByRole("button", { name: "Set up processes" }).click();
    await setup.getByRole("button", { name: "Add a process" }).click();
    await setup.getByRole("textbox", { name: "Name of process 2" }).fill("nightly");
    await setup.getByRole("textbox", { name: "Command for nightly" }).fill("sleep 2; SHRIKE_CALLER=cron node src/nightly.ts");
    await setup.getByRole("button", { name: "Restart all" }).click();
    // The start agent asks before running a command it can't vouch for: the question shows over the app, the user allows it.
    const allow = win.getByRole("region", { name: "Your app" }).getByRole("button", { name: "Allow", exact: true });
    await allow.waitFor({ timeout: 90_000 });
    await shot(app, "api-04b-start-asks");
    await allow.click();
    const cron = await waitFor("two cron trips", async () => {
      const vs = (await actions(win)).filter((a) => a.root.caller?.kind === "cron" && a.complete);
      return vs.length >= 2 ? vs : undefined;
    }, 60_000);
    const bad = cron.find((v) => v.status === "error");
    assert.ok(bad, cron.map((v) => `${v.label} ${v.status}`).join());
    assert.ok(cron.every((v) => v.label === "cron · POST /v1/users"));
    await waitFor("nightly to finish", async () => ((await status(win)).processes?.find((p) => p.name === "nightly")?.state === "error" ? true : undefined), 20_000);
    assert.equal((await status(win)).state, "running", "a failed cron run leaves the API up");
    await win.getByRole("navigation", { name: "Trips" }).getByRole("button", { name: /^cron · POST \/v1\/users, broke/ }).first().click();
    await sleep(1500);
    assert.match(await card(win, bad.id), /CRON/);
    const ct = (await tripDom(win, bad.id))!;
    console.log(`--- cron\n${dump(ct)}`);
    assert.ok(ct.stations.some((s) => s.lane === "caller:cron" && /^fetch POST \/v1\/users/.test(s.label)), "the script's call starts in the CRON lane");
    assert.ok(ct.stations.some((s) => s.lane === "service:api" && s.label === "POST /v1/users"), "and crosses into API");
    assert.ok(!ct.stations.some((s) => s.lane === "service:server"), "no made-up SERVER lane");
    console.log(`cron caption ${await caption(win)}`);
    await shot(app, "api-05-cron-trip");

    await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor("4300 to close", () => listening([4300]) === "", 20_000);
  } catch (err) {
    await shot(app, "api-failure").catch(() => {});
    throw err;
  } finally {
    writeFileSync(CONFIG, original);
    await cleanup();
  }
  await waitFor("4300 to close", () => listening([4300]) === "", 20_000);
});
