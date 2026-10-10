// M1–M6 in the built app with a recorded Claude Code stream (fake-options.mjs, for real over ask_options): "Show me options" on the
// Ask pill, three mockup cards in sandboxed iframes, enlarge, More like this on B, combine B2 + C across rounds, approve; the approved
// mockup sits next to the patch, Apply builds it, and design-taste learns it into the project's .shrike/skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AgentRunInfo, OptionsSession } from "@shrike/schema";
import { dismissResult, fakeClaude, fixtureCopy, freePort, launch, openFolder, questReady, shot, sleep, waitFor } from "./helpers.ts";

const P = "m-options";
const sessions = (win: Page) => win.evaluate(() => window.shrike.getOptions()) as Promise<OptionsSession[]>;
const runs = (win: Page) => win.evaluate(() => window.shrike.listRuns()) as Promise<AgentRunInfo[]>;

test("options: three mockups, more like B, combine B2 + C, approve, attached to the run and learned", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const cc = fakeClaude(150);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env });
  const board = win.getByRole("dialog", { name: /^Options: How should the todo header look\?/ });
  const errs: string[] = [];
  win.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  win.on("pageerror", (e) => errs.push(e.message));
  const diag = async (e: Error): Promise<never> => {
    await shot(app, "fail", P);
    const r = (await runs(win)).at(-1);
    const steps = r ? await win.evaluate((id) => window.shrike.getRunSteps(id), r.id) : [];
    throw new Error(`${e.message}\n${JSON.stringify({ errs, sessions: (await sessions(win)).map((x) => [x.state, x.waiting, x.last, x.rounds.map((y) => y.cards)]), steps: steps.slice(-6).map((x) => [x.kind, x.tool, x.text]) }, null, 1)}`);
  };
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    await dismissResult(win, 2000);

    // M6: Show me options on the Ask pill
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    await ask.waitFor();
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("button", { name: "Show me options" }).click();
    assert.equal(await ask.getByRole("button", { name: "Show me options" }).getAttribute("aria-pressed"), "true");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("Make the todo header look better");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    const call = await waitFor("the options run", () => cc.calls().find((c) => c.kind === "options"), 30_000);
    assert.match(call.goal, /answer with ask_options/, "the toggle asks for cards");

    // M2: three cards, live mockups in sandboxed iframes
    await board.waitFor({ timeout: 30_000 }).catch(diag);
    const cards = board.locator("article.opt-card");
    await waitFor("three cards", async () => (await cards.count()) === 3, 10_000);
    assert.deepEqual(await cards.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), ["Option A: Quiet", "Option B: Colour band", "Option C: Centred"]);
    const frame = await board.locator(".opt-frame iframe").first().evaluate((f) => ({ sandbox: f.getAttribute("sandbox"), csp: (f.getAttribute("srcdoc") ?? "").includes("default-src 'none'"), same: f.getAttribute("sandbox")?.includes("allow-same-origin") ?? false }));
    assert.deepEqual(frame, { sandbox: "", csp: true, same: false }, "no scripts, no same-origin, CSP first");
    const run = (await runs(win)).at(-1)!;
    const s0 = (await sessions(win)).at(-1)!;
    assert.equal(s0.runId, run.id, "the session belongs to the run that asked");
    await sleep(600); // srcdoc paints
    await shot(app, "cards-row", P);

    // M2: enlarge, arrows move, Esc back
    await board.getByRole("button", { name: "Enlarge A" }).click();
    await board.getByRole("dialog", { name: "Option A enlarged" }).waitFor();
    await win.keyboard.press("ArrowRight");
    await board.getByRole("dialog", { name: "Option B enlarged" }).waitFor();
    await board.getByRole("dialog", { name: "Option B enlarged" }).getByRole("radio", { name: "desktop" }).click();
    await sleep(400);
    await shot(app, "enlarged", P);
    await win.keyboard.press("Escape");
    await board.getByRole("dialog", { name: "Option B enlarged" }).waitFor({ state: "detached" });

    // M3: More like this on B -> a child row under B
    await board.getByRole("article", { name: "Option B: Colour band" }).getByRole("button", { name: "More like this" }).click();
    await waitFor("B's variations", async () => (await cards.count()) === 3 && (await cards.first().getAttribute("aria-label")) === "Option B1: Band, deep blue", 30_000).catch(diag);
    assert.deepEqual(await board.getByRole("navigation", { name: "History" }).getByRole("button").allInnerTexts(), ["ROUND 1", "MORE LIKE B"]);
    await board.locator('[data-parent="B"]').waitFor();
    assert.ok((await board.locator(".opt-links path").count()) >= 3, "connectors from B to each child");
    await sleep(500);
    await shot(app, "variation-tree", P);

    // M3: combine B2 + C (picked across rounds), with what to take from each
    await board.getByRole("article", { name: "Option B2: Band, tall title" }).getByRole("button", { name: "Add to combine" }).click();
    await board.getByRole("button", { name: "Round 1" }).click();
    await board.getByRole("article", { name: "Option C: Centred" }).getByRole("button", { name: "Add to combine" }).click();
    await board.getByRole("textbox", { name: "What to take from each" }).fill("header from B2, layout from C");
    await shot(app, "combine-picks", P);
    await board.getByRole("button", { name: "Combine B2 + C" }).click();
    await board.getByRole("article", { name: "Option B2+C: Tall band, centred" }).waitFor({ timeout: 30_000 });
    assert.equal(await board.locator("[data-parent]").count(), 2, "the merge hangs from both parents");
    assert.deepEqual(await board.getByRole("navigation", { name: "History" }).getByRole("button").allInnerTexts(), ["ROUND 1", "MORE LIKE B", "B2 + C"]);
    await sleep(500);
    await shot(app, "combine", P);

    // M4: approve -> the patch card shows the approved mockup beside the diff
    await board.getByRole("article", { name: "Option B2+C: Tall band, centred" }).getByRole("button", { name: "Approve this" }).click();
    await board.waitFor({ state: "detached", timeout: 10_000 });
    const fix = win.getByRole("region", { name: "Fix" });
    await fix.waitFor({ timeout: 30_000 });
    const attached = fix.getByRole("region", { name: "Approved mockup" });
    await attached.waitFor();
    assert.match(await attached.innerText(), /B2\+C/);
    const s1 = (await sessions(win)).find((s) => s.id === s0.id)!;
    assert.equal(s1.state, "approved");
    assert.deepEqual(s1.approved, ["B2+C"]);
    assert.equal(s1.runId, run.id, "the approved mockup stays attached to the run");
    await sleep(500);
    await shot(app, "approved", P);
    await attached.getByRole("button", { name: "Compare with what was built" }).click();
    await win.getByRole("dialog", { name: "What you approved" }).waitFor();
    await sleep(400);
    await shot(app, "compare", P);
    await win.keyboard.press("Escape");

    // build it, then M5: the run ends with a skill (design-taste learned into the project)
    await fix.getByRole("button", { name: /Apply fix/ }).click();
    await waitFor("the run to end", async () => (await runs(win)).find((r) => r.id === run.id)?.status === "done", 60_000);
    assert.match(readFileSync(join(proj, "src/App.tsx"), "utf8"), /<h1>Today<\/h1>/, "the approved header was built");
    const taste = join(proj, ".shrike", "skills", "design-taste.md");
    await waitFor("design-taste to level up in the project", () => existsSync(taste), 20_000);
    const text = readFileSync(taste, "utf8");
    assert.match(text, /^version: 2$/m);
    assert.match(text, /bold band of the accent colour/);
    assert.match(text, /v2: likes a bold colour band with a big centred title/);
    await sleep(800);
    await shot(app, "learned", P);
  } finally {
    await cleanup();
    cc.remove();
  }
});
