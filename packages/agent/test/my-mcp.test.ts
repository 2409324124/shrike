import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkMcpServer, claudeArgs, mcpPromptLine, readMyMcpServers, withMyMcp } from "../src/index.ts";
import { toolUseStep } from "../src/steps.ts";

test("B4: the user's MCP servers come from ~/.claude.json and .mcp.json, read-only, and join Shrike's", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "shrike-home-"));
  const root = mkdtempSync(path.join(os.tmpdir(), "shrike-proj-"));
  const claudeJson = JSON.stringify({
    mcpServers: { "chrome-devtools": { type: "stdio", command: "npx", args: ["chrome-devtools-mcp@latest"], env: { TOKEN: "t0ps3cret" } }, pencil: { command: "pencil" }, shrike: { url: "http://evil" }, "bad name": { command: "x" }, empty: {} },
    projects: { [root]: { mcpServers: { pencil: { command: "pencil-local" } } }, "/elsewhere": { mcpServers: { other: { command: "o" } } } },
  });
  writeFileSync(path.join(home, ".claude.json"), claudeJson);
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { type: "http", url: "http://localhost:9/mcp" }, pencil: { command: "pencil-project" } } }));

  const mine = await readMyMcpServers(root, home);
  assert.deepEqual(Object.keys(mine).sort(), ["chrome-devtools", "pencil", "playwright"]);
  assert.equal(mine.pencil!.command, "pencil-local", "local scope wins, like Claude Code");
  assert.equal(readFileSync(path.join(home, ".claude.json"), "utf8"), claudeJson, "never written");
  assert.deepEqual(await readMyMcpServers(root, path.join(home, "missing")), { playwright: { type: "http", url: "http://localhost:9/mcp" }, pencil: { command: "pencil-project" } });

  const base = claudeArgs("goal", { url: "http://127.0.0.1:1/mcp", token: "tok" }, "sys");
  const { args, remove } = await withMyMcp(base, mine);
  const at = args.indexOf("--mcp-config");
  assert.match(args[at + 1]!, /"shrike"/, "Shrike's own config stays first");
  const file = args[at + 2]!;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers).sort(), ["chrome-devtools", "pencil", "playwright"]);
  assert.ok(!args.join(" ").includes("t0ps3cret"), "env tokens never on the command line");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__shrike mcp__chrome-devtools mcp__pencil mcp__playwright");
  assert.ok(args.includes("--strict-mcp-config"));
  await remove();
  assert.ok(!existsSync(file));

  // Off, or nothing configured: Shrike's args unchanged.
  assert.deepEqual((await withMyMcp(base, {})).args, base);
});

const echo = path.join(import.meta.dirname, "fixtures", "echo-mcp.mjs");
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("MCP1: the health check starts a stdio server, lists its tools, closes it and leaves nothing running", async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), "shrike-echo-")), "child.pid");
  const r = await checkMcpServer({ command: process.execPath, args: [echo], env: { ECHO_MCP_CHILD: pidFile } }, { timeoutMs: 15_000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools, [{ name: "echo", description: "Says back what you send" }, { name: "add", description: "Adds two numbers" }]);
  const child = Number(readFileSync(pidFile, "utf8"));
  await new Promise((d) => setTimeout(d, 300));
  assert.ok(gone(child), "the server's own child process is gone too");
});

test("MCP1: a server that never answers times out in plain words, and is killed", async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), "shrike-echo-")), "child.pid");
  const t0 = Date.now();
  const r = await checkMcpServer({ command: process.execPath, args: [echo], env: { ECHO_MCP_HANG: "1", ECHO_MCP_CHILD: pidFile } }, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /didn't answer within 2 seconds/);
  assert.ok(Date.now() - t0 < 8000);
  await new Promise((d) => setTimeout(d, 300));
  assert.ok(gone(Number(readFileSync(pidFile, "utf8"))));
});

test("MCP1: a missing command and a closed port say what to do", async () => {
  const a = await checkMcpServer({ command: "definitely-not-a-command-shrike" }, { timeoutMs: 5000 });
  assert.match(a.error!, /Couldn't find "definitely-not-a-command-shrike"/);
  const b = await checkMcpServer({ type: "http", url: "http://127.0.0.1:9/mcp" }, { timeoutMs: 5000 });
  assert.equal(b.ok, false);
  assert.match(b.error!, /^Nothing answered at http:\/\/127\.0\.0\.1:9\/mcp\./);
});

test("MCP5/MCP6: a call to the user's own server reads in plain words; the prompt names the servers in one line", () => {
  const s = toolUseStep("mcp__chrome-devtools__take_snapshot", {});
  assert.deepEqual([s.kind, s.tool, s.text], ["tool_call", "mcp__chrome-devtools__take_snapshot", "Using chrome-devtools: take snapshot"]);
  assert.equal(toolUseStep("mcp__shrike__read_file", { path: "a.ts" }).tool, "read_file");
  assert.equal(mcpPromptLine([]), "");
  assert.equal(mcpPromptLine(["chrome-devtools", "github"]).split("\n").length, 1);
  assert.match(mcpPromptLine(["chrome-devtools", "github"]), /chrome-devtools, github/);
});
