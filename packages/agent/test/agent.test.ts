import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionView, AgentRunInfo, AgentStep, AgentUsage, Finding, ShrikeHost } from "@shrike/schema";
import { buildSystemPrompt, claudeArgs, createStreamParser, effortFor, fillTemplate, goalWithOptions, PLAN_FIRST, startAgentRun, type AnthropicLike, type UsageInput } from "../src/index.ts";
import { runClaudeCode } from "../src/claude-code.ts";
import type { StepInput } from "../src/steps.ts";
import { startMcpServer } from "../../mcp-server/src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const promptsDir = path.resolve(here, "../../../prompts/agent");
const fixture = (name: string) => fs.readFile(path.join(here, "fixtures", name), "utf8");

function parseAll(text: string, chunk = 7) {
  const steps: StepInput[] = [];
  const usage: UsageInput[] = [];
  const sessions: string[] = [];
  const p = createStreamParser((s) => steps.push(s), { onUsage: (u) => usage.push(u), onSession: (id) => sessions.push(id) });
  for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
  p.end();
  return { steps, state: p.state, usage, sessions };
}

test("parses a real Claude Code stream-json run, split across odd chunk boundaries", async () => {
  // Recorded from `claude -p ... --output-format stream-json --verbose --tools "" --allowedTools mcp__shrike` v2.1.280.
  const text = await fixture("claude-stream.jsonl");
  const init = JSON.parse(text.split("\n").find((l) => l.includes('"subtype":"init"'))!);
  assert.deepEqual(init.tools, ["mcp__shrike__get_action"]); // --tools "" leaves only MCP tools

  for (const chunk of [1, 7, 4096]) {
    const { steps, state } = parseAll(text, chunk);
    assert.deepEqual(steps.map((s) => s.kind), ["tool_call", "tool_result", "message", "done"]);
    assert.deepEqual(steps[0], { kind: "tool_call", tool: "get_action", text: "Reading what happened", activity: "Reading what happened", detail: '{"actionId":"abc123"}', usage: { input: 2, output: 24, cacheRead: 0, cacheWrite: 4246 } }); // X1, X6
    assert.equal(steps[1]!.tool, "get_action");
    assert.equal(steps[1]!.text, "Action abc123");
    assert.match(steps[1]!.detail!, /Clicked "Add Todo"/);
    assert.match(steps[2]!.text, /^done\./);
    assert.equal(state.gotResult, true);
    assert.equal(state.resultError, false);
  }
});

test("a not-logged-in Claude Code run becomes one friendly error step", async () => {
  const { steps, state } = parseAll(await fixture("claude-not-logged-in.jsonl"));
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, "error");
  assert.match(steps[0]!.text, /Sign in to Claude Code/);
  assert.equal(state.resultError, true);
});

test("an offline Claude Code run says why it's still working, once", () => {
  const retry = (attempt: number) => JSON.stringify({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown" });
  const { steps } = parseAll([1, 2, 3, 4, 5].map(retry).join("\n") + "\n");
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, "message");
  assert.match(steps[0]!.text, /can't reach Claude's servers/);
});

test("maps findings, patches, action ids and friendly tool text", () => {
  const id = "0123456789abcdef";
  const findings: Finding[] = [{ confidence: "observed", claim: "Server read req.body.user", file: "server/todos.controller.ts", line: 18 }];
  const lines = [
    "not json at all",
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "mcp__shrike__app_click", input: { name: "Add Todo" } },
      { type: "tool_use", id: "t2", name: "mcp__shrike__read_file", input: { path: "server/todos.controller.ts" } },
      { type: "tool_use", id: "t3", name: "mcp__shrike__send_request", input: { method: "post", url: "/api/todos" } },
      { type: "tool_use", id: "t4", name: "mcp__shrike__run_scenario", input: { steps: [] } },
      { type: "tool_use", id: "t5", name: "mcp__shrike__propose_patch", input: {} },
      { type: "tool_use", id: "t6", name: "mcp__shrike__report_findings", input: { findings, summary: "Wrong field name." } },
      { type: "thinking", thinking: "hidden" },
    ] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `Clicked [e2] button "Add Todo".\nAction ${id} · Clicked "Add Todo" · error` }] },
      { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
      { type: "tool_result", tool_use_id: "t5", content: [{ type: "text", text: "Patch p-9 applied. The app is reloading." }] },
    ] } }),
    JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
  ];
  const { steps } = parseAll(lines.join("\n") + "\n", 13);
  assert.deepEqual(steps.map((s) => s.text), [
    'Clicking "Add Todo"', "Reading server/todos.controller.ts", "Sending POST /api/todos", "Re-running the steps to check",
    "Proposing a fix", "Wrong field name.",
    'Clicked "Add Todo": something went wrong', "Problem: boom", "Fix applied", "Claude Code stopped (error_max_turns).",
  ]);
  const f = steps[5]!;
  assert.equal(f.kind, "findings");
  assert.deepEqual(f.findings, findings);
  assert.equal(f.summary, "Wrong field name.");
  assert.deepEqual(steps[6]!.actionIds, [id]);
  assert.equal(steps[6]!.tool, "app_click");
  assert.equal(steps[8]!.kind, "patch");
  assert.equal(steps[8]!.patchId, "p-9");
});

