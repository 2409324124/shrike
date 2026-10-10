// X1–X7 in the built app with a recorded Claude Code stream (fake-claude.mjs): the live activity line, file chips that open
// the in-app file view, the thinking strip, the skill chip, tokens per turn and the run total, the context map from the
// fuel ring (its segments add up to the context in use), and race cards that show the same X-ray while they work.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentUsage, ContextMap, Race } from "@shrike/schema";
import { fakeClaude, fixtureCopy, gitIn, launch, listening, shot, sleep, todoAskAgent, waitFor } from "./helpers.ts";

/** Two ports, free along with their +100 and +200 worktree shifts. */
function freePair(): [number, number] {
  for (let i = 0; i < 50; i++) {
    const b = 22000 + Math.floor(Math.random() * 2000) * 10;
    if (!listening([0, 100, 200].flatMap((o) => [b + o, b + 1 + o]))) return [b, b + 1];
  }
  throw new Error("no free ports");
}

const tokens = (t: string) => {
  const m = /([\d.]+)(k|m)?/i.exec(t); // labels may be shown in caps
  return m ? Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1000 : m[2] ? 1e6 : 1) : NaN;
};

test("x-ray: activity, file chips open the file view, thinking, skill, tokens, context map, race cards", { timeout: 900_000 }, async () => {
  const [web, api] = freePair();
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const cc = fakeClaude(450);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env });
  const pill = win.locator('aside[aria-label="Agent"]');
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await win.evaluate(() => {
      (window as any).__usage = [];
      window.shrike.on("agent:usage", (u) => (window as any).__usage.push(u));
    });
    const broken = await todoAskAgent(app, win, web, "When I click Add Todo nothing shows up");

    // X1: the activity line names what it is doing, live.
    const seen = new Set<string>();
    const found = win.getByRole("region", { name: "Found it" });
    let shotLive = false;
    await waitFor("FOUND IT, watching the activity line", async () => {
      const t = await pill.locator(".xr-activity").first().innerText({ timeout: 300 }).catch(() => "");
      if (t) seen.add(t.trim());
      if (!shotLive && /Reading todos\.controller\.ts/.test(t)) {
        shotLive = true;
        await pill.hover();
        await sleep(250);
        await shot(app, "xray-live", "v6");
        await win.mouse.move(5, 500);
      }
      return found.isVisible();
    }, 90_000);
    console.log("activity seen:", [...seen].join(" | "));
    assert.ok([...seen].some((t) => /^Reading todos\.controller\.ts lines 14-20$/.test(t) || /^Read todos\.controller\.ts lines 14 to 20$/.test(t)), "a file read with its target");
    assert.ok([...seen].some((t) => /^Searching for userId$/.test(t)), "a search with its query");
    const main = await waitFor("main's session", () => cc.calls().find((c) => c.kind === "main"));
    await waitFor("main to finish", () => cc.finished(main.session), 30_000);
    await sleep(800);
    const runId = (await win.evaluate(() => window.shrike.listRuns())).find((r) => !r.parentRunId)!.id;
    const ring = (await win.evaluate(() => (window as any).__usage as AgentUsage[])).filter((u) => u.runId === runId).at(-1)!;

    // X3, X4: thinking strip collapsed to one line, opens to the latest reasoning; the skill chip is lit.
    await pill.hover();
    const thinking = pill.locator(".xr-thinking button");
    await thinking.waitFor();
    assert.equal(await thinking.getAttribute("aria-expanded"), "false");
    await thinking.click();
    await pill.locator(".xr-thinking p").getByText("The names differ: user vs userId").waitFor();
    assert.match(await pill.locator(".xr-skill").innerText(), /bad value/i);

    // X6: tokens on each turn, the most expensive one marked, and a run total that matches the fuel ring's output.
    const perTurn = await pill.locator("ol li .xr-tokens").count();
    assert.ok(perTurn >= 1, "tokens on the shown turns");
    const total = await pill.locator("p.xr-tokens").innerText();
    assert.match(total, new RegExp(`\\b${ring.outputTokens} out\\b`), `run total (${total}) shows the ring's ${ring.outputTokens} output tokens`);
    assert.match(total, /\$0\.\d{3}/, "and the run's cost");
    await shot(app, "xray-pill", "v6");

    // X2: file chips: read / searched / changed, ranges on hover, click opens the file view there.
    const chip = pill.getByRole("button", { name: /todos\.controller\.ts.*Open it$/ });
    const label = (await chip.getAttribute("aria-label")) ?? "";
    assert.match(label, /read once \(lines 14-20\)/, label);
    assert.match(label, /searched once \(line 18\)/, label);
    await chip.click();
    const fv = win.locator(".fv");
    await fv.waitFor({ timeout: 5000 });
    assert.match(await fv.locator(".fv-head").innerText(), /server\/todos\.controller\.ts[\s\S]*:14/i);
    await win.keyboard.press("Escape");
    await fv.waitFor({ state: "detached" });

    // X5: the fuel ring opens the context map; the segments add up to the context in use.
    await win.locator(".fuel-ring").click();
    const panel = win.getByRole("region", { name: "What fills your agent's context" });
    await panel.waitFor();
    const map = (await win.evaluate((id) => window.shrike.getContextMap(id), runId)) as ContextMap;
    const sum = map.segments.reduce((a, s) => a + s.tokens, 0);
    console.log("context map:", map.segments.map((s) => `${s.label}=${s.tokens}${s.estimated ? "~" : ""}`).join(" | "), "total", map.totalTokens, "ring", ring.contextTokens);
    assert.equal(sum, map.totalTokens, "segments sum to the map's total");
    assert.ok(Math.abs(map.totalTokens - (ring.contextTokens ?? 0)) <= 2, `the map's total ${map.totalTokens} is the ring's ${ring.contextTokens} within rounding`);
    for (const l of ["Your question", "Shrike's instructions and tools", "todos.controller.ts", "Code search results", "Its own words", "Bad value"]) assert.ok(map.segments.some((s) => s.label === l), `segment ${l}`);
    const more = panel.getByRole("button", { name: /^Show \d+ more$/ });
    if (await more.count()) await more.click();
    const rows = await panel.locator("li").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[2]?.textContent ?? ""));
    const shown = rows.reduce((a, t) => a + tokens(t), 0);
    const head = tokens((await panel.locator(".micro").innerText()).split(" ")[0]!);
    assert.ok(Math.abs(shown - head) <= rows.length * 50 + 50, `shown rows ${shown} add up to the shown total ${head}`);
    await shot(app, "context-map", "v6");
    await panel.getByRole("button", { name: "Close" }).click();

    // X7: a fix race; each card shows the activity line, skill, file chips and tokens while it works.
    await win.evaluate(() => window.shrike.on("race:update", (r) => ((window as any).__race = r)));
    const raced = win.evaluate((id) => window.shrike.startRace(id, 2), broken.id) as Promise<Race>;
    await win.getByRole("button", { name: /^Allow/ }).click({ timeout: 20_000 });
    const race = win.getByRole("region", { name: "Fix race" });
    await race.waitFor({ timeout: 60_000 });
    let raceShot = false;
    await waitFor("race cards with live X-ray", async () => {
      const cards = race.locator("section[aria-label]");
      const n = await cards.count();
      let live = 0;
      for (let i = 0; i < n; i++) if ((await cards.nth(i).locator(".xr-activity").count()) && (await cards.nth(i).locator(".xr-files").count()) && (await cards.nth(i).locator(".xr-skill").count())) live++;
      if (live >= 2 && !raceShot) {
        raceShot = true;
        await shot(app, "race-cards", "v6");
      }
      return live >= 2;
    }, 180_000);
    await raced;
    await waitFor("the race to end", async () => {
      const labels = await race.locator("section[aria-label]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
      return labels.length === 2 && labels.every((l) => /Worked|Still broken|Didn't finish/.test(l));
    }, 120_000);
    await race.getByRole("button", { name: "Throw them away" }).click({ timeout: 20_000 }); // no candidate patched, so none worked
    const allow = win.getByRole("button", { name: /^Allow/ });
    if (await allow.waitFor({ timeout: 5000 }).then(() => true, () => false)) await allow.click();
    await waitFor("race worktrees gone", async () => (await win.evaluate(() => window.shrike.listWorktrees())).length === 1, 60_000);
    await win.evaluate(() => window.shrike.stop());
  } catch (err) {
    await shot(app, "xray-failure", "v6").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    cc.remove();
  }
  assert.equal(gitIn(proj, "worktree", "list").split("\n").length, 1, "no worktrees left");
  await waitFor("ports to close", () => listening([0, 100, 200].flatMap((o) => [web + o, api + o])) === "", 20_000);
});
