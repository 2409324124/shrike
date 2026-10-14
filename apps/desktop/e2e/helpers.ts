// Shared helpers for the e2e tests. They drive the BUILT app (run `pnpm build` first).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import electronPath from "electron"; // the binary's path when imported from Node
import type { ActionView, DebugEvent, TimelineNode } from "@shrike/schema";

const desktop = join(import.meta.dirname, "..");
export const SHOTS = process.env.SHRIKE_E2E_SHOTS ?? join(tmpdir(), "shrike-e2e");
mkdirSync(SHOTS, { recursive: true });

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function flatten(nodes: TimelineNode[]): DebugEvent[] {
  return nodes.flatMap((n) => [n.event, ...flatten(n.children)]);
}

// Playwright's page screenshot mis-composites <webview>; capturePage shows what the user sees.
export async function shot(app: ElectronApplication, name: string, prefix = "v5-e2e"): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await (BrowserWindow.getAllWindows().find((w) => !w.getParentWindow() && w.isVisible()) ?? BrowserWindow.getAllWindows().find((w) => !w.getParentWindow()))!.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(join(SHOTS, `${prefix}-${name}.png`), Buffer.from(b64, "base64"));
}

/** Launch the built app; pass `userData` to relaunch on the same data (the caller removes it). */
export async function launch(env: Record<string, string> = {}, keep?: string, args: string[] = []): Promise<{ app: ElectronApplication; win: Page; userData: string; cleanup(): Promise<void> }> {
  const userData = keep ?? mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  // Every Run is Claude's start quest (R5): without SHRIKE_E2E_AGENT it plays the recorded start stream (fake-start.mjs).
  const start = process.env.SHRIKE_E2E_AGENT || process.env.SHRIKE_CLAUDE_BIN ? {} : { SHRIKE_CLAUDE_BIN: startBin() };
  const app = await _electron.launch({ executablePath: electronPath as unknown as string, args: [".", `--user-data-dir=${userData}`, ...args], cwd: process.env.SHRIKE_E2E_APP ?? desktop, env: { ...process.env, ...start, ...env } as Record<string, string> }); // SHRIKE_E2E_APP: a build kept apart from out/
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
  return {
    app,
    win,
    userData,
    async cleanup() {
      await app.close().catch(() => {});
      for (const f of ["todo-app", "shop-app", "api-only", "py-app", "py-api-only", "flask-api-only", "polyglot", "py-edge", "react-fastapi", "react-django"]) removeRunSkills(join(repo, "fixtures", f));
      if (!keep) rmSync(userData, { recursive: true, force: true });
    },
  };
}