test("system prompt: every {{var}} filled, or a loud failure", async () => {
  const vars = { frontend: "vite-react", backend: "express", appUrl: "http://localhost:5173", routeCount: "3", autonomy: "fix", recentActions: "  - x", memory: "- userId must be a number", skills: "  - bad-value: A value is wrong", goal: "Fix Add Todo" };
  const filled = await buildSystemPrompt(promptsDir, vars);
  assert.doesNotMatch(filled, /\{\{/);
  assert.match(filled, /<memory>\n- userId must be a number\n<\/memory>/);
  assert.match(filled, /- bad-value: A value is wrong/);
  assert.match(filled, /call `plan`/);
  assert.match(filled, /Frontend: vite-react · Backend: express/);
  assert.match(filled, /Fix Add Todo/);
  const { goal: _, ...noGoal } = vars;
  await assert.rejects(buildSystemPrompt(promptsDir, noGoal), /unfilled variables: \{\{goal\}\}/);
  assert.equal(fillTemplate("a {{x}} b", { x: "$& {{y}}" }), "a $& {{y}} b");
});

test("claude args match the contract", () => {
  const args = claudeArgs("why?", { url: "http://127.0.0.1:1/mcp", token: "t" }, "SYS");
  assert.deepEqual(args, [
    "-p", "why?", "--output-format", "stream-json", "--verbose",
    "--mcp-config", '{"mcpServers":{"shrike":{"type":"http","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer t","x-shrike-internal":"1"}}}}',
    "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__shrike", "--append-system-prompt-file", "SYS",
  ]);
  assert.deepEqual(claudeArgs("fix it", { url: "u", token: "t" }, "S", "sess-1").slice(0, 4), ["--resume", "sess-1", "-p", "fix it"]);
  assert.deepEqual(claudeArgs("x", { url: "u", token: "t" }, "S", undefined, "xhigh").slice(-2), ["--effort", "xhigh"]);
});

test("Ask pill options: think harder maps to effort, plan first and context go in the goal", () => {
  assert.equal(effortFor("quick"), "low");
  assert.equal(effortFor("normal"), undefined);
  assert.equal(effortFor("deep"), "xhigh");
  assert.equal(goalWithOptions(" why? "), "why?");
  assert.equal(goalWithOptions("why?", { planFirst: true, skillId: "bad-value", context: ["Context:  a\n b", " "] }), `why?\nLoad the bad-value playbook with load_skill first and follow it.\n${PLAN_FIRST}\nContext: a b`);
});

test("usage and session id from a real stream: per message, then the result's totals", async () => {
  const { usage, sessions } = parseAll(await fixture("claude-stream.jsonl"), 13);
  assert.deepEqual(sessions, ["40828fcb-1ded-4fc7-ac24-04029ab31e1d"]);
  // 1st message: 2 + 4246 cache write; 2nd: 2 + 109 + 4246 cache read. Model "[1m]" means a 1M window.
  assert.deepEqual(usage[0], { inputTokens: 4248, outputTokens: 24, contextTokens: 4272, contextLimit: 1_000_000 });
  assert.equal(usage.find((u) => u.rateLimitResetsAt)?.rateLimitResetsAt, 1791396000_000);
  assert.deepEqual(usage.at(-1), { inputTokens: 8605, outputTokens: 109, contextTokens: 4407, contextLimit: 1_000_000, costUsd: 0.0378852, rateLimitResetsAt: 1791396000_000 });

  // A message split over two lines counts once (the later usage wins).
  const msg = (out: number) => JSON.stringify({ type: "assistant", message: { id: "m1", content: [], usage: { input_tokens: 10, output_tokens: out } } });
  const twice = parseAll([msg(1), msg(5)].join("\n") + "\n");
  assert.deepEqual(twice.usage.at(-1), { inputTokens: 10, outputTokens: 5, contextTokens: 15 });
});

test("plan, load_skill and remember become narration steps, not probe steps", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "a", name: "mcp__shrike__plan", input: { checks: ["check what the page sent", " check what the server saved "], stationLabels: ["createTodo()"] } },
    { type: "tool_use", id: "b", name: "mcp__shrike__load_skill", input: { skill: "Bad-Value" } },
    { type: "tool_use", id: "c", name: "mcp__shrike__remember", input: { text: "userId must be a number", file: "server/todos.controller.ts", line: 18 } },
    { type: "tool_use", id: "d", name: "mcp__shrike__propose_skill_update", input: { skillId: "bad-value", reason: "Check the port first", after: "1. x" } },
  ] } });
  const { steps } = parseAll(line + "\n");
  assert.deepEqual(steps.map((s) => [s.kind, s.tool, s.text]), [
    ["message", "plan", "My plan: check what the page sent, then check what the server saved"],
    ["message", "load_skill", "Using the bad value playbook"],
    ["message", "remember", "Noting for next time: userId must be a number"],
    ["message", "propose_skill_update", "Suggesting a better playbook: Check the port first"],
  ]);
  assert.deepEqual(steps[0]!.plan, ["check what the page sent", "check what the server saved"]);
  assert.match(steps[0]!.detail!, /stationLabels/);
  assert.equal(steps[1]!.skill, "bad-value");
});

