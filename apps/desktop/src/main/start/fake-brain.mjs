#!/usr/bin/env node
// Test stand-in for the `claude` CLI (SHRIKE_CLAUDE_BIN) in start tests: calls Shrike's start tools for real over MCP,
// and prints stream-json like Claude Code. FAKE_START picks the script; FAKE_PORT is the port the fixture server listens on.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.280 (Claude Code)");
  process.exit(0);
}
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const { url, headers } = JSON.parse(opt("--mcp-config")).mcpServers.shrike;
const resume = opt("--resume");
const scenario = process.env.FAKE_START ?? "first";
const port = process.env.FAKE_PORT;
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ resume: resume ?? null, effort: opt("--effort"), tools: opt("--tools"), system: readFileSync(opt("--append-system-prompt-file"), "utf8").slice(0, 20000) })}\n`);

let sid;
let rpcId = 0;
async function rpc(method, params, notify = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id: ++rpcId }) }),
  });
  sid ??= res.headers.get("mcp-session-id") ?? undefined;
  const text = await res.text();
  if (notify) return undefined;
  const line = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).find((l) => l.includes(`"id":${rpcId}`)) ?? text;
  return JSON.parse(line).result;
}
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: "fake-session" })}\n`);
let n = 0;
async function call(name, input) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ call: name })}\n`);
  const id = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id, name: `mcp__shrike__${name}`, input }] } });
  const r = await rpc("tools/call", { name, arguments: input });
  const text = r.content.map((c) => c.text).join("\n");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: !!r.isError }] } });
  return { text, error: !!r.isError };
}
const say = (text) => out({ type: "assistant", message: { id: `msg_s${++n}`, content: [{ type: "text", text }] } });

out({ type: "system", subtype: "init", session_id: "fake-session", mcp_servers: [{ name: "shrike", status: "connected" }], model: "claude-opus-5-5[1m]" });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.280" } });
await rpc("notifications/initialized", {}, true);

const page = `http://127.0.0.1:${port}/`;
const BODY = `## Prerequisites\n\nNode 24.\n\n## Run\n\n1. Start the server: \`node server.mjs\` (port ${port})\n\n## Health checks\n\n- \`${page}\` answers 200\n\n## Gotchas\n\n- none yet\n\n## Stop\n\nStop it from Shrike.`;

if (resume) {
  // the nudge: end with a skill (a lesson when it never came up)
  if (scenario === "fail") await call("propose_lesson", { lesson: "Check the entry file exists before starting a Node service." });
  else await call("save_run_skill", { body: BODY });
} else {
  say("Reading the project first.");
  if (scenario === "learned" || scenario === "again") await call("read_recipe", { id: "shrike:run-fixture-app" });
  await call("plan_steps", {
    source: scenario === "first" || scenario === "noskill" || scenario === "fail" ? "explored" : "shrike-skill",
    ...(scenario === "again" || scenario === "learned" ? { skillId: "run-fixture-app" } : {}),
    services: [{ name: "web", port: Number(port), url: page }],
    steps: [
      { id: "look", title: "Check Node is there", kind: "check", command: "node -v" },
      { id: "web", title: `Start the web page on port ${port}`, kind: "service", command: "node server.mjs", service: "web" },
    ],
  });
  await call("run_command", { step: "look", title: "Check Node is there", command: "node -v" });
  const blocked = await call("run_command", { title: "Push the code", command: "git push origin main" });
  if (!blocked.error) throw new Error("git push should be refused");
  if (scenario === "fail") {
    await call("start_service", { step: "web", name: "web", command: "node missing.mjs", url: page, instrument: false, waitSec: 3 });
    say("It can't find the server file. Giving up.");
  } else {
    await call("start_service", { step: "web", name: "web", command: "node missing.mjs", url: page, instrument: false, waitSec: 3 });
    await call("start_service", { step: "web", name: "web", command: "node server.mjs", url: page, instrument: false, waitSec: 3 });
    await call("check_health", { step: "web", target: page, service: "web", timeoutSec: 20, fix: "Started server.mjs, the file that exists" });
    const ready = await call("app_ready", { url: page });
    if (ready.error) throw new Error(ready.text);
    if (scenario === "first") {
      await call("save_run_skill", { body: BODY, learned: "The server file is server.mjs" });
      await call("propose_lesson", { lesson: "Check the entry file exists before starting a Node service." });
    } else if (scenario === "again") await call("mark_skill_used", { skillId: "run-fixture-app" });
    else if (scenario === "learned") await call("save_run_skill", { body: `${BODY}\n- server.mjs is the entry, not index.js`, learned: "server.mjs is the entry" });
  }
}
out({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0 });
process.exit(0);
