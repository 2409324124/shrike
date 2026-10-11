// A stand-in for the `claude` CLI in e2e (SHRIKE_CLAUDE_BIN): replays recorded stream-json shapes and keeps "session files"
// like Claude Code does, so a test can check that a fork never touches its parent. FAKE_CLAUDE_DIR holds sessions/ and calls.jsonl.
// Main run: a fresh session. --resume X --fork-session: a branch (or an aside) in a new session. --resume X alone: appends to X.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.280 (Claude Code)");
  process.exit(0);
}
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const goal = opt("-p") ?? "";
// The start agent (every Run): its own recorded stream, kept out of calls.jsonl.
if (/^Get .+ running in Shrike/.test(goal) || /ended with a skill|still ends with a skill/.test(goal)) {
  await import("./fake-start.mjs");
  await new Promise(() => {}); // fake-start exits
}
// "Show me options" (M6): the options stream, for real over Shrike's tools (ask_options, propose_patch, propose_skill_update).
if (/answer with ask_options/.test(goal)) {
  await import("./fake-options.mjs");
  await new Promise(() => {}); // fake-options exits
}
// "Plan this: …" (QB): the plan-feature stream, for real over Shrike's tools (ask_options, propose_quest, link_flow).
if (/Load the plan-feature playbook/.test(goal) && !opt("--resume")) {
  await import("./fake-quest.mjs");
  await new Promise(() => {}); // fake-quest exits
}
const resume = opt("--resume");
const fork = args.includes("--fork-session");
const dir = process.env.FAKE_CLAUDE_DIR;
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 250);
// Chains (P3): the critic's one-shot call scores from FAKE_CRITIQUE_SCORES in turn ("5,9"); a goal matching FAKE_CLAUDE_FAIL ends in an error result.
const critic = /^Score this run from 0 to 10/.test(goal);
const fails = !!process.env.FAKE_CLAUDE_FAIL && new RegExp(process.env.FAKE_CLAUDE_FAIL).test(goal);
const kind = critic ? "critique" : !resume ? "main" : !fork ? "resume" : /This is a side question/.test(goal) ? "aside" : "branch";
const session = resume && !fork ? resume : randomUUID();
const priorCritiques = critic && existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter((l) => l.includes('"kind":"critique"')).length : 0;
const sessions = join(dir, "sessions");
mkdirSync(sessions, { recursive: true });
const file = join(sessions, `${session}.jsonl`);
if (fork && existsSync(join(sessions, `${resume}.jsonl`))) copyFileSync(join(sessions, `${resume}.jsonl`), file);
// MCP6: the user's own servers come as extra --mcp-config files after Shrike's JSON; record their names, the allowed tools and the prompt's one line.
const mine = [];
for (let i = args.indexOf("--mcp-config") + 2; i > 1 && i < args.length && !args[i].startsWith("-"); i++) mine.push(...Object.keys(JSON.parse(readFileSync(args[i], "utf8")).mcpServers ?? {}));
const promptFile = opt("--append-system-prompt-file");
const toolsLine = promptFile && existsSync(promptFile) ? (/^Your own tools this run.*$/m.exec(readFileSync(promptFile, "utf8"))?.[0] ?? null) : null;
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ kind, session, resume, fork, goal: goal.slice(0, 400), disallowed: opt("--disallowedTools"), cwd: process.cwd(), mine, allowed: opt("--allowedTools"), toolsLine })}\n`);
appendFileSync(file, `${JSON.stringify({ type: "user", text: goal.slice(0, 400) })}\n`);
// FAKE_CLAUDE_AUTH_FAIL_ONCE: the first main run fails sign-in like Claude Code 2.1 (it retries the 401 for minutes), until stopped.
if (kind === "main" && process.env.FAKE_CLAUDE_AUTH_FAIL_ONCE && !existsSync(join(dir, "auth-failed"))) {
  writeFileSync(join(dir, "auth-failed"), String(process.pid));
  const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: session })}\n`);
  out({ type: "system", subtype: "init", cwd: process.cwd(), tools: [], mcp_servers: [{ name: "shrike", status: "connected" }], model: "claude-opus-5-5[1m]" });
  for (const attempt of [1, 2]) {
    await new Promise((r) => setTimeout(r, 400));
    out({ type: "system", subtype: "api_retry", attempt, max_retries: 10, retry_delay_ms: 600, error_status: 401, error: "authentication_failed" });
  }
  await new Promise(() => {});
}

const MODEL = "claude-opus-5-5[1m]";
let msg = 0;
let prompt = 6000; // each turn adds what the previous tool returned, like a real context window
const usage = (add, out) => ({ input_tokens: 3, cache_creation_input_tokens: add, cache_read_input_tokens: prompt - 3, output_tokens: out });
const lines = [{ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [{ name: "shrike", status: "connected" }], model: MODEL }];
let outTotal = 0;
const turn = (content, add, out) => {
  const id = `msg_${kind}_${++msg}`;
  lines.push({ type: "assistant", message: { id, type: "message", role: "assistant", model: MODEL, content, usage: usage(add, out) }, session_id: session });
  prompt += add;
  outTotal += out;
};
let tid = 0;
const tool = (name, input, result, add, out, thinking) => {
  const id = `toolu_${++tid}`;
  turn([...(thinking ? [{ type: "thinking", thinking, signature: "s" }] : []), { type: "tool_use", id, name: name.startsWith("mcp__") ? name : `mcp__shrike__${name}`, input }], add, out);
  lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: result }] }] }, session_id: session });
};
const say = (text, add, out, thinking) => turn([...(thinking ? [{ type: "thinking", thinking, signature: "s" }] : []), { type: "text", text }], add, out);