const made: string[] = [];
after(() => Promise.all(made.map((d) => fs.rm(d, { recursive: true, force: true }))));

async function fakeBin(script: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shrike-agent-"));
  made.push(dir);
  const p = path.join(dir, "claude");
  await fs.writeFile(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return p;
}

function runFake(script: string) {
  return fakeBin(script).then(
    (bin) =>
      new Promise<{ steps: StepInput[]; failed: boolean; kill: () => void }>((resolve) => {
        const steps: StepInput[] = [];
        const r = runClaudeCode({ bin: { path: bin, version: "0" }, args: [], cwd: os.tmpdir(), emit: (s) => steps.push(s), onExit: (failed) => resolve({ steps, failed, kill: r.kill }) });
      }),
  );
}

test("spawned process: stream, stderr on failure, env and cwd", async () => {
  const fx = path.join(here, "fixtures/claude-stream.jsonl");
  const ok = await runFake(`[ "$MCP_TOOL_TIMEOUT" = 600000 ] || exit 9\ncat "${fx}"`);
  assert.equal(ok.failed, false);
  assert.equal(ok.steps.at(-1)!.kind, "done");

  const bad = await runFake('echo "Error: something broke" >&2; exit 3');
  assert.equal(bad.failed, true);
  assert.equal(bad.steps.length, 1);
  assert.match(bad.steps[0]!.text, /exited with code 3/);
  assert.match(bad.steps[0]!.detail!, /something broke/);

  const missing = await new Promise<StepInput[]>((resolve) => {
    const steps: StepInput[] = [];
    runClaudeCode({ bin: { path: "/nonexistent/claude", version: "0" }, args: [], cwd: os.tmpdir(), emit: (s) => steps.push(s), onExit: () => resolve(steps) });
  });
  assert.match(missing[0]!.text, /Couldn't start Claude Code/);
});

test("stop() kills the process", async () => {
  const stopDir = await fs.mkdtemp(path.join(os.tmpdir(), "shrike-stop-"));
  made.push(stopDir);
  const ready = path.join(stopDir, "ready");
  const bin = await fakeBin(`exec "${process.execPath}" -e 'process.on("SIGTERM", () => {}); require("fs").writeFileSync("${ready}", ""); setTimeout(() => {}, 30000)'`);
  let t0 = 0;
  await new Promise<void>((resolve) => {
    const r = runClaudeCode({ bin: { path: bin, version: "0" }, args: [], cwd: os.tmpdir(), emit: () => {}, onExit: () => resolve() });
    const poll = setInterval(() => fs.access(ready).then(() => (clearInterval(poll), (t0 = Date.now()), r.kill()), () => {}), 50);
  });
  const ms = Date.now() - t0;
  assert.ok(ms > 2900 && ms < 6000, String(ms)); // TERM ignored, SIGKILL after 3s
});

// ---- built-in brain against a real MCP server ----

const ACTION = "abcdefabcdefabcd";
const action: ActionView = {
  id: ACTION, traceId: "f".repeat(32), trigger: "click", label: 'Clicked "Add Todo"', startMs: 1, durationMs: 40, status: "error", complete: true,
  root: { id: ACTION, traceId: "f".repeat(32), origin: "browser", kind: "user_action", name: 'Clicked "Add Todo"', startMs: 1, status: "error" },
  tree: [{ event: { id: "1234123412341234", traceId: "f".repeat(32), origin: "server", kind: "http_request", name: "POST /api/todos", startMs: 2, durationMs: 9, status: "error", http: { method: "POST", url: "/api/todos", status: 500 } }, children: [] }],
  summary: { headline: "", steps: [], stats: { files: 0, functions: 0, requests: 1, queries: 0, logs: 0, errors: 1, totalMs: 40 } },
  flags: [],
};
const FIXED = "0123012301230123";
const fixed: ActionView = {
  ...action, id: FIXED, status: "ok", root: { ...action.root, id: FIXED, status: "ok" },
  tree: [{ event: { ...action.tree[0]!.event, id: "5678567856785678", status: "ok", http: { method: "POST", url: "/api/todos", status: 201 } }, children: [] }],
};
const reported: { findings: Finding[]; summary: string }[] = [];
const host = {
  projectRoot: () => os.tmpdir(),
  listActions: () => [action],
  getAction: (id: string) => (id === ACTION ? action : id === FIXED ? fixed : undefined),
  proposePatch: async () => ({ patchId: "p1", status: "applied" }),
  reportFindings: (findings: Finding[], summary: string) => void reported.push({ findings, summary }),
} as unknown as ShrikeHost;

const ctx = { frontend: "vite-react", backend: "express", appUrl: "http://localhost:5173", routeCount: 2, recentActions: `  - Action ${ACTION} Clicked "Add Todo" error` };

function run(anthropic: AnthropicLike, mcp: { url: string; token: string }) {
  const steps: AgentStep[] = [];
  const statuses: AgentRunInfo["status"][] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const handle = startAgentRun({
    goal: "Why does Add Todo fail?", brain: "builtin", cwd: os.tmpdir(), mcp, context: ctx, promptsDir, anthropic,
    onStep: (s) => steps.push(s),
    onStatus: (i) => (statuses.push(i.status), i.status !== "running" && resolveDone()),
  });
  return { steps, statuses, done, handle };
}

test("built-in brain runs the tool loop over MCP and stops when the model ends its turn", async () => {
  const server = await startMcpServer(host);
  try {
    const bodies: any[] = [];
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "text", text: "Reading what happened" }, { type: "tool_use", id: "u1", name: "get_action", input: { actionId: ACTION } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u2", name: "report_findings", input: { findings: [{ confidence: "observed", claim: "500 from POST /api/todos" }], summary: "The server failed." } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "The server couldn't save your todo." }] },
    ];
    const anthropic: AnthropicLike = { messages: { create: async (body) => (bodies.push(structuredClone(body)), replies.shift() as any) } };
    const r = run(anthropic, server);
    await r.done;

    assert.deepEqual(r.statuses, ["running", "done"]);
    assert.deepEqual(r.steps.map((s) => s.kind), ["message", "tool_call", "tool_result", "findings", "tool_result", "message", "done"]);
    assert.ok(r.steps.every((s) => s.runId === r.handle.info.id && s.id && s.createdAt));
    assert.deepEqual(r.steps[2]!.actionIds, [ACTION]);
    assert.equal(r.steps[3]!.summary, "The server failed.");
    assert.deepEqual(reported, [{ findings: [{ confidence: "observed", claim: "500 from POST /api/todos" }], summary: "The server failed." }]);

    const first = bodies[0];
    assert.equal(first.model, "claude-sonnet-5");
    assert.equal(first.tools.length, 24);
    assert.ok(first.tools.every((t: any) => t.input_schema?.type === "object" && t.description));
    assert.match(first.system[0].text, /Why does Add Todo fail\?/);
    assert.doesNotMatch(first.system[0].text, /\{\{/);
    const toolResult = bodies[1].messages.at(-1).content[0];
    assert.equal(toolResult.tool_use_id, "u1");
    assert.match(toolResult.content, /POST \/api\/todos/);
    assert.equal(toolResult.is_error, false);
  } finally {
    await server.close();
  }
});

test("done step says Fixed and verified only after a clean re-run of the applied fix", async () => {
  const server = await startMcpServer(host);
  try {
    const patch = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u1", name: "propose_patch", input: { files: [{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }], rationale: "r" } }] };
    const compare = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u2", name: "compare_actions", input: { beforeId: ACTION, afterId: FIXED } }] };
    const end = { stop_reason: "end_turn", content: [{ type: "text", text: "Fixed." }] };
    const replies = [patch, compare, end];
    const r = run({ messages: { create: async () => replies.shift() as any } }, server);
    await r.done;
    const done = r.steps.at(-1)!;
    assert.equal(r.steps.find((s) => s.kind === "patch")?.patchId, "p1");
    assert.equal(done.kind, "done");
    assert.equal(done.summary, "Fixed and verified");
    assert.equal(done.patchId, "p1");

    const unverified = [patch, end];
    const r2 = run({ messages: { create: async () => unverified.shift() as any } }, server);
    await r2.done;
    assert.equal(r2.steps.at(-1)!.summary, "Fix applied, not verified yet");
  } finally {
    await server.close();
  }
});

test("built-in brain: tool errors go back to the model, stop() ends the run", async () => {
  const server = await startMcpServer(host);
  try {
    let calls = 0;
    const anthropic: AnthropicLike = {
      messages: {
        create: (_body, opts) => {
          calls++;
          if (calls === 1) return Promise.resolve({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "u1", name: "get_action", input: { actionId: "nope" } }] } as any);
          return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        },
      },
    };
    const r = run(anthropic, server);
    while (calls < 2) await new Promise((res) => setTimeout(res, 10));
    assert.equal(r.steps.at(-1)!.text, 'Problem: No Action with id "nope". Use list_actions to see recent ones.');
    r.handle.stop();
    await r.done;
    assert.deepEqual(r.statuses, ["running", "stopped"]);
    const n = r.steps.length;
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.steps.length, n); // nothing after stop
  } finally {
    await server.close();
  }
});

