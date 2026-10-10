// Z themes and Q composer in the built app, on the recorded Claude stream (fake-claude.mjs): ask from the docked composer,
// read the conversation, / commands and @files, then every theme restyles the whole window, persists and can follow the system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { palette, THEME_IDS, themes } from "@shrike/design";
import { fakeClaude, fixtureCopy, freePort, launch, shot, sleep, todoAskAgent, waitFor } from "./helpers.ts";

const theme = (win: import("playwright").Page) => win.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue("--code-keyword").trim()]);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

test("composer and themes: ask, conversation, / and @, six themes that persist and follow the system", { timeout: 300_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const cc = fakeClaude(150);
  let { app, win, userData, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    // Q1: the composer is always there; ⌘K turns it into the active ask (todoAskAgent drives it like the old pill).
    await todoAskAgent(app, win, web, "When I click Add Todo nothing shows up");
    await win.getByRole("region", { name: "Found it" }).waitFor({ timeout: 60_000 });
    await waitFor("the run to finish", async () => (await win.evaluate(() => window.shrike.listRuns())).some((r) => r.status === "done"), 30_000);
    const composer = win.getByRole("form", { name: "Ask your agent" });
    assert.match((await composer.getByRole("textbox", { name: "Ask your agent" }).getAttribute("placeholder")) ?? "", /Ask Claude about your app/);
    await shot(app, "composer", "tc");

    // Q2: the conversation shows what you said and what the agent answered, steps folded.
    await composer.getByRole("button", { name: /^Conversation, 1 message/ }).click();
    const talk = win.getByRole("region", { name: "Conversation" });
    await talk.getByText("When I click Add Todo nothing shows up").waitFor();
    await talk.getByText(/userId|user/).first().waitFor();
    await talk.getByRole("button", { name: /\d+ steps?/ }).click();
    await shot(app, "conversation", "tc");
    await talk.getByRole("button", { name: "Close conversation" }).click();

    // Q3: / commands and @files live in the composer.
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    const input = ask.getByRole("textbox", { name: "Ask your agent" });
    await input.fill("/");
    await ask.getByRole("listbox", { name: "Commands" }).waitFor();
    await shot(app, "slash", "tc");
    await input.fill("");
    await input.pressSequentially("look at @todos.contr");
    const files = ask.getByRole("listbox", { name: "Files" });
    await files.getByRole("option").first().waitFor();
    await shot(app, "at-files", "tc");
    await input.press("Enter");
    await ask.getByLabel("Context for the agent").getByText(/todos\.controller/).waitFor();
    assert.equal(await input.inputValue(), "look at ");
    await win.keyboard.press("Escape");
    await ask.waitFor({ state: "detached" });
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Z: each theme swaps the tokens at the root; the body, code colours and window all follow.
    await win.getByRole("button", { name: "Appearance" }).click();
    const dlg = win.getByRole("dialog", { name: "Appearance" });
    assert.equal(await dlg.getByRole("radio").count(), THEME_IDS.length);
    await shot(app, "appearance", "tc");
    for (const id of THEME_IDS) {
      await dlg.getByRole("radio", { name: `${themes[id].label} theme` }).click();
      await waitFor(`${id} on the root`, async () => (await theme(win))[1] === rgb(palette(id).color.void), 5000); // reduced motion still runs a 0.01ms transition
      const [on, bg, kw] = await theme(win);
      const p = palette(id);
      assert.deepEqual([on, bg, kw], [id, rgb(p.color.void), p.code.keyword], id);
      await win.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      await sleep(300); // capturePage takes the last composited frame
      await shot(app, `theme-${id}`, "tc");
      await win.getByRole("button", { name: "Appearance" }).click();
    }
    await dlg.getByRole("radio", { name: "Tokyo theme" }).click();
    // Match system: Daylight when light, the last dark pick (Tokyo) when dark.
    await dlg.getByRole("checkbox", { name: /Match system/ }).check();
    await win.emulateMedia({ colorScheme: "light" });
    await waitFor("Daylight for a light system", async () => (await theme(win))[0] === "daylight", 5000);
    await win.emulateMedia({ colorScheme: "dark" });
    await waitFor("Tokyo for a dark system", async () => (await theme(win))[0] === "tokyo", 5000);
    await dlg.getByRole("radio", { name: "Mocha theme" }).click(); // a hand pick turns Match system off
    assert.equal(await dlg.getByRole("checkbox", { name: /Match system/ }).isChecked(), false);

    // Persisted across a relaunch.
    await app.close();
    ({ app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env }, userData));
    await waitFor("the saved theme after relaunch", async () => (await theme(win))[0] === "mocha", 15_000);
  } finally {
    await cleanup();
    rmSync(userData, { recursive: true, force: true });
    cc.remove();
    rmSync(dirname(proj), { recursive: true, force: true });
  }
});
