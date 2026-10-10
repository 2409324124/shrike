// B1–B3 and sessions in the built app on a todo-app copy (random ports): record a click flow, replay it with the
// ghost cursor, Keep watching on save turns red when the planted bug comes back, Pick up where you left off after a
// relaunch. Then a request flow on an api-only copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ActionView, Flow } from "@shrike/schema";
import { fixtureCopy, freePort, key, launch, listening, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const flows = (win: Page) => win.evaluate(() => window.shrike.listFlows()) as Promise<Flow[]>;
const trips = async (win: Page) => ((await win.evaluate(() => window.shrike.getActions())) as ActionView[]).filter((a) => a.complete && a.id !== "0".repeat(16));

const PLANTED = "insertTodo({ title, userId: req.body.user });";
const FIXED = "insertTodo({ title, userId: req.body.userId });";

test("flows: record a click flow, replay with the ghost cursor, Keep watching turns red, pick up after relaunch", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const controller = join(proj, "server", "todos.controller.ts");
  writeFileSync(controller, readFileSync(controller, "utf8").replace(PLANTED, FIXED)); // start green; the bug comes back later
  let { app, win, userData, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    const guest = await waitFor("the todo app in the app pane", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    await sleep(1000);

    // B1: record typing and a click.
    await key(win, "w");
    const shelf = win.getByRole("region", { name: "Flows" });
    await shelf.waitFor();
    await shelf.getByRole("button", { name: "Record a flow" }).click();
    const bar = win.getByRole("status", { name: "Recording a flow" });
    await bar.waitFor();
    const input = guest.getByPlaceholder("What needs doing?");
    await input.click();
    await guest.keyboard.type("buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    await waitFor("two steps on the bar", async () => /2 steps/.test((await bar.textContent()) ?? ""), 15_000);
    await shot(app, "flows-01-recording", "v5");
    await bar.getByRole("button", { name: "Stop" }).click();
    await bar.getByRole("textbox", { name: "Name this flow" }).fill("Add a todo");
    await bar.getByRole("button", { name: "Save" }).click();
    await bar.waitFor({ state: "detached" });
    const flow = JSON.parse(readFileSync(join(proj, ".shrike/flows/add-a-todo.json"), "utf8")) as Flow;
    assert.deepEqual(flow.steps.filter((s) => s.type !== "navigate").map((s) => s.type), ["type", "click"]);
    assert.equal(flow.steps.find((s) => s.type === "type")?.text, "buy milk");

    // B2: replay; the ghost cursor shows in the app, and the trips land green.
    if (!(await shelf.isVisible())) await key(win, "w");
    const card = shelf.locator('[data-flow="add-a-todo"]');
    const before = (await trips(win)).length;
    await card.getByRole("button", { name: "Run" }).click();
    await waitFor("the ghost cursor over the app", () => win.locator(".agent-cursor").count(), 20_000);
    await shot(app, "flows-02-replay-ghost", "v5");
    await waitFor("the replay to finish green", async () => (await flows(win)).find((f) => f.id === "add-a-todo")?.lastRun?.ok === true, 60_000);
    assert.ok((await trips(win)).length > before, "the replay made trips");
    await sleep(500);
    await shot(app, "flows-03-replayed", "v5");

    // B3: Keep watching on every save; putting the planted bug back turns the flow red.
    if (!(await shelf.isVisible())) await key(win, "w");
    await card.getByRole("combobox", { name: "Keep watching Add a todo" }).selectOption({ label: "On every save" });
    await waitFor("watch saved", async () => (await flows(win)).find((f) => f.id === "add-a-todo")?.watch?.mode === "save");
    writeFileSync(controller, readFileSync(controller, "utf8").replace(FIXED, PLANTED));
    await waitFor("the watched flow to turn red", async () => (await flows(win)).find((f) => f.id === "add-a-todo")?.lastRun?.ok === false, 90_000);
    await sleep(800);
    await shot(app, "flows-04-watch-red", "v5");
    await card.getByRole("combobox", { name: "Keep watching Add a todo" }).selectOption({ index: 0 }); // stop watching before quitting
    await key(win, "Escape");

    // Sessions: quit, relaunch on the same data, pick up where you left off.
    await sleep(2500); // the session is saved every second
    const count = (await trips(win)).length;
    assert.ok(count >= 3);
    await app.close();
    ({ app, win } = await launch({}, userData));
    const pick = win.getByRole("button", { name: /Pick up where you left off/ });
    await pick.waitFor({ timeout: 20_000 });
    assert.match(await pick.innerText(), new RegExp(`${count} trips`));
    await sleep(400);
    await shot(app, "flows-05-pickup", "v5");
    await pick.click();
    await waitFor("trips restored", async () => (await trips(win)).length === count, 20_000);
    await sleep(1200);
    await shot(app, "flows-06-restored", "v5");
  } finally {
    await app.close().catch(() => {});
    await cleanup();
    rmSync(userData, { recursive: true, force: true });
  }
  assert.equal(listening([web, api]), "", "ports free");
});

test("flows: a request flow on api-only (explorer requests while recording; the 409 bug is red)", { timeout: 300_000 }, async () => {
  const port = await freePort();
  const proj = fixtureCopy("api-only", { ports: { 4300: port } });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("dialog", { name: "Set up api-only" }).getByRole("button", { name: "Run", exact: true }).click();
    await waitFor("the api to answer", async () => (await fetch(`http://localhost:${port}/health`).catch(() => null))?.ok, 60_000);
    await sleep(800);
    await key(win, "w");
    const shelf = win.getByRole("region", { name: "Flows" });
    await shelf.getByRole("button", { name: "Record a flow" }).click();
    const bar = win.getByRole("status", { name: "Recording a flow" });
    await bar.waitFor();
    if (await shelf.isVisible()) await key(win, "Escape");
    await win.getByRole("button", { name: /Open the API explorer/ }).click();
    const sheet = win.getByRole("region", { name: "API client" });
    const send = async (method: string, url: string, body?: string) => {
      await sheet.getByRole("combobox", { name: "Method" }).selectOption(method);
      await sheet.getByRole("textbox", { name: "URL", exact: true }).fill(url);
      if (body) {
        await sheet.getByRole("tab", { name: /^Body/ }).click();
        await sheet.getByRole("textbox", { name: "Body" }).fill(body);
      }
      await sheet.getByRole("button", { name: "Send", exact: true }).click();
      await sleep(800);
    };
    await send("POST", "/v1/users", JSON.stringify({ email: "sam@example.com", name: "Sam Rivera" }));
    await send("GET", "/v1/users");
    await waitFor("two request steps", async () => /2 steps/.test((await bar.textContent()) ?? ""));
    await shot(app, "flows-07-api-recording", "v5");
    await bar.getByRole("button", { name: "Stop" }).click();
    await bar.getByRole("textbox", { name: "Name this flow" }).fill("Create Sam");
    await bar.getByRole("button", { name: "Save" }).click();
    const saved = JSON.parse(readFileSync(join(proj, ".shrike/flows/create-sam.json"), "utf8")) as Flow;
    assert.deepEqual(saved.steps.map((s) => `${s.type} ${s.request?.method} ${s.request?.url}`), ["request POST /v1/users", "request GET /v1/users"]);
    await win.evaluate(() => window.shrike.saveFlow("Create Sam (capital)", [{ type: "request", request: { method: "POST", url: "/v1/users", body: JSON.stringify({ email: "Sam@Example.com", name: "Sam Rivera" }) } }]));
    assert.equal((await win.evaluate(() => window.shrike.runFlow("create-sam"))).ok, true);
    assert.equal((await win.evaluate(() => window.shrike.runFlow("create-sam-capital"))).ok, false, "the planted case bug answers 409");
    if (await sheet.isVisible()) await key(win, "Escape");
    if (!(await shelf.isVisible())) await key(win, "w");
    await waitFor("both cards", async () => (await shelf.locator("[data-flow]").count()) === 2);
    await sleep(600);
    await shot(app, "flows-08-api-shelf", "v5");
  } finally {
    await cleanup();
  }
  assert.equal(listening([port]), "", "port free");
});