test("built-in brain without a key fails clearly", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const steps: AgentStep[] = [];
    const status = await new Promise<string>((resolve) => {
      startAgentRun({
        goal: "x", brain: "builtin", cwd: os.tmpdir(), mcp: { url: "http://127.0.0.1:1/mcp", token: "t" }, context: ctx, promptsDir,
        onStep: (s) => steps.push(s), onStatus: (i) => i.status !== "running" && resolve(i.status),
      });
    });
    assert.equal(status, "failed");
    assert.match(steps[0]!.text, /Set ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("a run stamps the loaded skill on later steps and reports usage with its run id", async () => {
  const server = await startMcpServer(host);
  try {
    const usage: AgentUsage[] = [];
    const replies = [
      { stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: "u1", name: "load_skill", input: { skill: "bad-value" } }] },
      { stop_reason: "end_turn", usage: { input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 5 }, content: [{ type: "text", text: "Done." }] },
    ];
    const steps: AgentStep[] = [];
    let id = "";
    await new Promise<void>((resolve) => {
      id = startAgentRun({
        goal: "x", brain: "builtin", cwd: os.tmpdir(), mcp: server, context: ctx, promptsDir,
        anthropic: { messages: { create: async () => replies.shift() as any } },
        onStep: (s) => steps.push(s), onUsage: (u) => usage.push(u),
        onStatus: (i) => i.status !== "running" && resolve(),
      }).info.id;
    });
    assert.equal(steps[0]!.skill, "bad-value");
    assert.ok(steps.slice(1).every((s) => s.skill === "bad-value"), JSON.stringify(steps.map((s) => s.skill)));
    assert.deepEqual(usage.at(-1), { runId: id, inputTokens: 250, outputTokens: 15, contextTokens: 155, contextLimit: 200_000 });
  } finally {
    await server.close();
  }
});
