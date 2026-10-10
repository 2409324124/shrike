// AP15 to AP19 in the built app on a todo-app copy (random ports): the failing Add Todo trip, Edit and resend with a
// corrected body, the new trip passes right under the old one with Compare, Save as test, and the flow replays it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionView, Flow } from "@shrike/schema";
import { actions, addTodoAction, dismissResult, fixtureCopy, freePort, launch, listening, openFolder, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

test("api superpowers: edit and resend a broken trip, compare, save as test, replay", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    const guest = await waitFor("the todo app in the app pane", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    await sleep(1000);

    // The planted bug: the page sends userId, the server reads user, Add Todo breaks.
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broke = await addTodoAction(win);
    assert.equal(broke.status, "error");
    const oldTrip = win.locator(`section[data-trip="${broke.id}"]`);
    await oldTrip.waitFor();
    await dismissResult(win, 3000);
    await sleep(1500);

    // AP1 + AP16: Edit and resend opens the captured request; fix the body and send.
    await oldTrip.getByRole("button", { name: "Edit and resend" }).click();
    const sheet = win.getByRole("region", { name: "API client" });
    assert.equal(await sheet.getByRole("combobox", { name: "Method" }).inputValue(), "POST");
    await sheet.getByRole("tab", { name: /^Body/ }).click();
    const body = sheet.getByRole("textbox", { name: "Body" });
    await waitFor("the captured body in the editor", async () => /"userId":\s*1/.test(await body.inputValue()), 10_000);
    await shot(app, "ap-01-edit-and-resend", "v5");
    await body.fill(JSON.stringify({ title: "buy milk", user: 1 }));
    await sheet.getByRole("button", { name: "Send", exact: true }).click();
    const fixed = await waitFor("the resend's trip", async () => (await actions(win)).find((a: ActionView) => a.root.resendOf === broke.id && a.complete), 20_000);
    assert.equal(fixed.status, "ok");
    await sleep(800);
    await shot(app, "ap-02-resent", "v5");
    // Save through real IPC: a top-level save passes folder undefined, which the browser mock never validated.
    await sheet.getByRole("button", { name: "Save (⌘S)" }).click();
    await waitFor("the saved request", () => existsSync(join(proj, ".shrike", "api")) && readdirSync(join(proj, ".shrike", "api"), { recursive: true }).some((f) => String(f).endsWith(".bru")), 10_000);
    await win.keyboard.press("Escape");
    await sleep(400);

    // The new trip sits right under the old one, and Compare says what changed.
    const order = await win.locator("section[data-trip]").evaluateAll((els) => els.map((e) => e.getAttribute("data-trip")));
    assert.equal(order[order.indexOf(broke.id) + 1], fixed.id, "the resend is right under the trip it edited");
    await win.locator(`nav[aria-label="Trips"] button[data-trip="${fixed.id}"]`).click(); // focus it like a person
    const newTrip = win.locator(`section[data-trip="${fixed.id}"]`);
    await sleep(800);
    await newTrip.getByRole("button", { name: "Compare" }).click();
    const diff = newTrip.getByRole("list", { name: "What changed since the trip you edited" });
    await diff.waitFor();
    const lines = await diff.innerText();
    assert.match(lines, /body\.userId: 1 → missing/);
    assert.match(lines, /body\.user: missing → 1/);
    assert.match(lines, /Answered 500, now 201\./);
    await sleep(300);
    await shot(app, "ap-03-compare", "v5");

    // AP17 + AP19: Save as test writes a flow step with the status row; the first one says so.
    await newTrip.getByRole("button", { name: "Save as test" }).click();
    const file = await waitFor("the test flow", () => readdirSync(join(proj, ".shrike", "flows")).find((f) => f.endsWith(".json")), 10_000);
    const flow = JSON.parse(readFileSync(join(proj, ".shrike", "flows", file), "utf8")) as Flow;
    assert.equal(flow.steps.length, 1);
    assert.deepEqual(flow.steps[0]!.assert, [{ expr: "res.status", op: "eq", value: "201", enabled: true }]);
    assert.equal(flow.steps[0]!.request?.body, JSON.stringify({ title: "buy milk", user: 1 }));
    await win.getByRole("status", { name: /^Request Saved: / }).waitFor({ timeout: 30_000 }); // waits behind any skill window
    await shot(app, "ap-04-request-saved", "v5");

    // The flow replays the API check and passes; the first pass says so once.
    const r = await win.evaluate((id) => window.shrike.runFlow(id), flow.id);
    assert.equal(r.ok, true);
    await win.getByRole("status", { name: /^Assertion Passed: / }).waitFor({ timeout: 30_000 });
    await shot(app, "ap-05-assertion-passed", "v5");
    assert.equal((await win.evaluate((id) => window.shrike.runFlow(id), flow.id)).ok, true);
    await sleep(4500);
    assert.equal(await win.getByRole("status", { name: /^Assertion Passed: / }).count(), 0, "no second window");
  } finally {
    await cleanup();
  }
  assert.equal(listening([web, api]), "", "ports free");
});
