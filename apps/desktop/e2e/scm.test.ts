// SC1–SC7 in the built app: the right dock's Changes tab on a throwaway todo-app repo with a local bare "GitHub" remote.
// gh is fake-gh-scm.mjs (SHRIKE_GH_BIN), Claude is fake-claude.mjs; discard and push wait for Allow; nothing reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeClaude, fixtureCopy, gitIn, key, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const PLANTED = "insertTodo({ title, userId: req.body.user });";
const FIXED = "insertTodo({ title, userId: req.body.userId });";

test("scm: sections, diff, stage, discard behind Allow, live updates, write, commit, undo, push behind Allow", { timeout: 300_000 }, async () => {
  const proj = fixtureCopy("todo-app", { git: true });
  const remote = join(dirname(proj), "origin.git");
  gitIn(dirname(proj), "init", "-q", "--bare", "-b", "main", remote);
  gitIn(proj, "remote", "add", "origin", remote);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  gitIn(proj, "switch", "-q", "-c", "fix/userid");
  const ctl = join(proj, "server/todos.controller.ts");
  writeFileSync(ctl, readFileSync(ctl, "utf8").replace(PLANTED, FIXED));
  gitIn(proj, "commit", "-q", "-am", "Read userId from the form");
  gitIn(proj, "push", "-q", "-u", "origin", "fix/userid");
  const app_ = join(proj, "src/App.tsx");
  writeFileSync(app_, `${readFileSync(app_, "utf8")}\n// header tidy\n`);
  mkdirSync(join(proj, "notes"));
  writeFileSync(join(proj, "notes/plan.md"), "# Plan\n\n1. Fix it\n");

  const gh = mkdtempSync(join(tmpdir(), "shrike-e2e-gh-"));
  writeFileSync(join(gh, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-scm.mjs")}" "$@"\n`, { mode: 0o755 });
  const ghLog = join(gh, "calls.log");
  const claude = fakeClaude(40);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(gh, "gh"), FAKE_GH_LOG: ghLog, ...claude.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    if (await win.getByRole("button", { name: "Close setup" }).count()) await win.getByRole("button", { name: "Close setup" }).click();

    // SC1: ⌘⇧G opens the dock on Changes.
    await key(win, "Meta+Shift+KeyG");
    const dock = win.getByRole("complementary", { name: "Right dock" });
    const sec = (name: string) => dock.getByRole("region", { name, exact: true });
    await sec("Changes").getByText("App.tsx").waitFor({ timeout: 20_000 });
    await sec("Untracked").getByText("plan.md").waitFor();
    await sec("Committed on this branch").getByText("todos.controller.ts").waitFor();
    assert.match(await sec("Branch").innerText(), /fix\/userid\s*→\s*origin\b[\s\S]*2 changes not saved to git yet/);
    await sleep(300);
    await shot(app, "01-dock", "scm");

    // SC6: the branch's change as a diff, words changed lit; Ask puts it on the composer.
    await sec("Committed on this branch").getByRole("button", { name: /todos\.controller\.ts/ }).click();
    const diff = win.getByRole("dialog", { name: "Changes to server/todos.controller.ts" });
    await diff.getByText("req.body.userId").first().waitFor();
    await waitFor("changed words lit", async () => (await diff.locator(".lit").count()) > 0);
    await shot(app, "02-diff-inline", "scm");
    await diff.getByRole("button", { name: "Split" }).click();
    await shot(app, "03-diff-split", "scm");
    await diff.getByRole("button", { name: /Ask about this change/ }).click();
    await diff.waitFor({ state: "detached" });
    const chip = await waitFor("the change chip", () => win.evaluate(() => document.body.innerText.includes("changes · todos.controller.ts")));
    assert.ok(chip);
    await win.keyboard.press("Escape");

    // SC5: stage and unstage with a click.
    const row = (s: string, name: string) => sec(s).locator(".scm-row", { hasText: name });
    await row("Changes", "App.tsx").hover();
    await row("Changes", "App.tsx").getByRole("button", { name: /^Stage/ }).click();
    await sec("Staged").getByText("App.tsx").waitFor();
    assert.equal(gitIn(proj, "diff", "--cached", "--name-only"), "src/App.tsx");
    await row("Staged", "App.tsx").hover();
    await row("Staged", "App.tsx").getByRole("button", { name: /^Unstage/ }).click();
    await sec("Changes").getByText("App.tsx").waitFor();
    assert.equal(gitIn(proj, "diff", "--cached", "--name-only"), "");

    // Discard waits for Allow, right in the dock; Not now keeps the file.
    const plan = join(proj, "notes/plan.md");
    await row("Untracked", "plan.md").hover();
    await row("Untracked", "plan.md").getByRole("button", { name: /Throw this change away/ }).click();
    const allow = dock.getByRole("region", { name: "Allow this?" });
    await allow.waitFor();
    assert.match(await allow.innerText(), /Throw away your changes to notes\/plan\.md\?[\s\S]*deleted/);
    await shot(app, "04-discard-allow", "scm");
    await allow.getByRole("button", { name: "Not now" }).click();
    await dock.getByText(/Not thrown away/).waitFor();
    assert.ok(existsSync(plan), "Not now keeps the file");
    await row("Untracked", "plan.md").hover();
    await row("Untracked", "plan.md").getByRole("button", { name: /Throw this change away/ }).click();
    await allow.getByRole("button", { name: "Allow" }).click();
    await waitFor("plan.md gone", () => !existsSync(plan));
    await sec("Untracked").waitFor({ state: "detached" });

    // SC7 live: a file the agent writes shows up on its own.
    writeFileSync(join(proj, "notes/live.md"), "written outside Shrike\n");
    await sec("Untracked").getByText("live.md").waitFor({ timeout: 10_000 });
    gitIn(proj, "clean", "-fq", "notes");

    // SC3: Write it for me runs the Commit message recipe through the agent.
    await dock.getByRole("button", { name: /Write it for me/ }).click();
    const box = dock.getByRole("textbox", { name: "Commit message" });
    await waitFor("the agent's message", async () => (await box.inputValue()).startsWith("Fix: Add Todo saves the owner again"));
    const asked = claude.calls().find((c) => /^# Write a commit message/m.test(c.goal));
    assert.ok(asked, "the recipe's prompt (the skill, then the variables; scm.test.ts checks the render) reached the agent");
    await shot(app, "05-written", "scm");

    // SC4: commit with a click, then undo it.
    await box.fill("Tidy the app header");
    await dock.getByRole("button", { name: /^Commit all 1 change/ }).click();
    await dock.getByRole("button", { name: /Undo last commit/ }).waitFor();
    assert.equal(gitIn(proj, "log", "-1", "--format=%s"), "Tidy the app header");
    assert.match(await sec("Branch").innerText(), /1 commit not on GitHub yet/);
    await shot(app, "06-committed", "scm");
    await dock.getByRole("button", { name: /Undo last commit/ }).click();
    await waitFor("undone", () => gitIn(proj, "log", "-1", "--format=%s") === "Read userId from the form");
    assert.equal(gitIn(proj, "diff", "--cached", "--name-only"), "src/App.tsx", "the change comes back staged");
    await waitFor("the message back in the box", async () => (await box.inputValue()) === "Tidy the app header");

    // Sync sends the commit only after Allow; never a force-push.
    await dock.getByRole("button", { name: /^Commit 1 file/ }).click();
    await dock.getByRole("button", { name: /Send 1 to GitHub/ }).click();
    await allow.waitFor();
    assert.match(await allow.innerText(), /Send 1 commit to GitHub\?/);
    assert.equal(gitIn(remote, "log", "-1", "--format=%s", "fix/userid"), "Read userId from the form", "nothing pushed before Allow");
    await shot(app, "07-push-allow", "scm");
    await allow.getByRole("button", { name: "Allow" }).click();
    await waitFor("pushed", () => gitIn(remote, "log", "-1", "--format=%s", "fix/userid") === "Tidy the app header");
    await dock.getByText("Everything is saved and on GitHub.").waitFor();

    // SC7: the commits list shows the commit and its files.
    await dock.getByRole("button", { name: /^Commits/ }).click();
    await dock.getByRole("button", { name: /Tidy the app header/ }).click();
    await dock.locator(".scm-commit").first().getByText("App.tsx").waitFor();
    await shot(app, "08-commits", "scm");

    const calls = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
    assert.doesNotMatch(calls, /pr (create|merge|comment|review|edit)|api .*-X|issue comment/, "no GitHub writes");
  } finally {
    await cleanup();
    claude.remove();
  }
});
