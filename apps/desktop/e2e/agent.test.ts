// Real agent run on the Thread with the real Claude Code brain. Uses the user's subscription, so it only runs with SHRIKE_E2E_AGENT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { actions, addTodoAction, caption, flatten, launch, openSampleAndRun, shot, sleep, tripDom, typeTodo, waitFor } from "./helpers.ts";

const fixtureController = join(import.meta.dirname, "../../../fixtures/todo-app/server/todos.controller.ts");
const SHOT = "v5-agent-basic";

test("agent probe walks the trip, finds line 18, the fix applies and the re-run knits green", { skip: process.env.SHRIKE_E2E_AGENT !== "1", timeout: 900_000 }, async () => {
  const original = readFileSync(fixtureController);
  const { app, win, userData, cleanup } = await launch();
  const controller = join(userData, "sample/todo-app/server/todos.controller.ts"); // the sample opens as a copy in userData
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    const guest = await openSampleAndRun(app, win);
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broken = await addTodoAction(win);
    assert.equal(broken.status, "error");
    await win.locator(`.th-trip[data-trip="${broken.id}"] .th-dive`).waitFor({ timeout: 15_000 });

    // ⌘K, ask in plain words.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("When I click Add Todo nothing shows up");
    await shot(app, "01-ask", SHOT);
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    await ask.waitFor({ state: "detached" });

    // M7: the violet probe walks the failing trip, ticking stations.
    const trip = win.locator(`.th-trip[data-trip="${broken.id}"]`);
    await trip.locator(".th-probe").waitFor({ timeout: 30_000 });
    await waitCaption(win, /retracing|Checking|Found it/);
    await waitFor("the probe to tick a station", async () => (await trip.locator(".th-ptick").count()) >= 1, 240_000);
    await shot(app, "02-probe-walking", SHOT);

    // FOUND IT on the insertTodo station (or the controller line), with the card naming the line.
    const found = win.getByRole("region", { name: "Found it" });
    await found.waitFor({ timeout: 300_000 });
    await trip.locator(".th-found").waitFor();
    const at = await win.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`.th-trip[data-trip="${id}"]`)!;
      const f = el.querySelector<HTMLElement>(".th-found")!;
      const st = [...el.querySelectorAll<HTMLElement>(".th-st")].find((b) => b.style.left === f.style.left && b.style.top === f.style.top);
      return st ? el.querySelector(`.th-lab[data-i="${st.dataset.i}"] .n`)?.textContent ?? "" : "";
    }, broken.id);
    const card = await found.innerText();
    console.log(`FOUND IT on ${at}`);
    assert.ok(/^insertTodo\(\)$/.test(at) || /todos\.controller\.ts:18\b/.test(card), `FOUND IT at ${at}: ${card}`);
    await sleep(1200);
    await shot(app, "03-found-it", SHOT);

    // Diff card -> Apply. Record any trip whose thread draws green (M8) from here on.
    const fix = win.getByRole("region", { name: /^(Found it|Fix)$/ });
    const apply = fix.getByRole("button", { name: /^Apply/ });
    await apply.waitFor({ timeout: 300_000 });
    assert.match(await fix.innerText(), /userId/);
    await sleep(600);
    await shot(app, "04-diff", SHOT);
    await win.evaluate(() => {
      const w = window as unknown as { __knit: string[] };
      w.__knit = [];
      new MutationObserver((ms) => {
        for (const m of ms) {
          const p = m.target as SVGPathElement;
          if (p.matches?.("path.th-out") && p.style.stroke) w.__knit.push(p.closest<HTMLElement>(".th-trip")!.dataset.trip!);
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
    });
    await apply.click();

    const request = win.getByRole("region", { name: "Agent request" });
    let shotKnit = false;
    await waitFor("Fixed and verified", async () => {
      if (await request.isVisible().catch(() => false)) await request.getByRole("button", { name: /^Allow/ }).click().catch(() => {});
      if (!shotKnit && ((await win.evaluate(() => (window as unknown as { __knit: string[] }).__knit.length)) > 0)) {
        shotKnit = true;
        await sleep(700);
        await shot(app, "05-reknit", SHOT);
      }
      return win.getByText(/fixed and verified/i).first().isVisible();
    }, 400_000);
    assert.match(readFileSync(controller, "utf8"), /req\.body\.userId/);

    // The re-run trip arrived below the broken one, worked, and knitted green.
    const fixedRun = await waitFor("a re-run that created the todo", async () =>
      (await actions(win)).find((a) => a.startMs > broken.startMs && a.complete && flatten(a.tree).some((e) => e.http?.method === "POST" && e.http.status === 201)),
    30_000);
    assert.notEqual(fixedRun.status, "error");
    const knitted = await win.evaluate(() => (window as unknown as { __knit: string[] }).__knit);
    assert.ok(knitted.includes(fixedRun.id), `the re-run knitted green (${knitted.join(",")})`);
    const d = (await tripDom(win, fixedRun.id))!;
    assert.equal(d.verdict, "WORKED");
    assert.match(d.returned, /201/);
    const [yBroken, yFixed] = await win.evaluate(([a, b]) => [a, b].map((id) => document.querySelector<HTMLElement>(`.th-trip[data-trip="${id}"]`)!.offsetTop), [broken.id, fixedRun.id]);
    assert.ok(yFixed! > yBroken!, "the re-run sits below the broken trip");
    const cap = await caption(win);
    console.log(`caption: ${cap}`);
    assert.doesNotMatch(cap, /failed|refused/i);
    await sleep(800);
    await shot(app, "06-verified-green", SHOT);
    console.log(`--- agent ---\n${await win.getByRole("complementary", { name: "Agent" }).innerText().catch(() => "")}`);
  } catch (err) {
    await shot(app, "failure", SHOT).catch(() => {});
    throw err;
  } finally {
    await cleanup();
    assert.ok(readFileSync(fixtureController).equals(original), "the repo's fixture is never edited");
  }
});

const waitCaption = (win: Parameters<typeof caption>[0], re: RegExp) => waitFor(`the caption to match ${re}`, async () => re.test(await caption(win)), 30_000);
