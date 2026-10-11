// The start agent's recorded stream for e2e (fake-claude.mjs hands start goals here): plays what Claude does on a fixture,
// for real over Shrike's start tools. Reads the fixture's declared setup (.shrike/config.json, ports already moved by
// fixtureCopy) the way Claude reads a recipe. A second Run follows the Shrike run skill and ends with mark_skill_used.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const goal = opt("-p") ?? "";
const { url, headers } = JSON.parse(opt("--mcp-config")).mcpServers.shrike;
const delay = Number(process.env.FAKE_CLAUDE_DELAY ?? 120);
const session = "fake-start-session";

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
const end = (result) => (out({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0 }), process.exit(0));

out({ type: "system", subtype: "init", mcp_servers: [{ name: "shrike", status: "connected" }], model: "claude-opus-5-5[1m]" });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.280" } });
await rpc("notifications/initialized", {}, true);

const skillId = /save_run_skill \(([\w.-]+)\)/.exec(goal)?.[1] ?? "run-app";
if (opt("--resume")) {
  // a nudge: end with a skill
  if (/didn't come up/.test(goal)) await call("propose_lesson", { lesson: "Read the project's declared setup before guessing commands." });
  else await call("save_run_skill", { body: "## Run\n\nSee .shrike/config.json." });
  end("Done");
}

const cfgPath = join(process.cwd(), ".shrike", "config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
// FAKE_START_HINTS=1 and no config: run what Shrike's scanner guessed (the system prompt's "- name: `command` in dir at url" lines).
const system = opt("--append-system-prompt-file") ? readFileSync(opt("--append-system-prompt-file"), "utf8") : "";
const hinted = process.env.FAKE_START_HINTS === "1" && !cfg.processes?.length && !cfg.devCommand
  ? [...system.matchAll(/^- ([\w-]+): `([^`]+)`(?: in (\S+))?(?: at (\S+))?$/gm)].map(([, name, command, cwd, url]) => ({ name, command, ...(cwd ? { cwd } : {}), ...(url ? { url } : {}) }))
  : [];
const all = cfg.processes?.length ? cfg.processes : hinted.length ? hinted : [{ name: "app", command: cfg.devCommand ?? "npm run dev", url: cfg.appUrl }];
// A process with no URL next to ones that have one is a job (a nightly script): it runs once the app is up.
const procs = all.some((p) => p.url) ? all.filter((p) => p.url) : all;
const jobs = all.filter((p) => !procs.includes(p));
const page = cfg.appUrl ?? (hinted.length ? /^- page probably at (\S+)$/m.exec(system)?.[1] : cfg.processes?.length ? undefined : procs[0].url);
const following = /follow the Shrike run skill/.test(goal);

await say(following ? `Following the run skill ${skillId}.` : "Reading how this project starts: .shrike/config.json declares the services.");
if (following) await call("read_recipe", { id: `shrike:${skillId}` });
const sid_ = (p) => p.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
await call("plan_steps", {
  source: following ? "shrike-skill" : "explored",
  ...(following ? { skillId } : {}),
  services: procs.map((p) => ({ name: p.name, ...(p.url ? { url: p.url, health: p.url } : {}) })),
  steps: [
    { id: "node", title: "Check Node is there", kind: "check", command: "node -v" },
    ...procs.map((p) => ({ id: sid_(p), title: `Start ${p.name}`, kind: "service", command: p.command, ...(p.cwd ? { cwd: p.cwd } : {}), service: p.name })),
  ],
});
await call("run_command", { step: "node", title: "Check Node is there", command: "node -v" });
for (const p of procs) {
  const r = await call("start_service", { step: sid_(p), name: p.name, command: p.command, ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.url ? { url: p.url } : {}), waitSec: 2 });
  if (r.error) {
    await say(`Couldn't start ${p.name}: ${r.text}`);
    end("Failed");
  }
}
for (const p of procs) {
  if (!p.url) {
    await call("update_step", { id: sid_(p), state: "done" });
    continue;
  }
  const h = await call("check_health", { step: sid_(p), target: p.url, service: p.name, timeoutSec: 90 });
  if (h.error) {
    await say(`${p.name} didn't answer: ${h.text}`);
    end("Failed");
  }
}
const ready = await call("app_ready", page ? { url: page } : {});
if (ready.error) {
  await say(`Not ready: ${ready.text}`);
  end("Failed");
}
for (const p of jobs) await call("start_service", { title: `Run the ${p.name} job`, name: p.name, command: p.command, ...(p.cwd ? { cwd: p.cwd } : {}), waitSec: 1 });
if (following) await call("mark_skill_used", { skillId });
else
  await call("save_run_skill", {
    body: `## Run\n\n${procs.map((p, i) => `${i + 1}. Start ${p.name}: \`${p.command}\`${p.cwd ? ` in ${p.cwd}` : ""}${p.url ? ` (${p.url})` : ""}`).join("\n")}\n\n## Health checks\n\n${procs.filter((p) => p.url).map((p) => `- ${p.url} answers`).join("\n") || "- the processes stay up"}\n\n## Stop\n\nStop it from Shrike.`,
    when: "Start this project's services",
  });
await say("It's up.");
end("Done");
