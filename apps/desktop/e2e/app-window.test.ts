// AW1: the user's app pops out into its own window with the same recording, and docks back. Run `pnpm build` first. Uses ports 5173/3001.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { addTodoAction, launch, listening, openSampleAndRun, SHOTS, sleep, tripDom, typeTodo, waitFor } from "./helpers.ts";

const appWindow = (app: ElectronApplication) => waitFor("the app window", () => app.windows().find((p) => p.url().endsWith("#app-window")), 15_000);
const appGuest = (app: ElectronApplication, not?: Page) => waitFor("the app page", () => app.windows().find((p) => p.url().startsWith("http://localhost:5173") && p !== not && !p.isClosed()), 30_000);
const bounds = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#app-window"))?.getBounds());

// helpers' shot() takes the first visible window, which may be the app window here.
async function shotOf(app: ElectronApplication, name: string, appWin = false): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }, appWin) => (await BrowserWindow.getAllWindows().find((w) => !w.getParentWindow() && w.webContents.getURL().endsWith("#app-window") === appWin)!.webContents.capturePage()).toPNG().toString("base64"), appWin);
  writeFileSync(join(SHOTS, `v5-e2e-${name}.png`), Buffer.from(b64, "base64"));
}

test("app window: pop out, record a trip from it, point, dock back, reopen where it was", { timeout: 300_000 }, async () => {
  assert.equal(listening([5173, 3001]), "", "todo ports must be free");
  const { app, win, userData, cleanup } = await launch();
  try {
    const docked = await openSampleAndRun(app, win);
    await win.getByRole("button", { name: "Open your app in its own window (O)" }).click();
    const aw = await appWindow(app);
    await waitFor("the docked page to close", () => docked.isClosed(), 15_000);
    const guest = await appGuest(app, docked);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    await win.getByRole("button", { name: /Your app is in its own window/ }).waitFor();
    assert.equal(await win.locator("section[aria-label='Your app'] webview").count(), 0, "one copy of the app runs, in the window");

    // The trip from the detached window lands on the Thread.
    const t0 = Date.now();
    await typeTodo(guest, "from the window");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const trip = await addTodoAction(win, t0);
    await waitFor("the trip on the Thread", () => tripDom(win, trip.id), 15_000);
    await sleep(600);
    await shotOf(app, "app-window-01-main-detached");
    await shotOf(app, "app-window-02-window", true);

    // Point mode from the window's header.
    await aw.getByRole("button", { name: "Point at something in your app" }).click();
    await guest.getByRole("button", { name: "Add Todo" }).hover();
    await waitFor("the hover label", async () => (await guest.locator('[data-shrike-point="tag"]').textContent()) === "button · Add Todo", 5000);
    await guest.getByRole("button", { name: "Add Todo" }).click();
    await win.getByRole("dialog", { name: "Ask your agent" }).waitFor();
    await waitFor("point mode to end", async () => (await aw.getByRole("button", { name: "Point at something in your app" }).getAttribute("aria-pressed")) === "false", 5000);
    await shotOf(app, "app-window-03-pointed", true);

    // Move it, dock back: the place is saved and the app is back in the dock.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#app-window"))!.setBounds({ x: 120, y: 140, width: 900, height: 640 }));
    const moved = await bounds(app);
    await aw.getByRole("button", { name: /Dock back/ }).click();
    await waitFor("the app window to close", () => aw.isClosed(), 10_000);
    await win.getByRole("button", { name: /Your app is in its own window/ }).waitFor({ state: "detached" });
    const back = await appGuest(app, guest);
    await back.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const saved = JSON.parse(readFileSync(join(userData, "app-window.json"), "utf8"));
    assert.deepEqual(saved.bounds, moved);
    assert.equal(saved.fullScreen, false);
    await shotOf(app, "app-window-04-docked-back");

    // O pops it out again where it was; closing the window docks it back.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Escape");
    await win.keyboard.press("o");
    const again = await appWindow(app);
    assert.deepEqual(await bounds(app), moved);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("#app-window"))!.close());
    await waitFor("the app window to close", () => again.isClosed(), 10_000);
    await appGuest(app, back);
    await win.getByRole("button", { name: /Your app is in its own window/ }).waitFor({ state: "detached" });
  } finally {
    await cleanup();
  }
});
