// G1/G3/G5 and the L* rail in the built app, on a throwaway git copy of todo-app with a local bare "GitHub" remote.
// gh is a stub put first on the login-shell PATH (through a SHELL wrapper), so nothing reaches the real GitHub.
// Push, opening the pull request and merging each wait for Allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { GitState, SdlcState } from "@shrike/schema";
import { addTodoAction, dismissResult, fixtureCopy, freePort, gitIn, key, launch, listening, mcpClient, openFolder, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

const PLANTED = "insertTodo({ title, userId: req.body.user });";
const FIXED = "insertTodo({ title, userId: req.body.userId });";

/** A fake gh: one pull request, kept in a JSON file; every call is logged. */
function ghStub(dir: string): void {
  const state = join(dir, "pr.json");
  writeFileSync(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, a.join(" ") + "\\n");
const pr = fs.existsSync(${JSON.stringify(state)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8")) : null;
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
if (a[0] === "--version") out("gh version 2.0.0 (e2e stub)\\n");
else if (a[0] === "auth") out("Logged in to github.com as e2e\\n");
else if (a[0] === "pr" && a[1] === "view") { if (!pr) { process.stderr.write("no pull requests found for branch\\n"); process.exit(1); } out(pr); }
else if (a[0] === "pr" && a[1] === "checks") out(pr ? [{ name: "test", bucket: "pass", link: "" }] : []);
else if (a[0] === "pr" && a[1] === "list") out(pr ? [pr] : []);
else if (a[0] === "pr" && a[1] === "create") {
  const v = (f) => a[a.indexOf(f) + 1];
  const body = fs.readFileSync(0, "utf8");
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ number: 7, title: v("--title"), url: "https://github.com/e2e/todo-app/pull/7", state: "OPEN", headRefName: v("--head"), baseRefName: v("--base"), body }));
  out("https://github.com/e2e/todo-app/pull/7\\n");
} else if (a[0] === "pr" && a[1] === "merge") { fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ ...pr, state: "MERGED" })); out("merged\\n"); }
else { process.stderr.write("stub: unsupported " + a.join(" ") + "\\n"); process.exit(1); }
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  // GUI apps take PATH from the login shell; this wrapper puts the stub first there.
  writeFileSync(join(dir, "shell"), `#!/bin/zsh\nif [[ "$1" == "-lc" ]]; then exec /bin/zsh -lc "export PATH=${dir}:\\$PATH; $2"; fi\nexec /bin/zsh "$@"\n`);
  chmodSync(join(dir, "shell"), 0o755);
}

const sdlc = (win: Page) => win.evaluate(() => window.shrike.getSdlc()) as Promise<SdlcState>;
const gitState = (win: Page) => win.evaluate(() => window.shrike.gitState()) as Promise<GitState>;
const rail = (s: SdlcState) => Object.entries(s.stages).map(([k, v]) => `${k}:${v}`).join(" ");