let startBinPath: string | undefined;
function startBin(): string {
  if (startBinPath) return startBinPath;
  startBinPath = join(mkdtempSync(join(tmpdir(), "shrike-e2e-start-")), "claude");
  writeFileSync(startBinPath, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  return startBinPath;
}

/** Wait for Claude's start quest to end ready (R5): the dock shows the live app. */
export async function questReady(win: Page, timeoutMs = process.env.SHRIKE_E2E_AGENT === "1" ? 600_000 : 120_000): Promise<void> { // a real Claude start takes minutes
  await waitFor(
    "the start quest to complete",
    async () => {
      const p = await win.evaluate(() => window.shrike.getStartPlan());
      if (p?.state === "failed") throw new Error(`the start failed: ${p.error}`);
      return p?.state === "ready";
    },
    timeoutMs,
  ).catch(async (e) => {
    const p = await win.evaluate(() => window.shrike.getStartPlan()).catch(() => null);
    throw new Error(`${(e as Error).message}\n${JSON.stringify(p?.steps?.map((s) => [s.title, s.state, s.detail]))}`);
  });
  await dismissResult(win, 3000);
}

/** XP3: a finished quest opens the results screen over the Thread; close it like a user (Esc) so it can't take the next key or click. */
export async function dismissResult(win: Page, waitMs = 0): Promise<void> {
  const scrim = win.locator(".xr-scrim");
  if (waitMs) await scrim.waitFor({ timeout: waitMs }).catch(() => {});
  for (let i = 0; i < 5 && (await scrim.count()); i++) {
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Escape");
    await sleep(150);
  }
}

/** Run skills the recorded start wrote into a fixture in the repo (demo, shop, api-only open fixtures in place). */
export function removeRunSkills(root: string): void {
  const dir = join(root, ".shrike", "skills");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (/^run-/.test(f)) rmSync(join(dir, f), { recursive: true, force: true });
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
}

// Welcome -> sample project -> Run -> the todo app is visible in the docked app. Returns the guest page.
export async function openSampleAndRun(app: ElectronApplication, win: Page): Promise<Page> {
  await win.getByRole("button", { name: "Open the sample project" }).click();
  await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
  await questReady(win);
  const guest = await waitFor("the app pane to load the todo app", () => app.windows().find((p) => p.url().startsWith("http://localhost:5173")), 60_000);
  await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
  return guest;
}

// fill() doesn't reach a <webview> guest's input reliably; click and type like a person.
export async function typeTodo(guest: Page, text: string): Promise<void> {
  const input = guest.getByPlaceholder("What needs doing?");
  await input.click();
  await guest.keyboard.type(text);
  await waitFor(`the input to read "${text}"`, async () => (await input.inputValue()) === text, 5000);
}

export const actions = (win: Page) => win.evaluate(() => window.shrike.getActions()) as Promise<ActionView[]>;

export async function addTodoAction(win: Page, after = 0): Promise<ActionView> {
  return waitFor(
    'a complete "Add Todo" action',
    async () => (await actions(win)).find((a) => a.label === 'Clicked "Add Todo"' && a.complete && a.startMs > after),
    20_000,
  );
}

/** The caption under the feed: the focused station in plain words. */
export const caption = (win: Page) => win.locator("section[aria-label=Shrike] p[aria-live=polite]:not([role=status])").innerText();

export interface StationInfo {
  lane: string; // place id, e.g. client:http://localhost:5173
  kind: string; // the lane's place kind: caller (SCREEN), client (PAGE), service (SERVER), data (DATABASE), cache, outside
  label: string;
  where: string;
  chip: string;
  cls: string;
  y: number;
}

/** A trip as drawn: header, stations in order (with lanes), return words. */
export function tripDom(win: Page, actionId: string) {
  return win.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`.th-trip[data-trip="${id}"]`);
    if (!el) return null;
    const stations = [...el.querySelectorAll<HTMLElement>(".th-st")].map((b) => {
      const lab = el.querySelector<HTMLElement>(`.th-lab[data-i="${b.dataset.i}"]`);
      return {
        lane: b.dataset.lane ?? "",
        kind: (b.dataset.lane ?? "").split(":")[0]!,
        label: lab?.querySelector(".n")?.textContent ?? lab?.firstChild?.textContent ?? "",
        where: lab?.querySelector("small")?.textContent ?? "",
        chip: lab?.querySelector(".th-chip")?.textContent ?? "",
        cls: b.className,
        y: b.offsetTop,
      };
    });
    return {
      title: el.querySelector(".th-head .t")?.textContent ?? "",
      verdict: el.querySelector(".th-verdict")?.textContent ?? "",
      returned: el.querySelector(".th-retlab")?.textContent ?? "",
      focused: el.classList.contains("focus"),
      stations,
    };
  }, actionId);
}

