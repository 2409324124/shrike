// QB for e2e (fake-claude.mjs hands goals that load plan-feature here): plays what Claude does for "Plan this: …", for real over
// Shrike's MCP tools. Loads plan-feature, asks the scope with ask_options, proposes the quest (waits for Start this quest),
// links a recorded flow to each objective, then drafts what it learned into plan-feature.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const goal = opt("-p") ?? "";
const { url, headers } = JSON.parse(opt("--mcp-config")).mcpServers.shrike;
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 120);
const session = `fake-quest-${Date.now()}`;
if (process.env.FAKE_CLAUDE_DIR) appendFileSync(join(process.env.FAKE_CLAUDE_DIR, "calls.jsonl"), `${JSON.stringify({ kind: "quest", session, goal: goal.slice(0, 400) })}\n`);

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
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: session })}\n`);
const pause = () => new Promise((r) => setTimeout(r, delay));
let n = 0;
async function call(name, input) {
  const id = `toolu_${++n}`;
  out({ type: "assistant", message: { id: `msg_${n}`, content: [{ type: "tool_use", id, name: `mcp__shrike__${name}`, input }] } });
  const r = await rpc("tools/call", { name, arguments: input });
  const text = r.content.map((c) => c.text).join("\n");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: !!r.isError }] } });
  await pause();
  return { text, error: !!r.isError };
}
const say = async (text) => (out({ type: "assistant", message: { id: `msg_s${++n}`, content: [{ type: "text", text }] } }), pause());
const end = () => (out({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0 }), process.exit(0));

out({ type: "system", subtype: "init", mcp_servers: [{ name: "shrike", status: "connected" }], model: "claude-opus-5-5[1m]" });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.280" } });
await rpc("notifications/initialized", {}, true);

const questId = /Shrike quest ([0-9a-f]{8})/.exec(goal)?.[1];
await call("load_skill", { skill: "plan-feature" });
await call("list_quests", {});
await call("read_file", { path: "src/TodoList.tsx" });
await say("Before I plan it, how much should editing a todo cover?");

let input = {
  question: "How much should editing a todo cover?",
  header: "Scope",
  options: [
    { id: "basic", label: "Just the basics", description: "Click a title to edit it", preview: "In: click a title, type, Enter saves\nOut: undo, history" },
    { id: "extras", label: "With the extras", description: "Editing plus Esc to cancel", preview: "In: click to edit, Enter saves, Esc cancels\nOut: history" },
    { id: "all", label: "The whole thing", description: "Editing, cancel and an edit history", preview: "In: everything above, plus who changed what" },
  ],
};
let approved;
for (let round = 0; round < 12 && !approved; round++) {
  const r = await call("ask_options", input);
  if (r.error) break;
  const a = JSON.parse(r.text.split("\n")[0]);
  if (a.action === "approve") approved = a;
  else input = { thread: a.thread };
}
if (!approved) end();

const objectives = [
  { text: "Your todos still load and tick off", doneWhen: "Ticking a todo keeps it ticked" },
  { text: "Open the dashboard after an edit", doneWhen: "The dashboard shows your open todos" },
];
let started = false;
for (let i = 0; i < 3 && !started; i++) {
  const r = await call("propose_quest", { ...(questId ? { questId } : {}), title: "Edit a todo", objectives });
  started = /started the quest/.test(r.text);
  if (!started) await say("Got it. Here's a smaller plan.");
}
if (!started) end();

await call("link_flow", { questId, objectiveId: "o1", name: "Tick a todo", steps: [{ type: "click", name: "Book the team offsite" }] });
await call("link_flow", { questId, objectiveId: "o2", name: "Open the dashboard", steps: [{ type: "click", name: "Load dashboard" }] });
await call("propose_skill_update", {
  skillId: "plan-feature",
  reason: "Start a todo-app quest with a flow that ticks a todo, so nothing old breaks",
  after: "# Plan a feature\n\nA quest is the user's idea split into a few objectives they can see working.\n\n1. Call list_quests.\n2. Ask the scope with ask_options.\n3. Propose the quest.\n4. Link a flow to each objective.\n\n## In this app\n\n- The first objective keeps an old journey green: ticking a todo.\n",
});
await say("Planned: Edit a todo, 2 objectives. Start with the first one: it already has its flow.");
end();