test("git: ship a fix behind approvals, a real conflict, the rail walks spot to ship", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const stub = mkdtempSync(join(tmpdir(), "shrike-e2e-gh-"));
  ghStub(stub);
  const remote = join(stub, "origin.git");
  gitIn(stub, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(proj, "remote", "add", "origin", remote);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  const calls = () => (existsSync(join(stub, "calls.log")) ? readFileSync(join(stub, "calls.log"), "utf8") : "");
  const seen: string[] = [];
  const note = async (win: Page, when: string) => {
    const s = await sdlc(win);
    seen.push(`${when}: ${rail(s)}`);
    return s;
  };

  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHELL: join(stub, "shell") });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    assert.equal((await gitState(win)).ghReady, true, "the gh stub is the one Shrike runs");

    // L1 Spot: the planted bug breaks Add Todo.
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broken = await addTodoAction(win);
    assert.equal(broken.status, "error");
    await waitFor("spot", async () => (await note(win, "broke")).stages.spot === "done");

    // L3 Fix: an outside agent (MCP) proposes the fix; Apply writes it.
    const mcp = await mcpClient(app);
    const proposed = mcp.call("propose_patch", { files: [{ path: "server/todos.controller.ts", edits: [{ oldText: PLANTED, newText: FIXED }] }], rationale: "The page sends userId, so read userId." });
    await win.getByRole("button", { name: /Apply fix/ }).click({ timeout: 20_000 });
    assert.match(await proposed, /applied/);
    await mcp.close();
    await waitFor("fix", async () => (await note(win, "applied")).stages.fix === "done");

    // L4 Prove: the same click again works.
    await sleep(2500); // node --watch restarts the server
    await guest.getByPlaceholder("What needs doing?").click();
    await guest.keyboard.press("Meta+A");
    await guest.keyboard.press("Backspace");
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const again = await addTodoAction(win, broken.startMs);
    assert.equal(again.status, "ok");
    await waitFor("prove", async () => (await note(win, "re-ran")).stages.prove === "done");

    // L5: skip the review.
    await win.evaluate(() => window.shrike.waiveReview());
    await waitFor("review skipped", async () => (await note(win, "review")).stages.review === "skipped");
    await sleep(400);
    await shot(app, "git-01-rail-before-ship", "v5");

    // G1: Ship shows the changed file (Shrike's fix) and a commit message; push + PR wait for Allow.
    await key(win, "s");
    const sheet = win.getByRole("dialog", { name: "Ship" });
    await sheet.getByText("server/todos.controller.ts").waitFor({ timeout: 20_000 });
    await sheet.getByText("Shrike's fix").waitFor();
    const message = await sheet.getByLabel("Commit message").innerText();
    assert.ok(message.trim().length > 5, `commit message: ${message}`);
    await sleep(300);
    await shot(app, "git-02-ship", "v5");
    await sheet.getByRole("button", { name: "Ship this fix" }).click();
    const allow = sheet.getByRole("region", { name: "Allow this?" });
    await allow.waitFor({ timeout: 20_000 });
    assert.match(await allow.innerText(), /open a pull request/);
    assert.doesNotMatch(calls(), /pr create/, "nothing sent before Allow");
    assert.equal(gitIn(remote, "branch", "--list"), "* main", "nothing pushed before Allow");
    await sleep(300);
    await shot(app, "git-03-approval", "v5");
    await allow.getByRole("button", { name: "Allow" }).click();
    await sheet.getByText("Pull request #7 · open").waitFor({ timeout: 30_000 });
    const branch = (await gitState(win)).branch!;
    assert.match(branch, /^fix\//);
    assert.equal(gitIn(proj, "branch", "--show-current"), branch);
    assert.match(gitIn(remote, "branch", "--list"), new RegExp(branch.replace("/", "\\/")), "the branch reached the remote");
    assert.match(gitIn(proj, "show", "--stat", "--format=%s", "HEAD"), /server\/todos\.controller\.ts/);
    assert.equal(gitIn(proj, "rev-parse", "main"), gitIn(remote, "rev-parse", "main"), "main is untouched");
    assert.match(calls(), /pr create --base main --head fix\//);
    await sleep(500);
    await shot(app, "git-04-pr-open", "v5");
    await note(win, "pr open");
    await dismissResult(win, 5000); // shipping ends with the results screen over the sheet

    // G3: someone changes the same line on main; syncing stops with a real conflict, shown side by side.
    const other = join(stub, "other");
    gitIn(stub, "clone", "-q", remote, other);
    const otherFile = join(other, "server/todos.controller.ts");
    writeFileSync(otherFile, readFileSync(otherFile, "utf8").replace(PLANTED, "insertTodo({ title, userId: req.body.user ?? 1 });"));
    gitIn(other, "-c", "user.name=Other", "-c", "user.email=o@e2e.invalid", "commit", "-qam", "Default the owner");
    gitIn(other, "push", "-q", "origin", "main");
    await win.evaluate(() => window.shrike.syncWithMain({ mode: "merge" }));
    await sheet.getByText("Syncing with main stopped").waitFor({ timeout: 20_000 });
    await sheet.getByText("Yours").first().waitFor();
    assert.deepEqual((await gitState(win)).conflicts, ["server/todos.controller.ts"]);
    await sleep(400);
    await shot(app, "git-05-conflict", "v5");
    await sheet.getByRole("button", { name: "Undo the sync" }).click();
    await waitFor("the sync undone", async () => !(await gitState(win)).operation, 20_000);

    // G5: checks green and no saved flows, so Merge when green asks, then merges.
    await sheet.getByRole("button", { name: "Merge when green" }).click({ timeout: 20_000 });
    await allow.waitFor({ timeout: 20_000 });
    assert.match(await allow.innerText(), /Merge pull request #7/);
    assert.doesNotMatch(calls(), /pr merge/);
    await allow.getByRole("button", { name: "Allow" }).click();
    await waitFor("merged", async () => /pr merge 7 --squash --delete-branch/.test(calls()), 20_000);
    await key(win, "Escape");
    // Merged with nothing left to watch: the rail has nothing in flight and hides (sdlc.ts).
    await waitFor("the rail to settle after the merge", async () => (await note(win, "merged")).stages.spot !== "done", 30_000);
    await sleep(400);
    await shot(app, "git-06-shipped", "v5");
    console.log(seen.join("\n"));
    const open = seen.find((l) => l.startsWith("pr open"))!;
    assert.match(open, /spot:done understand:skipped fix:done prove:done review:skipped ship:active/);
    assert.ok(!/push.*--force|-f /.test(calls()));
  } finally {
    await cleanup();
  }
  assert.equal(listening([web, api]), "", "ports free");
});
