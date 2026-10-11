// MCP1 to MCP8 in the built app: a todo-app copy, a fake HOME whose ~/.claude.json has a tiny local stdio MCP server, the recorded Claude.
// The Tools tab checks it (green, tools listed), My tools passes it to the run (the fake brain records the args), the X-ray shows the call,
// [New Tool Unlocked] once, the per-project switch takes it out of the next run, and Claude Code's file is never written. Abyss and Daylight shots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { fakeClaude, fixtureCopy, launch, mcpClient, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const echo = join(import.meta.dirname, "../../../packages/agent/test/fixtures/echo-mcp.mjs");
const echoProcs = () => {
  try {
    return execFileSync("pgrep", ["-f", "echo-mcp.mjs"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

async function ask(win: Page, goal: string, myTools: boolean, snap?: () => Promise<void>): Promise<void> {
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press("Meta+k");
  const dlg = win.getByRole("dialog", { name: "Ask your agent" });
  const brain = dlg.getByRole("combobox", { name: "Which agent to use" });
  if (await brain.count()) await brain.selectOption("claude-code");
  const chip = dlg.getByRole("button", { name: /^My tools/ });
  if (myTools) {
    await chip.waitFor();
    if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
  }
  await dlg.getByRole("textbox", { name: "Ask your agent" }).fill(goal);
  await snap?.();
  await dlg.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
  await dlg.waitFor({ state: "detached" });
}

async function setTheme(win: Page, label: string): Promise<void> {
  await win.getByRole("button", { name: "Appearance" }).click();
  const dlg = win.getByRole("dialog", { name: "Appearance" });
  await dlg.getByRole("radio", { name: `${label} theme` }).click();
  await win.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" });
  await sleep(400);
}

test("MCP: the tools tab checks your servers, the run gets them, the X-ray shows the call, the switch takes one out", { timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "shrike-e2e-home-"));
  const claudeJson = JSON.stringify({ mcpServers: { "echo-tools": { command: process.execPath, args: [echo] } } }, null, 2);
  writeFileSync(join(home, ".claude.json"), claudeJson);
  const proj = fixtureCopy("todo-app");
  const marker = join(home, "repo-tool-started");
  const mcpJson = JSON.stringify({ mcpServers: { "repo-tool": { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`] } } });
  writeFileSync(join(proj, ".mcp.json"), mcpJson); // a cloned repo's server: never started until you trust it
  const cc = fakeClaude(120);
  const { app, win, cleanup } = await launch({ HOME: home, SHRIKE_OPEN_FOLDER: proj, ...cc.env });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();

    // MCP1/MCP2: the Tools tab lists it under Claude Code, checks it for real (start, list tools, close) and goes green.
    await win.getByRole("button", { name: "Tools", exact: true }).first().click();
    const card = win.locator('[data-server="echo-tools"]');
    await card.waitFor({ timeout: 15_000 });
    await waitFor("echo-tools to check green", async () => /Working · 2 tools/.test(await card.innerText()), 30_000);
    assert.match(await win.getByRole("region", { name: "From Claude Code" }).innerText(), /echo-tools/);
    const repoCard = win.locator('[data-server="repo-tool"]');
    assert.match(await repoCard.innerText(), /Waiting for you to trust it[\s\S]*runs[\s\S]*Trust it only if you know it/);
    await card.getByRole("button", { name: "2 tools" }).click();
    await card.getByRole("list", { name: "echo-tools tools" }).getByText("Says back what you send").waitFor();
    // MCP3: the todo app has a page and a SQLite file: quiet suggestions, never more than three.
    const reco = win.getByRole("region", { name: "Suggested for this project" });
    await reco.waitFor();
    assert.ok((await reco.getByRole("listitem").count()) <= 3);
    assert.match(await reco.innerText(), /Chrome DevTools/);
    await sleep(300);
    await shot(app, "tools-abyss", "mcp");
    await waitFor("no health-check process left behind", () => !echoProcs(), 10_000);

    // MCP6: My tools on: the run gets echo-tools in its own 0600 config, its tools allowed, one line in the prompt.
    await ask(win, "When I click Add Todo nothing shows up", true, () => shot(app, "composer", "mcp"));
    await waitFor("the first run to finish", async () => (await win.evaluate(() => window.shrike.listRuns())).some((r) => r.status === "done"), 60_000);
    const first = cc.calls().find((c) => c.kind === "main") as unknown as { mine: string[]; allowed: string; toolsLine: string | null };
    assert.deepEqual(first.mine, ["echo-tools"]);
    assert.match(first.allowed, /\bmcp__shrike\b.*\bmcp__echo-tools\b/);
    assert.match(first.toolsLine ?? "", /^Your own tools this run \(MCP servers the user turned on\): echo-tools\./);

    // MCP8: the call reads in plain words with its glyph and time; a "tools used" strip; [New Tool Unlocked] once.
    const unlocked = win.getByRole("status", { name: "New tool unlocked: echo-tools" });
    await unlocked.waitFor({ timeout: 20_000 });
    await shot(app, "unlocked", "mcp");
    await unlocked.click();
    await unlocked.waitFor({ state: "detached", timeout: 5000 });
    const agent = win.getByRole("complementary", { name: "Agent" });
    await agent.hover();
    const strip = agent.getByRole("list", { name: "Tools used this run" });
    await strip.waitFor({ timeout: 10_000 });
    assert.match(await strip.innerText(), /echo-tools\s*×1/);
    await agent.hover();
    await sleep(300);
    await shot(app, "xray", "mcp");
    const steps = await win.evaluate(async () => {
      const r = (await window.shrike.listRuns()).find((x) => x.status === "done")!;
      return (await window.shrike.getRunSteps(r.id)).map((s) => s.text);
    });
    assert.ok(steps.includes("Using echo-tools: echo"), steps.join(" | "));

    // MCP2: switched off for this project, the next run doesn't get it, and no window says unlocked again.
    await card.getByRole("switch", { name: "Use echo-tools in this project" }).click();
    await waitFor("the card to read Off", async () => /\bOff\b/.test(await card.innerText()), 5000);
    assert.equal(await win.getByRole("switch", { name: /^Your agent gets these/ }).getAttribute("aria-checked"), "true", "My tools is still on");
    await ask(win, "Look again", false);
    await waitFor("a second main run", () => cc.calls().filter((c) => c.kind === "main").length === 2, 30_000);
    const second = cc.calls().filter((c) => c.kind === "main")[1] as unknown as { mine: string[]; allowed: string; toolsLine: string | null };
    assert.deepEqual(second.mine, []);
    assert.doesNotMatch(second.allowed, /echo-tools/);
    assert.equal(second.toolsLine, null);
    await card.getByRole("switch", { name: "Use echo-tools in this project" }).click();
    await waitFor("back on", async () => /Working|Checking|Not checked/.test(await card.innerText()), 5000);

    // Daylight: the same tab, tokens only.
    await setTheme(win, "Daylight");
    await shot(app, "tools-daylight", "mcp");
    await win.getByRole("button", { name: "Chrome DevTools: Opens your app in Chrome and clicks, types, reads the console and network, and takes screenshots." }).click();
    const form = win.getByRole("group", { name: "Add Chrome DevTools" });
    await form.waitFor();
    await form.scrollIntoViewIfNeeded();
    await sleep(400);
    await shot(app, "add-daylight", "mcp");
    await setTheme(win, "Abyss");
    await shot(app, "add-abyss", "mcp");

    assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), claudeJson, "Claude Code's file is never written");
    assert.equal(readFileSync(join(proj, ".mcp.json"), "utf8"), mcpJson, "the project's .mcp.json is never written");
    assert.equal(existsSync(marker), false, "an untrusted .mcp.json server never started");
  } finally {
    await cleanup();
    cc.remove();
    rmSync(dirname(proj), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
  await waitFor("no MCP server left running after quit", () => !echoProcs(), 10_000);
});

test("MCP9: your own Claude Code keeps the same address and token after a restart; a new token cuts the old one", { timeout: 240_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "shrike-e2e-home-"));
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  const proj = fixtureCopy("todo-app");
  const file = join(userData, "mcp.json");
  const saved = () => waitFor("mcp.json", () => existsSync(file) && (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: { shrike: { url: string; headers: { Authorization: string } } } }).mcpServers.shrike);
  const openConnect = async (win: Page) => {
    await openFolder(win);
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    const box = win.getByRole("region", { name: "Use from your own Claude Code" });
    // the dock remembers the Tools tab across a restart
    if (!(await box.isVisible({ timeout: 3000 }).catch(() => false))) await win.getByRole("button", { name: "Tools", exact: true }).first().click();
    await box.waitFor({ timeout: 15_000 });
    return box;
  };
  let run = await launch({ HOME: home, SHRIKE_OPEN_FOLDER: proj }, userData);
  let first: Awaited<ReturnType<typeof saved>>;
  try {
    await run.win.emulateMedia({ reducedMotion: "reduce" });
    first = await saved();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const box = await openConnect(run.win);
    assert.match(await box.innerText(), /Nothing connected yet/);
    const c = await mcpClient(run.app, "claude-code");
    assert.match(await c.call("list_trips"), /No trips yet|\d/);
    await waitFor("claude-code to show as connected", async () => /claude-code/.test(await box.innerText()), 10_000);
    const token = first.headers.Authorization.slice("Bearer ".length);
    assert.doesNotMatch(await box.innerText(), new RegExp(token), "the token stays hidden until you show it");
    await run.win.evaluate(() => {
      const w = window as unknown as { copied: string[] };
      w.copied = [];
      navigator.clipboard.writeText = async (t: string) => void w.copied.push(t); // the real clipboard is left alone
    });
    await box.getByRole("button", { name: "Copy the command" }).click();
    await box.getByRole("button", { name: "Copy the skill" }).click();
    await box.getByRole("button", { name: "Copy the settings" }).click();
    const copied = await run.win.evaluate(() => (window as unknown as { copied: string[] }).copied);
    assert.equal(copied[0], `claude mcp add --transport http --scope user shrike ${first.url} --header "Authorization: Bearer ${token}"`);
    assert.match(copied[1]!, /^---\nname: shrike\n[\s\S]*propose_patch/);
    assert.deepEqual(JSON.parse(copied[2]!).permissions.deny, ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
    await box.scrollIntoViewIfNeeded();
    await sleep(300);
    await shot(run.app, "connect", "mcp");
    await c.close();
  } finally {
    await run.cleanup(); // userData is kept for the restart
  }

  run = await launch({ HOME: home, SHRIKE_OPEN_FOLDER: proj }, userData);
  try {
    const again = await saved();
    await waitFor("the server on the saved address", async () => (await fetch(first.url, { method: "POST" }).catch(() => null))?.status === 401, 15_000);
    assert.deepEqual(again, first, "same address and token after a restart");
    const c = await mcpClient(run.app, "claude-code"); // the config Claude Code saved the first time
    assert.ok((await c.call("list_trips")).length > 0);
    const box = await openConnect(run.win);

    // A patch from your own Claude Code still waits for your click, and the card says who sent it.
    const line = readFileSync(join(proj, "server/todos.controller.ts"), "utf8").split("\n").find((l) => l.trim().length > 8)!;
    const before = readFileSync(join(proj, "server/todos.controller.ts"), "utf8");
    const proposed = c.call("propose_patch", { files: [{ path: "server/todos.controller.ts", edits: [{ oldText: line, newText: `${line} // e2e` }] }], rationale: "A test change from outside." });
    const card = run.win.getByRole("region", { name: "Fix" });
    await card.getByText("From claude-code").waitFor({ timeout: 15_000 });
    await sleep(300);
    await shot(run.app, "connect-approval", "mcp");
    await card.getByRole("button", { name: "Not now" }).click();
    assert.match(await proposed, /rejected/);
    assert.equal(readFileSync(join(proj, "server/todos.controller.ts"), "utf8"), before, "nothing changes without your click");

    await box.getByRole("button", { name: "New token" }).click();
    await box.getByText(/New token made/).waitFor();
    const rotated = await waitFor("a new token in mcp.json", async () => {
      const s = await saved();
      return s.headers.Authorization !== first.headers.Authorization && s;
    });
    assert.equal(rotated.url, first.url, "the address stays");
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const post = (auth: string) => fetch(first.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth }, body: JSON.stringify(init) });
    assert.equal((await post(first.headers.Authorization)).status, 401, "the old token is cut off");
    assert.equal((await post(rotated.headers.Authorization)).status, 200);
    await c.close().catch(() => {});
    assert.equal(existsSync(join(home, ".claude")), false, "Shrike never writes Claude Code's files");
    assert.equal(existsSync(join(home, ".claude.json")), false);
  } finally {
    await run.cleanup();
    rmSync(userData, { recursive: true, force: true });
    rmSync(dirname(proj), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
