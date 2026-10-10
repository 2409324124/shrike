// RL1–RL9 in the built app: review lessons mined from a fake gh (fake-gh-lessons.mjs, reads only) and clustered by the
// recorded Claude (fake-lessons.mjs). Lessons tab, [Skill Acquired], PR panel chips and Learn from this, the gate
// ([Level Up] after an approval, Not working yet when it comes back), Ship's self-check, [Lesson Mastered] and its XP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { fakeClaude, fixtureCopy, gitIn, key, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), "shrike-e2e-fakegh-lessons-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-lessons.mjs")}" "$@"\n`, { mode: 0o755 });
  const calls = (): string[][] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { env: { SHRIKE_GH_BIN: bin, SHRIKE_FAKE_GH_DIR: dir }, calls, stage: (n: number) => writeFileSync(join(dir, "stage"), String(n)) };
}

const lessonsTab = async (win: Page) => {
  const dock = win.getByRole("complementary", { name: "Right dock" });
  if (await dock.count()) await dock.getByRole("tab", { name: /Lessons/ }).click();
  else await win.getByRole("navigation", { name: "Right dock" }).getByRole("button", { name: "Lessons" }).click();
  const panel = win.locator("[data-lessons-panel]");
  await panel.waitFor();
  return panel;
};
const refresh = async (win: Page) => {
  const panel = await lessonsTab(win);
  await panel.getByRole("button", { name: "Refresh: read new review activity" }).click();
  await waitFor("the refresh to finish", async () => !(await win.evaluate(() => window.shrike.reviewLessons().then((v) => v.busy))), 30_000);
  return panel;
};
const theme = async (win: Page, name: string) => {
  await win.getByRole("button", { name: "Appearance" }).click();
  const dlg = win.getByRole("dialog", { name: "Appearance" });
  await dlg.getByRole("radio", { name: `${name} theme` }).click();
  await dlg.getByRole("button", { name: "Close appearance" }).click();
  await dlg.waitFor({ state: "detached" });
  await sleep(700);
};

