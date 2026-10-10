// M1–M5 for e2e (fake-claude.mjs hands goals that say "answer with ask_options" here): plays what Claude does for "Show me options",
// for real over Shrike's MCP tools. Loads the skills, shows three header mockups, loops on every answer (more like this, change,
// combine) until approve, builds the approved one with propose_patch, then drafts what it learned into design-taste.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const { url, headers } = JSON.parse(opt("--mcp-config")).mcpServers.shrike;
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 120);
const session = `fake-options-${Date.now()}`;
if (process.env.FAKE_CLAUDE_DIR) appendFileSync(join(process.env.FAKE_CLAUDE_DIR, "calls.jsonl"), `${JSON.stringify({ kind: "options", session, goal: (opt("-p") ?? "").slice(0, 400) })}\n`);

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

// The todo app's own look (fixtures/todo-app/src/styles.css): its accent, card and border.
const header = ({ title = "Todos", sub = "Everything your team needs to get done.", accent = "#3e63dd", bg = "#ffffff", align = "left", size = 24, band = false }) =>
  `<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#1c2024}.app{max-width:560px;margin:24px auto;padding:24px;background:${bg};border:1px solid #e0e1e6;border-radius:12px}` +
  `.h{text-align:${align};${band ? `background:${accent};color:#fff;margin:-24px -24px 16px;padding:20px 24px;border-radius:12px 12px 0 0` : ""}}.h h1{margin:0;font-size:${size}px}.h p{margin:4px 0 0;opacity:.75}` +
  `.row{display:flex;gap:8px;margin-top:16px}.row input{flex:1;padding:8px 12px;border:1px solid #e0e1e6;border-radius:8px}.row button{padding:8px 14px;border:0;border-radius:8px;background:${accent};color:#fff;font-weight:600}` +
  `li{padding:10px 0;border-bottom:1px solid #e0e1e6;list-style:none}ul{padding:0;margin:12px 0 0}</style>` +
  `<div class="app"><div class="h"><h1>${title}</h1><p>${sub}</p></div><div class="row"><input placeholder="What needs doing?"><button>Add Todo</button></div><ul><li>Fix the signup page on mobile</li><li>Write the release notes</li></ul></div>`;

out({ type: "system", subtype: "init", mcp_servers: [{ name: "shrike", status: "connected" }], model: "claude-opus-5-5[1m]" });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.280" } });
await rpc("notifications/initialized", {}, true);

await call("load_skill", { skill: "design-taste" });
await call("load_skill", { skill: "mockup-options" });
await call("read_file", { path: "src/App.tsx", startLine: 36, endLine: 41 });
await say("Here are three ways the header could look, in your app's own colours.");

let input = {
  question: "How should the todo header look?",
  header: "Header",
  options: [
    { id: "plain", label: "Quiet", description: "Same layout, a smaller title and softer subtitle", mockupHtml: header({ size: 20 }) },
    { id: "band", label: "Colour band", description: "The title sits on a band of your accent colour", mockupHtml: header({ band: true }) },
    { id: "center", label: "Centred", description: "A bigger centred title, like a landing page", mockupHtml: header({ align: "center", size: 30 }) },
  ],
};
let approved;
for (let round = 0; round < 12 && !approved; round++) {
  const r = await call("ask_options", input);
  if (r.error) break;
  const a = JSON.parse(r.text.split("\n")[0]);
  const s = a.thread;
  if (a.action === "waiting") input = { thread: s };
  else if (a.action === "vary")
    input = {
      thread: s,
      options: [
        { label: "Band, deep blue", description: "A darker band", mockupHtml: header({ band: true, accent: "#2a4ab5" }) },
        { label: "Band, tall title", description: "A bigger title on the band", mockupHtml: header({ band: true, size: 30 }) },
        { label: "Band, green", description: "The band in green", mockupHtml: header({ band: true, accent: "#2f9e6e" }) },
      ],
    };
  else if (a.action === "combine") input = { thread: s, options: [{ label: "Tall band, centred", description: a.text || "The band with the centred title", mockupHtml: header({ band: true, size: 30, align: "center", title: "Today" }) }] };
  else if (a.action === "tweak") input = { thread: s, options: [{ label: "Changed", description: a.text, mockupHtml: header({ band: true, accent: "#1c2024" }) }] };
  else if (a.action === "approve") approved = a;
  else break;
}

if (approved) {
  await say("Building the one you approved.");
  await call("propose_patch", {
    files: [{ path: "src/App.tsx", edits: [{ oldText: "<h1>Todos</h1>", newText: "<h1>Today</h1>" }] }],
    rationale: "Builds the header you approved: the title reads Today, centred on the band.",
  });
  await call("propose_skill_update", {
    skillId: "design-taste",
    reason: "Likes a bold colour band with a big centred title",
    after: "# Design taste\n\nWhat this user picked when Shrike showed them options for this app.\n\n## They like\n\n- A bold band of the accent colour behind the title, with a big centred title\n\n## They pass on\n\n- Quiet, small headers\n",
  });
  await say("Done. The header now matches the mockup you approved.");
}
out({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0 });
process.exit(0);