export async function isListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** lsof's LISTEN lines for these ports; "" when all are free. */
export function listening(ports: number[]): string {
  try {
    return execFileSync("lsof", ["-nP", ...ports.map((p) => `-iTCP:${p}`), "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? "").trim(); // lsof exits 1 when any one port is free
  }
}

const repo = join(desktop, "../..");

/** A free local port. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(port));
    });
    srv.on("error", fail);
  });
}

/**
 * A throwaway copy of fixtures/<name> under the temp dir: node_modules linked entry by entry (so caches like .vite
 * stay private), local ports in .shrike/config.json moved (`ports`: old -> new), optionally a git repo with one commit.
 */
export function fixtureCopy(name: string, o: { ports?: Record<number, number>; git?: boolean } = {}): string {
  const src = join(repo, "fixtures", name);
  const dst = join(mkdtempSync(join(tmpdir(), `shrike-e2e-${name}-`)), name);
  cpSync(src, dst, { recursive: true, filter: (f) => !/\/(node_modules|\.venv|\.data|\.shrike\/(flows|worktrees|skills|commands))(\/|$)/.test(f.slice(src.length)) });
  // The root's and each top folder's (web/, api/): node_modules entry by entry, a Python .venv whole.
  for (const d of ["", ...readdirSync(src).filter((e) => !e.startsWith(".") && e !== "node_modules")]) {
    if (existsSync(join(src, d, "node_modules"))) {
      mkdirSync(join(dst, d, "node_modules"));
      for (const e of readdirSync(join(src, d, "node_modules"))) if (e !== ".vite") symlinkSync(join(src, d, "node_modules", e), join(dst, d, "node_modules", e));
    }
    if (existsSync(join(src, d, ".venv"))) symlinkSync(join(src, d, ".venv"), join(dst, d, ".venv"));
  }
  const cfg = join(dst, ".shrike", "config.json");
  if (o.ports && existsSync(cfg)) {
    let text = readFileSync(cfg, "utf8");
    for (const [from, to] of Object.entries(o.ports)) text = text.replaceAll(`localhost:${from}`, `localhost:${to}`);
    writeFileSync(cfg, text);
  }
  if (o.git) {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Shrike e2e", "-c", "user.email=e2e@shrike.invalid", ...args], { cwd: dst, stdio: "pipe" });
    writeFileSync(join(dst, ".gitignore"), `${existsSync(join(src, ".gitignore")) ? readFileSync(join(src, ".gitignore"), "utf8") : ""}\nnode_modules\n.data\n.shrike/issues\n`);
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
  }
  return realpathSync(dst); // Shrike opens the real path; macOS tmpdir is /var → /private/var
}

/** Git in a test repo, with a fixed author. */
export const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Shrike e2e", "-c", "user.email=e2e@shrike.invalid", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** An outside MCP client on Shrike's own server (what the owner's Claude Code would be), from <userData>/mcp.json. */
export async function mcpClient(app: ElectronApplication, name = "e2e") {
  const req = createRequire(join(repo, "packages/mcp-server/package.json"));
  const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = req("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  const cfg = await waitFor("Shrike's MCP server", () => existsSync(join(userData, "mcp.json")) && JSON.parse(readFileSync(join(userData, "mcp.json"), "utf8")));
  const c = new Client({ name, version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(cfg.mcpServers.shrike.url), { requestInit: { headers: cfg.mcpServers.shrike.headers } }));
  return {
    async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
      const r = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
      return (r.content as { text: string }[]).map((x) => x.text).join("\n");
    },
    close: () => c.close() as Promise<void>,
  };
}

/** Open a folder through the welcome screen (SHRIKE_OPEN_FOLDER answers the folder picker). */
export async function openFolder(win: Page): Promise<void> {
  await win.getByRole("button", { name: "Open a folder" }).click();
  await win.getByRole("banner").waitFor();
}

/** A key press for the shell (not a text field). */
export async function key(win: Page, k: string): Promise<void> {
  await dismissResult(win);
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press(k);
  await sleep(200);
}

/** Every file under ~/.claude/skills with its mtime and size: Shrike only ever reads them. */
export function claudeSkillsListing(): string {
  const dir = join(process.env.HOME ?? "", ".claude", "skills");
  if (!existsSync(dir)) return "";
  // synced/ is Claude Code's own skill cache: the real `claude` CLI (the agent brain) refreshes it on its own.
  return execFileSync("find", [dir, "-path", join(dir, "synced"), "-prune", "-o", "-exec", "stat", "-f", "%m %z %N", "{}", "+"], { encoding: "utf8" }).split("\n").sort().join("\n");
}

/** A recorded-stream `claude` for SHRIKE_CLAUDE_BIN (see fake-claude.mjs): env to launch with, its calls, and a session file's bytes. */
export function fakeClaude(delayMs = 250) {
  const dir = mkdtempSync(join(tmpdir(), "shrike-e2e-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-claude.mjs")}" "$@"\n`, { mode: 0o755 });
  const calls = (): { kind: string; session: string; resume?: string; fork: boolean; goal: string; disallowed?: string }[] =>
    existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return {
    dir,
    env: { SHRIKE_CLAUDE_BIN: bin, FAKE_CLAUDE_DIR: dir, FAKE_CLAUDE_DELAY: String(delayMs) },
    calls,
    finished: (session: string) => existsSync(join(dir, `done-${session}`)),
    session: (id: string) => readFileSync(join(dir, "sessions", `${id}.jsonl`), "utf8"),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Open a todo-app copy, run it, click Add Todo once (the planted bug fails it), and ask the agent with Claude Code. */
export async function todoAskAgent(app: ElectronApplication, win: Page, web: number, goal: string): Promise<ActionView> {
  await openFolder(win);
  await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
  await questReady(win);
  const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
  await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
  const closeSetup = win.getByRole("button", { name: "Close setup" });
  if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
  await typeTodo(guest, "buy milk");
  await guest.getByRole("button", { name: "Add Todo" }).click();
  const broken = await addTodoAction(win);
  await win.locator(`.th-trip[data-trip="${broken.id}"]`).waitFor({ timeout: 15_000 });
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press("Meta+k");
  const ask = win.getByRole("dialog", { name: "Ask your agent" });
  const brain = ask.getByRole("combobox", { name: "Which agent to use" });
  if (await brain.count()) await brain.selectOption("claude-code");
  await ask.getByRole("textbox", { name: "Ask your agent" }).fill(goal);
  await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
  await ask.waitFor({ state: "detached" });
  return broken;
}
