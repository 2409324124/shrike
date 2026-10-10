// PR1–PR10 in the built app. Writes go to a fake gh (fake-gh.mjs) and each waits for Allow; Not now sends nothing.
// The second test reads a real merged pull request through the same fake in read-only mode: every write is refused there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { fixtureCopy, gitIn, key, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

function fakeGh(real?: string) {
  const dir = mkdtempSync(join(tmpdir(), "shrike-e2e-fakegh-"));
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh.mjs")}" "$@"\n`, { mode: 0o755 });
  const calls = (): string[][] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const writes = () => calls().filter((a) => (a[0] === "api" && /^query=mutation/.test(a[3] ?? "")) || ["pr ready", "run rerun", "pr merge", "pr create", "pr comment", "pr review"].includes(a.slice(0, 2).join(" ")));
  return { env: { SHRIKE_GH_BIN: bin, SHRIKE_FAKE_GH_DIR: dir, ...(real ? { SHRIKE_FAKE_GH_REAL: real } : {}) }, calls, writes };
}

/** The panel, opened like a user: S, then the Ship sheet's link. */
async function openPanel(win: Page, link: RegExp) {
  await key(win, "s");
  const sheet = win.getByRole("dialog", { name: "Ship" });
  await sheet.getByRole("button", { name: link }).click({ timeout: 30_000 });
  const panel = win.locator("[data-pr-panel]");
  await panel.waitFor();
  return panel;
}

test("pr: checks, comments and every GitHub write behind Allow (fake gh)", { timeout: 300_000 }, async () => {
  const proj = fixtureCopy("todo-app", { git: true });
  gitIn(proj, "switch", "-q", "-c", "fix/add-todo");
  const gh = fakeGh();
  const remote = join(gh.env.SHRIKE_FAKE_GH_DIR, "origin.git");
  gitIn(gh.env.SHRIKE_FAKE_GH_DIR, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(proj, "remote", "add", "origin", remote);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...gh.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    const panel = await openPanel(win, /Checks and comments/);
    const allow = panel.getByRole("region", { name: "Allow this?" });

    // PR1 header
    await panel.locator("[data-pr-state=draft]").waitFor({ timeout: 30_000 });
    assert.match(await panel.locator(":scope > header").innerText(), /#7[\s\S]*Draft[\s\S]*Changes asked[\s\S]*Fix: Add Todo works again[\s\S]*main\s*←\s*fix\/add-todo/i);

    // PR2/PR3 checks: failing first and focal, steps and the log tail on expand
    assert.equal(await panel.getByTestId("check-line").innerText(), "3 passing · 1 failing");
    await panel.getByText("1 check needs a look").waitFor();
    await panel.locator('[data-check="test"] button[aria-expanded]').first().click();
    const steps = panel.getByRole("list", { name: "Steps" });
    await steps.waitFor({ timeout: 15_000 });
    assert.deepEqual((await steps.locator("li").allInnerTexts()).map((t) => t.split("\n")[0]!.trim()), ["Set up job", "Install", "Run tests", "Upload report"]);
    assert.match(await panel.getByLabel("Failing lines").innerText(), /AssertionError: expected 500 to equal 201/);
    await panel.getByRole("button", { name: "Fix it" }).waitFor();
    await sleep(300);
    await shot(app, "pr-01-checks", "v5");
    for (const theme of ["Daylight", "High contrast", "Abyss"]) {
      await win.getByRole("button", { name: "Appearance" }).click();
      const dlg = win.getByRole("dialog", { name: "Appearance" });
      await dlg.getByRole("radio", { name: `${theme} theme` }).click();
      await dlg.getByRole("button", { name: "Close appearance" }).click();
      await dlg.waitFor({ state: "detached" });
      await sleep(800);
      if (theme !== "Abyss") await shot(app, `pr-01-checks-${theme.replace(" ", "-").toLowerCase()}`, "v5");
    }

    // PR4 tabs with counts; PR5 safe markdown
    const tabs = panel.getByRole("tablist", { name: "Whose comments" });
    assert.deepEqual((await tabs.getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["All 5", "People 3", "Bots 2"]);
    const html = await panel.innerHTML();
    const bad = /<script|<img|<iframe|src="https?:|alert\(1\)|<!--/.exec(html);
    assert.equal(bad && html.slice(bad.index - 200, bad.index + 80), null);
    assert.doesNotMatch(html, /<script|<img|<iframe|src="https?:|alert\(1\)|<!--/); // the tracker image is a chip, never fetched
    assert.equal(await panel.getByRole("button", { name: "bad link" }).count(), 0, "javascript: links stay text");
    await panel.getByRole("button", { name: "open it" }).waitFor(); // a web link opens in the browser
    await panel.getByText("Suggested change").waitFor();
    await tabs.getByRole("tab", { name: /Bots/ }).click();
    assert.deepEqual(await panel.locator("ol > li > [data-thread], ol > li > [data-comment]").evaluateAll((els) => els.map((e) => e.getAttribute("data-thread") ?? e.getAttribute("data-comment"))), ["PRRT_2", "IC_1"]);
    await panel.locator('[data-thread="PRRT_2"]').getByRole("button", { name: "Unfold" }).click();
    await panel.getByRole("table").waitFor(); // the bot's markdown table
    await sleep(200);
    await shot(app, "pr-02-bots", "v5");
    await tabs.getByRole("tab", { name: /All/ }).click();

    // file:line opens the file view at that line with the comment as a chip
    await panel.locator('[data-thread="PRRT_1"]').getByRole("button", { name: /todos\.controller\.ts:4/ }).click();
    const fv = win.getByRole("dialog", { name: "File server/todos.controller.ts" });
    await fv.waitFor();
    assert.match(await fv.locator(".th-ln.live .fv-note").innerText(), /^@ana: This reads/);
    await sleep(200);
    await shot(app, "pr-03-file-chip", "v5");
    await win.keyboard.press("Escape");
    await fv.waitFor({ state: "detached" });

    // Reply: Not now sends nothing; Allow posts exactly what the card showed
    const t1 = panel.locator('[data-thread="PRRT_1"]');
    const reply = async (text: string) => {
      await t1.getByRole("button", { name: "Reply" }).click();
      await t1.getByLabel("Your reply").fill(text);
      await t1.getByRole("button", { name: "Post reply" }).click();
      await allow.waitFor({ timeout: 15_000 });
      assert.equal(await allow.getByLabel("What will be posted").innerText(), text);
    };
    await reply("Not this one.");
    await shot(app, "pr-04-approval", "v5");
    await allow.getByRole("button", { name: "Not now" }).click();
    await panel.getByText("Not posted. Nothing was sent to GitHub.").waitFor();
    assert.deepEqual(gh.writes(), [], "nothing posted after Not now");
    await t1.getByRole("button", { name: "Cancel" }).click();
    await reply("Fixed: it reads userId now.");
    await allow.getByRole("button", { name: "Allow" }).click();
    const posted = await waitFor("the reply to reach gh", () => (gh.writes().length ? gh.writes() : undefined), 15_000);
    await t1.locator("[data-comment]").getByText("Fixed: it reads userId now.").waitFor({ timeout: 15_000 });
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.includes("body=Fixed: it reads userId now.") && posted[0]!.includes("id=PRRT_1"));

    // Resolve, react, re-run failed, mark ready, review: each asks, each lands once
    const allowNext = async (title: RegExp) => {
      await allow.waitFor({ timeout: 15_000 });
      assert.match(await allow.innerText(), title);
      await allow.getByRole("button", { name: "Allow" }).click();
      await allow.waitFor({ state: "detached", timeout: 15_000 });
    };
    await t1.getByRole("button", { name: "Resolve" }).click();
    await allowNext(/resolved\?/);
    await panel.locator('[data-thread="PRRT_1"][data-resolved="true"]').waitFor({ timeout: 15_000 });
    await panel.getByText(/2\s*of 2 conversations resolved/).waitFor();

    await panel.locator('[data-comment="IC_2"]').getByRole("button", { name: "React" }).click();
    await panel.getByRole("menuitem", { name: "Heart" }).click();
    await allowNext(/React ❤️ to @bo's comment\?/);
    await panel.locator('[data-comment="IC_2"]').getByRole("button", { name: /❤️ 1/ }).waitFor({ timeout: 15_000 });

    await panel.getByRole("button", { name: "Re-run failed" }).click();
    await allowNext(/Re-run the failed jobs/);
    await waitFor("the check running again", async () => (await panel.getByTestId("check-line").innerText()) === "3 passing · 1 running", 15_000);

    await panel.getByRole("button", { name: "More" }).click();
    await panel.getByRole("menuitem", { name: "Mark ready for review" }).click();
    await allowNext(/ready for review\?/);
    await panel.locator("[data-pr-state=open]").waitFor({ timeout: 15_000 });

    await panel.getByRole("button", { name: "Submit a review" }).click();
    await panel.getByLabel("Review summary").fill("Looks right after the fix.");
    await panel.getByRole("button", { name: "Comment", exact: true }).last().click();
    await allowNext(/Comment on pull request #7\?/);
    await panel.locator("[data-review]").getByText("Looks right after the fix.").waitFor({ timeout: 15_000 });

    await panel.getByRole("button", { name: "Leave a comment" }).click();
    await panel.getByLabel("Your comment").fill("Never sent.");
    await panel.getByRole("button", { name: "Post comment" }).click();
    await allow.waitFor();
    await allow.getByRole("button", { name: "Not now" }).click();
    await panel.getByText("Not posted. Nothing was sent to GitHub.").waitFor();

    const w = gh.writes().map((a) => (a[0] === "api" ? /mutation[^{]*\{(\w+)/.exec(a[3]!)![1]! : a.slice(0, 2).join(" ")));
    assert.deepEqual(w, ["addPullRequestReviewThreadReply", "resolveReviewThread", "addReaction", "run rerun", "pr ready", "addPullRequestReview"], "exactly the allowed writes, in order");
    assert.ok(!gh.calls().some((a) => a.join(" ").includes("Never sent.")));
    await sleep(300);
    await shot(app, "pr-05-after-writes", "v5");
  } catch (e) {
    await shot(app, "pr-fail-fake", "v5");
    throw e;
  } finally {
    await cleanup();
  }
});

// SHRIKE_E2E_REAL_REPO: a local checkout of any GitHub repo with merged PRs (uses your gh login).
test("pr: a real merged pull request renders, read-only", { skip: !process.env.SHRIKE_E2E_REAL_REPO, timeout: 240_000 }, async () => {
  const realGh = execFileSync("/bin/zsh", ["-lc", "command -v gh"], { encoding: "utf8" }).trim();
  const src = process.env.SHRIKE_E2E_REAL_REPO!;
  const merged = JSON.parse(execFileSync(realGh, ["pr", "list", "--state", "merged", "--limit", "1", "--json", "number,title"], { cwd: src, encoding: "utf8" }))[0] as { number: number; title: string };
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: src, encoding: "utf8" }).trim();
  // A scratch repo that only points at the same GitHub repo: the owner's checkout is never opened.
  const proj = join(mkdtempSync(join(tmpdir(), "shrike-e2e-real-")), "real");
  mkdirSync(proj);
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "remote", "add", "origin", origin);
  gitIn(proj, "commit", "-q", "--allow-empty", "-m", "start");
  const gh = fakeGh(realGh);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...gh.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    const setup = win.getByRole("button", { name: "Close setup" });
    if (await setup.isVisible({ timeout: 3000 }).catch(() => false)) await setup.click(); // an empty repo has nothing to start
    const panel = await openPanel(win, /This branch's checks/);
    await panel.getByRole("button", { name: "More" }).click();
    await panel.getByLabel("Pull request number").fill(`#${merged.number}`);
    await panel.getByRole("button", { name: "Show" }).click();
    await panel.locator("[data-pr-state=merged]").waitFor({ timeout: 60_000 });
    assert.match(await panel.locator(":scope > header").innerText(), new RegExp(`#${merged.number}[\\s\\S]*Merged`, "i"));
    assert.equal(await panel.locator("header h3").innerText(), merged.title);
    await panel.getByTestId("check-line").waitFor();
    assert.match(await panel.getByTestId("check-line").innerText(), /\d+ passing/);
    await panel.getByRole("tablist", { name: "Whose comments" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Leave a comment" }).count(), 0, "no composing on a merged PR");
    await sleep(4000); // an older branch load finishing late must not replace it
    assert.equal(await panel.locator("[data-pr-state=merged]").count(), 1);
    await shot(app, "pr-06-real-merged", "v5");
    assert.deepEqual(gh.writes(), []);
    assert.ok(gh.calls().every((a) => a[0] !== "api" || /^query=query/.test(a[3] ?? "")), "only GraphQL queries, no mutations");
  } catch (e) {
    await shot(app, "pr-fail-real", "v5");
    throw e;
  } finally {
    await cleanup();
  }
});