test("review lessons: mine, cluster, chips, Learn from this, the gate, self-check and mastery (fake gh, recorded Claude)", { timeout: 300_000 }, async () => {
  const proj = fixtureCopy("todo-app", { git: true });
  gitIn(proj, "switch", "-q", "-c", "feature/save");
  const gh = fakeGh();
  const cc = fakeClaude(60);
  const { app, win, userData, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...gh.env, ...cc.env });
  const skill = join(proj, ".shrike/skills/review-lessons.md");
  const version = () => Number(/^version: (\d+)$/m.exec(readFileSync(skill, "utf8"))?.[1]);
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);

    // RL7 first run: one button, then lessons, the burn-down and reviewers; RL4 v1 and [Skill Acquired]
    let panel = await lessonsTab(win);
    await panel.getByRole("button", { name: "Learn from your last 50 pull requests" }).click();
    const loading = panel.locator('[data-lesson="missing-loading-state"]');
    await loading.waitFor({ timeout: 60_000 });
    await win.getByRole("status", { name: /Skill acquired: Review lessons/i }).waitFor({ timeout: 15_000 });
    await shot(app, "lessons-01-acquired", "rl");
    assert.match(await loading.innerText(), /Missing loading state[\s\S]*4 PRs[\s\S]*@ana[\s\S]*4×/);
    assert.equal(await loading.getAttribute("data-rank"), "E");
    assert.equal(await panel.locator('[data-lesson="unvalidated-input"]').getAttribute("data-rank"), "C");
    const ana = panel.locator('[data-reviewer="ana"]');
    assert.match(await ana.innerText(), /@ana[\s\S]*comments? a PR[\s\S]*Missing loading state[\s\S]*Numbers findings W01/);
    assert.match(await panel.getByRole("region", { name: "Repeat issues per PR" }).innerText(), /REPEAT ISSUES PER PR/i);
    assert.equal(version(), 1);
    assert.match(readFileSync(skill, "utf8"), /## Lesson: Missing loading state[\s\S]*Fix it:\n1\. Show a spinner/);
    await sleep(2800); // the System window leaves
    await loading.getByRole("button", { expanded: false }).click();
    await loading.getByText("Spot it").waitFor();
    await sleep(300);
    await shot(app, "lessons-02-panel", "rl");
    for (const t of ["Daylight", "High contrast"]) {
      await theme(win, t);
      await shot(app, `lessons-02-panel-${t.replace(" ", "-").toLowerCase()}`, "rl");
    }
    await theme(win, "Abyss");

    // RL8 in the PR panel: a chip on the review that belongs to a lesson; Learn from this on a lone nit
    await win.getByRole("complementary", { name: "Right dock" }).getByRole("tab", { name: /PR and checks/ }).click();
    const pr = win.locator("[data-pr-panel]");
    const chip = pr.locator('[data-review="PRR_3"] [data-lesson-chip="missing-loading-state"]');
    await chip.waitFor({ timeout: 30_000 });
    assert.equal(await chip.getAttribute("aria-label"), "3rd time: missing loading state");
    await pr.locator('[data-thread="PRRT_3a"]').getByRole("button", { name: "Unfold" }).click(); // resolved threads fold
    const nit = pr.locator('[data-comment="PRRC_3a"]');
    await nit.getByRole("button", { name: "Learn from this" }).click();
    await nit.locator('[data-lesson-chip="clear-names"]').waitFor({ timeout: 30_000 });
    assert.equal(await nit.locator("[data-lesson-chip]").getAttribute("aria-label"), "1st time: clear names");
    await sleep(300);
    await shot(app, "lessons-03-pr-chips", "rl");
    await nit.locator("[data-lesson-chip]").click(); // opens the lesson in the Lessons tab
    panel = win.locator("[data-lessons-panel]");
    await panel.locator('[data-lesson="clear-names"]').getByText("Waiting for a reviewer").waitFor();
    assert.equal(version(), 1, "a new lesson is a draft until a reviewer says so");

    // RL4 the gate: an approval after the draft keeps it ([Level Up])
    gh.stage(2);
    await refresh(win);
    await win.getByRole("status", { name: /Review lessons leveled up/i }).waitFor({ timeout: 15_000 });
    await shot(app, "lessons-04-level-up", "rl");
    assert.equal(version(), 2);
    await sleep(2800);

    // flagged again after its fix was written: Not working yet, with rewritten steps waiting for a reviewer
    gh.stage(3);
    panel = await refresh(win);
    await loading.getByText("Waiting for a reviewer").waitFor();
    const rewritten = await win.evaluate(() => window.shrike.reviewLessons().then((v) => v.lessons.find((l) => l.id === "missing-loading-state")));
    assert.equal(rewritten?.status, "not-working");
    assert.match(rewritten!.fix[0]!, /from the click until the answer comes back/);
    await shot(app, "lessons-05-not-working", "rl");

    // RL6 Ship: the self-check before a pull request
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src/SaveButton.tsx"), "export function SaveButton({ save }: { save(): void }) {\n  return (\n    <button onClick={save}>Save</button>\n  );\n}\n");
    gitIn(proj, "add", "-A");
    gitIn(proj, "commit", "-q", "-m", "Add a save button");
    await key(win, "s");
    const ship = win.getByRole("dialog", { name: "Ship" });
    const card = ship.getByRole("region", { name: "Review self-check" });
    await waitFor("the self-check to finish", async () => (await card.getAttribute("data-check-state")) === "done", 60_000);
    assert.equal(await card.getByTestId("self-check-line").innerText(), "Checked 3 repeat issues for @ana and @bo: 1 found (missing loading state)");
    await card.getByRole("button", { name: /Fix it first/ }).waitFor();
    await sleep(300);
    await shot(app, "lessons-06-self-check", "rl");
    await win.keyboard.press("Escape");

    // RL9: five reviewed PRs without it since Shrike learned it: [Lesson Mastered] and XP, once
    const xp = await win.evaluate(() => window.shrike.getProgress().then((p) => p.xp));
    gh.stage(4);
    await refresh(win);
    const mastered = win.getByRole("status", { name: /Lesson mastered: /i });
    await mastered.waitFor({ timeout: 20_000 });
    await shot(app, "lessons-07-mastered", "rl");
    assert.ok((await win.evaluate(() => window.shrike.getProgress().then((p) => p.xp))) >= xp + 50);
    await waitFor("the mastered lessons to show S", async () => (await loading.getAttribute("data-rank")) === "S", 10_000);
    await sleep(3500);
    await shot(app, "lessons-08-after", "rl");

    // read only: nothing that writes ever reached gh
    for (const a of gh.calls()) assert.ok(!(a[0] === "api" && a.some((x) => /^query=\s*mutation/.test(x))) && !["pr create", "pr merge", "pr comment", "pr review", "pr ready", "run rerun"].includes(a.slice(0, 2).join(" ")), `a write: ${a.join(" ")}`);
    assert.ok(cc.calls().filter((c) => /^Cluster these pull request review comments/.test(c.goal)).length >= 3);
  } finally {
    await cleanup();
    cc.remove();
    void userData;
  }
});
