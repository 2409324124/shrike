// Missing tools (docs/14): a computer without Node, a package manager or Python, with Node too old for the recorder, or with
// Node only in ~/.zshrc (nvm, opened from Finder). Run `pnpm build` first (or SHRIKE_E2E_APP=<a build kept apart from out/>).
// A fake login shell stands in for the user's: system folders, then the PATH it was given (as path_helper does), then what
// the fake HOME's profile (-l) and rc (-i) add. SHRIKE_E2E_OLD_NODE=<a Node 18.17 bin folder> adds the old-Node case.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { StartPlan } from "@shrike/schema";
import type { Page } from "playwright";
import { fixtureCopy, freePort, key, launch, openFolder, questReady, shot, sleep, waitFor } from "./helpers.ts";

function fakeHome(o: { rc?: string; bin?: Record<string, string> } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "shrike-e2e-home-")));
  const shell = join(home, "fake-shell");
  writeFileSync(shell, `#!/bin/bash\nflags=$1; shift\nexport PATH=$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\ncase $flags in *i*) [ -f "$HOME/.fake_rc" ] && . "$HOME/.fake_rc";; esac\nexec /bin/bash -c "$@"\n`, { mode: 0o755 });
  if (o.rc) writeFileSync(join(home, ".fake_rc"), o.rc);
  mkdirSync(join(home, "bin"));
  for (const [name, script] of Object.entries(o.bin ?? {})) writeFileSync(join(home, "bin", name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  return { home, env: { HOME: home, SHELL: shell, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } };
}

/** A folder holding links to this Node's node, npm and npx, like ~/.nvm/versions/node/<v>/bin. */
function nodeDir(home: string, from = dirname(process.execPath)): string {
  const dir = join(home, ".nvm", "versions", "node", "current", "bin");
  mkdirSync(dir, { recursive: true });
  for (const f of ["node", "npm", "npx"]) symlinkSync(join(from, f), join(dir, f));
  return dir;
}

/** A tiny app: one file served by `command`, declared in .shrike/config.json the way the recorded start reads it. */
function tinyApp(files: Record<string, string>, command: string, port: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shrike-e2e-tiny-")));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  mkdirSync(join(root, ".shrike"));
  writeFileSync(join(root, ".shrike", "config.json"), JSON.stringify({ devCommand: command, appUrl: `http://localhost:${port}` }));
  writeFileSync(join(root, "index.html"), "<title>Tiny</title><h1>Tiny app</h1>");
  return root;
}

const plan = (win: Page) => win.evaluate(() => window.shrike.getStartPlan()) as Promise<StartPlan | null>;
const ended = (win: Page, ms = 30_000) => waitFor("the start to end", async () => {
  const p = await plan(win);
  return p && (p.state === "failed" || p.state === "ready") ? p : undefined;
}, ms);
const run = (win: Page) => win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();

test("no Node: Run says so in seconds with the command to get it; Check again finds Node from ~/.zshrc (nvm, opened from Finder)", { timeout: 240_000 }, async () => {
  const { home, env } = fakeHome();
  const root = fixtureCopy("todo-app");
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  const { app, win, cleanup } = await launch({ ...env, SHRIKE_OPEN_FOLDER: root });
  try {
    await openFolder(win);
    const t0 = Date.now();
    await run(win);
    const p = await ended(win);
    assert.ok(Date.now() - t0 < 20_000, "seconds, not the 90s of a dev command that can't start");
    assert.equal(p.state, "failed");
    assert.deepEqual(p.tools?.map((t) => [t.tool, t.blocking]), [["node", true], ["docker", false]]);
    assert.equal(p.runId, undefined, "Claude never started");
    const box = win.getByRole("list", { name: "Missing on this computer" });
    await box.getByText("Your app needs Node.js, and it isn't on this computer.").waitFor();
    await box.getByText("Runs with less").waitFor();
    await box.getByRole("button", { name: "Get it from the download page" }).first().waitFor(); // no Homebrew in the fake PATH
    await sleep(800); // the System window's reveal
    await shot(app, "no-node", "missing-tools");

    // The user installs Node with nvm (its PATH line goes in ~/.zshrc), then presses Check again.
    writeFileSync(join(home, ".fake_rc"), `export PATH="${nodeDir(home)}:$PATH"\n`);
    await win.getByRole("button", { name: "Check again" }).click();
    await questReady(win);
    const after = await plan(win);
    assert.deepEqual(after?.tools?.map((t) => t.tool), ["docker"]);
    assert.equal(await win.evaluate(() => window.shrike.getRunStatus().then((s) => s.state)), "running");
  } finally {
    await cleanup();
  }
});

test("a package manager or Python that isn't there: blocked with how to get it", { timeout: 120_000 }, async () => {
  // pnpm project, Node there, no pnpm and no Homebrew: npm can get it.
  const { home, env } = fakeHome();
  env.PATH = `${nodeDir(home)}:${env.PATH}`;
  const pnpmApp = tinyApp({ "package.json": JSON.stringify({ name: "tiny", packageManager: "pnpm@9.0.0", scripts: { dev: "node server.js" } }) }, "pnpm dev", 5999);
  // Python project on a Mac without the developer tools: /usr/bin/python3 is a stub that fails.
  const py = fakeHome({ bin: { python3: 'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2; exit 1' } });
  const pyApp = tinyApp({ "requirements.txt": "flask\n" }, "python3 -m http.server 5998", 5998);
  for (const [name, e, root, tool, command] of [["no-pnpm", env, pnpmApp, "pnpm", "npm install -g pnpm"], ["no-python", py.env, pyApp, "python", undefined]] as const) {
    const { app, win, cleanup } = await launch({ ...e, SHRIKE_OPEN_FOLDER: root });
    try {
      await openFolder(win);
      await run(win);
      const p = await ended(win);
      assert.deepEqual(p.tools?.map((t) => [t.tool, t.blocking, t.command]), [[tool, true, command]]);
      await win.getByRole("button", { name: "Check again" }).waitFor();
      if (command) await win.getByRole("button", { name: `Copy ${command}` }).waitFor();
      await sleep(800);
      await shot(app, name, "missing-tools");
    } finally {
      await cleanup();
    }
  }
});

test("Python older than 3.12: the app still runs, and Shrike says steps need 3.12", { timeout: 180_000, skip: !existsSync("/usr/bin/python3") && "needs /usr/bin/python3" }, async (t) => {
  const v = (await import("node:child_process")).execFileSync("/usr/bin/python3", ["-c", "import sys; print(sys.version_info >= (3, 12))"], { encoding: "utf8" }).trim();
  if (v !== "False") return t.skip("/usr/bin/python3 is 3.12 or newer here");
  const { home, env } = fakeHome();
  env.PATH = `${nodeDir(home)}:${env.PATH}`; // the recorded start checks node -v first
  const port = await freePort();
  const root = tinyApp({ "requirements.txt": "flask\n" }, `python3 -m http.server ${port}`, port);
  const { app, win, cleanup } = await launch({ ...env, SHRIKE_OPEN_FOLDER: root });
  try {
    await openFolder(win);
    await run(win);
    await waitFor("the Python note", async () => (await plan(win))?.tools?.length);
    await win.getByText(/older than 3\.12, so Shrike can't show the steps inside your Python server/).waitFor();
    await sleep(800);
    await shot(app, "old-python-running", "missing-tools");
    await questReady(win);
    assert.deepEqual((await plan(win))?.tools?.map((x) => [x.tool, x.blocking]), [["python", false]]);
  } finally {
    await cleanup();
  }
});

const OLD = process.env.SHRIKE_E2E_OLD_NODE;
test("Node older than 18.19: the app runs without the recorder instead of failing to start", { timeout: 180_000, skip: !OLD && "set SHRIKE_E2E_OLD_NODE to a Node 18.17 bin folder" }, async () => {
  const { home, env } = fakeHome();
  env.PATH = `${nodeDir(home, OLD)}:${env.PATH}`;
  const port = await freePort();
  const server = `require("http").createServer((q, r) => r.end(require("fs").readFileSync("index.html"))).listen(${port}, () => console.log("Local: http://localhost:${port}/"));`;
  const root = tinyApp({ "server.js": server, "package.json": JSON.stringify({ name: "tiny", scripts: { dev: "node server.js" } }) }, "npm run dev", port);
  const { app, win, cleanup } = await launch({ ...env, SHRIKE_OPEN_FOLDER: root });
  try {
    await openFolder(win);
    await run(win);
    await win.getByText(/older than 18\.19, so Shrike can't see inside your server/).waitFor();
    await sleep(800);
    await shot(app, "old-node-starting", "missing-tools");
    await questReady(win);
    const p = await plan(win);
    assert.deepEqual(p?.tools?.map((x) => [x.tool, x.blocking]), [["node", false]]);
    assert.match(p!.tools![0]!.found ?? "", /^v18\.17/);
    await shot(app, "old-node-running", "missing-tools");
  } finally {
    await cleanup();
  }
});

test("no git (macOS without the developer tools) and no Claude: plain words, nothing breaks", { timeout: 120_000 }, async () => {
  const { home, env } = fakeHome({ bin: { git: 'echo "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)" >&2; exit 1' } });
  env.PATH = `${nodeDir(home)}:${env.PATH}`;
  const root = fixtureCopy("todo-app", { git: true });
  const { app, win, cleanup } = await launch({ ...env, SHRIKE_OPEN_FOLDER: root, SHRIKE_CLAUDE_BIN: "", ANTHROPIC_API_KEY: "" });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    if (await win.getByRole("button", { name: "Close setup" }).count()) await win.getByRole("button", { name: "Close setup" }).click();
    await key(win, "Meta+Shift+KeyG");
    await win.getByRole("complementary", { name: "Right dock" }).getByText("Git isn't on this computer.").waitFor({ timeout: 20_000 });
    await shot(app, "no-git", "missing-tools");
    await run(win);
    const p = await ended(win);
    assert.match(p.error ?? "", /Claude isn't set up yet/);
    await sleep(800);
    await shot(app, "no-claude", "missing-tools");
  } finally {
    await cleanup();
  }
});
