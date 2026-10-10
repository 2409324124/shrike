// FV in the built app on a todo-app copy (random ports): the failing Add Todo trip, the Thread | Files toggle, stepping
// forward through the folders to the failing line (todos.controller.ts:18), back again, a dive, and V back to the Thread
// on the same step. Run `pnpm build` first (or SHRIKE_E2E_APP=<a build kept apart from out/>).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { themes, type ThemeId } from "@shrike/design";
import { setSize, setTheme } from "./layout.ts";
import { addTodoAction, dismissResult, fixtureCopy, freePort, key, launch, openFolder, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

const stepText = (win: Page) => win.locator(".fm p.th-sr").innerText();
const stepNo = async (win: Page) => Number(/Step (\d+) of/.exec(await stepText(win))?.[1] ?? 0);
const focusCard = (win: Page) => win.locator(".fm-card.focus").getAttribute("data-key");

test("files view: toggle, step forward to todos.controller.ts:18 and back, V returns to the Thread on the same step", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    const guest = await waitFor("the todo app in the app pane", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 120_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    await sleep(1000);
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broke = await addTodoAction(win);
    assert.equal(broke.status, "error");
    await win.locator(`.th-trip[data-trip="${broke.id}"]`).waitFor();
    await dismissResult(win, 4000);
    await sleep(2500); // the arrival plays and lands on the failure
    await shot(app, "01-thread", "fv");

    // The toggle sits at the top of the stage; the Thread is the default.
    const toggle = win.getByRole("group", { name: "View" });
    assert.equal(await toggle.getByRole("button", { name: "THREAD" }).getAttribute("aria-pressed"), "true");
    await toggle.getByRole("button", { name: "FILES" }).click();
    await win.locator(".fm").waitFor();
    assert.equal(await win.locator(".th-stage:not([hidden])").count(), 0, "the Thread's stage steps aside");
    await waitFor("the tree slice", async () => (await win.locator(".fm-row").count()) > 3, 15_000);
    await sleep(1500);
    await shot(app, "02-files-on-the-failure", "fv");
    const landed = await stepNo(win);
    assert.equal(await focusCard(win), "server/todos.controller.ts", "Files opens on the step the Thread was on");

    // Home: the click. The tree shows only src/ open; server/ is a collapsed row with a badge.
    await key(win, "Home");
    await sleep(1500);
    assert.equal(await stepNo(win), 1);
    assert.equal(await focusCard(win), "src/TodoForm.tsx");
    assert.equal(await win.locator('.fm-row[aria-expanded="true"]', { hasText: /^server/ }).count(), 0, "server/ is closed at the click");
    assert.ok(await win.locator(".fm-row", { hasText: ".gitignore" }).count(), "dotfiles are in the tree");
    await shot(app, "03-home-the-click", "fv");

    // Forward, step by step, until the failing line.
    const seen: string[] = [];
    for (let i = 0; i < 12 && !/insertTodo\(\) in server\/todos\.controller\.ts, line 18/.test(await stepText(win)); i++) {
      await key(win, "ArrowRight");
      await sleep(1300);
      seen.push(`${await stepNo(win)} ${await focusCard(win)}`);
      await shot(app, `04-forward-${String(i).padStart(2, "0")}`, "fv");
    }
    assert.equal(await focusCard(win), "server/todos.controller.ts", seen.join("\n"));
    const card = win.locator(".fm-card.focus");
    assert.match(await card.locator(".fm-ln.lv").innerText(), /^18\s*const todo = insertTodo/);
    assert.ok(await card.locator(".livebar.err").count(), "the line is lit red");
    assert.match(await card.locator(".fm-chip.err").innerText(), /userId: undefined/);
    assert.match(await win.locator(".fm .crumb").innerText(), /server\s*›\s*todos\.controller\.ts\s*›\s*insertTodo\(\) L18/);
    assert.ok(await win.locator(".fm-row.hot.err", { hasText: "todos.controller.ts" }).count(), "its tree row is hot and red");
    assert.ok(await win.locator(".fm .stack .fr.cur", { hasText: "todos.controller.ts:18" }).count(), "the call stack ends at L18");
    const at18 = await stepNo(win);
    assert.equal(at18, landed, "the failing line is the step the Thread landed on");
    await shot(app, "05-the-failing-line", "fv");

    // Only 2D moves: nothing rotates, no CSS 3D.
    const transforms = await win.locator(".fm-plane").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform).join(" "));
    assert.doesNotMatch(transforms, /rotate|perspective|matrix3d|translateZ/);

    // Enter lifts the section; Esc surfaces.
    await key(win, "Enter");
    const dive = win.locator(".fm-dive");
    await dive.waitFor();
    assert.match(await dive.locator(".dl.live").innerText(), /^18/);
    await sleep(800);
    await shot(app, "06-dive", "fv");
    await key(win, "Escape");
    await dive.waitFor({ state: "detached" });

    // Back one step: the log line on L16, same card, the camera stays.
    await key(win, "ArrowLeft");
    await sleep(1300);
    assert.equal(await stepNo(win), at18 - 1);
    assert.equal(await focusCard(win), "server/todos.controller.ts");
    assert.match(await stepText(win), /line 16/);
    await shot(app, "07-back-one", "fv");
    // Forward again: back on L18. Every theme, a small window, and Calm (no motion: the step is a cut).
    await key(win, "ArrowRight");
    await sleep(1300);
    for (const id of Object.keys(themes) as ThemeId[]) {
      await setTheme(win, id);
      await sleep(500);
      await shot(app, `09-theme-${id}`, "fv");
    }
    await setTheme(win, "abyss");
    await setSize(app, { w: 1100, h: 700 });
    await sleep(1200);
    assert.ok(await win.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll at 1100x700");
    const fit = await win.evaluate(() => {
      const s = document.querySelector(".fm")!.getBoundingClientRect();
      const c = document.querySelector(".fm-card.focus")!.getBoundingClientRect();
      const f = document.querySelector(".fm-card.focus .facts")!.getBoundingClientRect();
      const cap = document.querySelector("[data-caption] p")!.getBoundingClientRect();
      return { left: c.left >= s.left, right: c.right <= s.right, facts: f.bottom <= cap.top + 1 };
    });
    assert.deepEqual(fit, { left: true, right: true, facts: true }, "at 1100x700 the card fits the stage and its facts sit above the caption");
    await shot(app, "10-small-window", "fv");
    await key(win, "Escape"); // the folded tree comes back
    await sleep(900);
    assert.ok(await win.locator(".fm-row.hot", { hasText: "todos.controller.ts" }).isVisible());
    await shot(app, "10b-small-window-tree", "fv");
    await key(win, "Enter");
    await sleep(600);
    await setSize(app, { w: 1600, h: 1000 });
    await win.emulateMedia({ reducedMotion: "reduce" });
    await key(win, "ArrowLeft");
    await sleep(80);
    await shot(app, "11-calm-cut", "fv");
    assert.equal(await stepNo(win), at18 - 1, "under reduced motion the step lands at once");
    await key(win, "ArrowRight");
    await sleep(300);

    // V: the Thread on the same step.
    await key(win, "v");
    await win.locator(".th-stage:not([hidden])").waitFor();
    assert.equal(await win.locator(".fm").count(), 0);
    assert.equal(await win.locator(`.th-trip[data-trip="${broke.id}"] .th-st.focus`).getAttribute("data-i"), String(at18 - 1));
    await sleep(1200);
    await shot(app, "08-v-back-to-thread", "fv");
  } finally {
    await cleanup();
  }
});