const CONTROLLER = `server/todos.controller.ts lines 14-20
14| export async function createTodo(req: Request, res: Response) {
15|   const { title } = req.body;
16|   console.log("creating todo", { title });
17|   if (!title) return res.status(400).json({ error: "Title is required" });
18|   const todo = insertTodo({ title, userId: req.body.user });
19|   res.status(201).json(withOwner(todo));
20| }`;

if (kind === "critique") {
  const scores = (process.env.FAKE_CRITIQUE_SCORES ?? "7").split(",");
  const score = scores[Math.min(priorCritiques, scores.length - 1)];
  say(`It does the ask, but the empty state is missing.\nSCORE: ${score}/10\nWHY: there is no empty state when the list has nothing in it`, 900, 40);
} else if (/^(Cluster these pull request review comments|Check this change against the review lessons)/.test(goal)) { // RL2/RL6: the lessons brain (fake-lessons.mjs)
  say((await import("./fake-lessons.mjs")).answer(goal), 900, 60);
} else if (/^# Write a commit message/m.test(goal)) { // SC3: the Commit message recipe through a quiet run
  say("Fix: Add Todo saves the owner again\n\nThe server read req.body.user, but the form sends userId.", 900, 30);
} else if (fails) {
  say("I tried, but the build broke and I couldn't recover.", 600, 30);
} else if (kind === "main") {
  say("The click got a 500, so a value is going missing on the way in. I'll use the bad-value playbook.", 0, 60, "Add Todo returns 500. The insert fails on a NOT NULL column, so a field arrives empty.");
  if (mine.length) tool(`mcp__${mine[0]}__echo`, { text: "look at the page" }, '{"text":"look at the page"}', 300, 20); // MCP8: one call to the user's own server
  tool("load_skill", { skill: "bad-value" }, "Playbook: Bad value\nUse when: a field arrives empty or wrong\n\n1. Find where the value is read.\n2. Compare the names.", 0, 40);
  tool("read_file", { path: "server/todos.controller.ts", startLine: 14, endLine: 20 }, CONTROLLER, 1200, 35, "The page sends userId. Let me see what the controller reads.");
  tool("search_code", { query: "userId" }, "src/api.ts:12:     body: JSON.stringify({ title, userId }),\nserver/todos.controller.ts:18:   const todo = insertTodo({ title, userId: req.body.user });\nserver/db.ts:9:   return run(sql, [userId, title]);", 900, 30);
  tool("report_findings", { summary: "The controller reads req.body.user, but the page sends userId, so the todo is saved with no owner.", findings: [{ confidence: "observed", claim: "createTodo reads req.body.user; the page sends userId, so insertTodo gets userId undefined.", file: "server/todos.controller.ts", line: 18 }] }, "Findings recorded.", 700, 120, "The names differ: user vs userId. That's the bug.");
  say("Found it: line 18 reads req.body.user instead of req.body.userId.", 600, 50);
} else if (kind === "branch") {
  say("Setting the server aside. Checking what the page itself sends.", 2500, 45, "What if the frontend is wrong instead? Look at what api.ts puts in the body.");
  tool("read_file", { path: "src/api.ts", startLine: 8, endLine: 16 }, "src/api.ts lines 8-16\n8| export async function addTodo(title: string, userId: number) {\n12|     body: JSON.stringify({ title, userId }),\n16| }", 0, 30);
  tool("report_findings", { summary: "The page sends userId correctly; the frontend isn't the problem, the server reads the wrong name.", findings: [{ confidence: "observed", claim: "src/api.ts sends { title, userId }, which matches the API; the mismatch is on the server.", file: "src/api.ts", line: 12 }] }, "Findings recorded.", 800, 90);
  say("The frontend is fine: it sends userId.", 500, 30);
} else if (kind === "aside") {
  say("No. The cache only wraps GET /api/todos; POST never goes through it.", 2400, 40);
} else {
  say("Noted. That agrees with what I found: the server reads the wrong field.", 2600, 35);
}
const said = outTotal;
if (fails) lines.push({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: msg, result: "The build broke.", session_id: session });
else lines.push({ type: "result", subtype: "success", is_error: false, num_turns: msg, result: lines.findLast((l) => l.type === "assistant")?.message.content.find((c) => c.type === "text")?.text ?? "Done", session_id: session, total_cost_usd: 0.0123 * msg, usage: { input_tokens: 3 * msg, cache_creation_input_tokens: 4000, cache_read_input_tokens: 20000, output_tokens: said + 25 }, modelUsage: { [MODEL]: { contextWindow: 1_000_000 } } }); // the real CLI's result line counts a little more output than its message lines

for (const l of lines) {
  process.stdout.write(`${JSON.stringify(l)}\n`);
  if (l.type !== "system") appendFileSync(file, `${JSON.stringify(l)}\n`);
  await new Promise((r) => setTimeout(r, l.type === "user" ? delay * 3 : delay));
}
writeFileSync(join(dir, `done-${session}`), "");
