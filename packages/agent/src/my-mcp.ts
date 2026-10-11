import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTool } from "@shrike/schema";

// B4 / MCP: the user's own MCP servers. Claude Code's config is only ever read, never written.
// Precedence like Claude Code: local (~/.claude.json projects[root]) over project (.mcp.json) over user (~/.claude.json).

export type Server = Record<string, unknown>;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

async function json(file: string): Promise<Record<string, any> | undefined> {
  try {
    const v = JSON.parse(await readFile(file, "utf8"));
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function servers(v: unknown): Record<string, Server> {
  const out: Record<string, Server> = {};
  if (!v || typeof v !== "object") return out;
  for (const [name, s] of Object.entries(v as Record<string, unknown>)) {
    if (!NAME.test(name) || name === "shrike" || !s || typeof s !== "object") continue;
    const c = s as Server;
    if (typeof c.command === "string" || typeof c.url === "string") out[name] = c;
  }
  return out;
}

export interface ClaudeMcp {
  user: Record<string, Server>;
  project: Record<string, Server>; // .mcp.json: Claude Code asks before it starts these
  local: Record<string, Server>;
  approved: { all: boolean; names: string[]; denied: string[] }; // Claude Code's own answer about .mcp.json servers
}

export async function readClaudeMcp(projectRoot: string, home = os.homedir()): Promise<ClaudeMcp> {
  const user = await json(path.join(home, ".claude.json"));
  const project = await json(path.join(projectRoot, ".mcp.json"));
  const p = user?.projects?.[projectRoot];
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    user: servers(user?.mcpServers),
    project: servers(project?.mcpServers),
    local: servers(p?.mcpServers),
    approved: { all: p?.enableAllProjectMcpServers === true, names: list(p?.enabledMcpjsonServers), denied: list(p?.disabledMcpjsonServers) },
  };
}

export async function readMyMcpServers(projectRoot: string, home = os.homedir()): Promise<Record<string, Server>> {
  const c = await readClaudeMcp(projectRoot, home);
  return { ...c.user, ...c.project, ...c.local };
}

/**
 * Adds the servers to Claude Code's args next to Shrike's, and allows their tools.
 * Their config goes in a 0600 temp file, not the command line, so env tokens don't show in `ps`. remove() deletes it.
 */
export async function withMyMcp(args: string[], mine: Record<string, Server>): Promise<{ args: string[]; remove(): Promise<void> }> {
  const names = Object.keys(mine);
  const at = args.indexOf("--mcp-config");
  const allow = args.indexOf("--allowedTools");
  if (!names.length || at < 0 || allow < 0) return { args, remove: async () => {} };
  const dir = await mkdtemp(path.join(os.tmpdir(), "shrike-mcp-"));
  const file = path.join(dir, "my-mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: mine }), { mode: 0o600 });
  const out = [...args];
  out[allow + 1] = [out[allow + 1], ...names.map((n) => `mcp__${n}`)].join(" ");
  out.splice(at + 2, 0, file);
  return { args: out, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** MCP6: one short line for Claude's system prompt. */
export const mcpPromptLine = (names: string[]): string => (names.length ? `Your own tools this run (MCP servers the user turned on): ${names.join(", ")}. Use them when they help.` : "");

// ---- MCP1: the health check. Connect, list the tools, close; a timeout; nothing left running. ----

export interface McpCheck {
  ok: boolean;
  tools: McpTool[];
  error?: string; // plain words
  ms: number;
}

const exec = promisify(execFile);

/** Every process under pid (children, grandchildren), read before the parent goes so reparented ones aren't lost. */
async function descendants(pid: number): Promise<number[]> {
  if (process.platform === "win32") return []; // no ps: taskkill /T takes the tree below
  try {
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid="], { timeout: 3000 });
    const kids = new Map<number, number[]>();
    for (const l of stdout.split("\n")) {
      const [a, b] = l.trim().split(/\s+/).map(Number);
      if (a && b) kids.set(b, [...(kids.get(b) ?? []), a]);
    }
    const out: number[] = [];
    const walk = (p: number) => kids.get(p)?.forEach((c) => (out.push(c), walk(c)));
    walk(pid);
    return out;
  } catch {
    return [];
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function plain(err: unknown, s: Server, stderr: string, timedOut: boolean, timeoutMs: number): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const last = stderr.trim().split("\n").filter(Boolean).at(-1)?.trim().slice(0, 200);
  if (timedOut) return `It didn't answer within ${Math.round(timeoutMs / 1000)} seconds. A first start can be slow while it downloads: try again in a minute.${last ? ` It said: ${last}` : ""}`;
  if (/ENOENT/.test(msg) && typeof s.command === "string") return `Couldn't find "${s.command}" on this computer.${s.command === "npx" || s.command === "node" ? " Install Node.js." : s.command === "uvx" ? " Install uv (astral.sh/uv)." : " Check the command."}`;
  if (/\b(401|403)\b|unauthori[sz]ed|invalid_token|forbidden/i.test(msg)) return "It needs you to sign in or a valid token. For servers that sign in, run claude in a terminal, type /mcp and sign in there.";
  if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) return `Nothing answered at ${typeof s.url === "string" ? s.url : "its address"}. Is the app that serves it running?`;
  if (/Connection closed|EPIPE/i.test(msg)) return `It stopped as soon as it started.${last ? ` It said: ${last}` : ""}`;
  return (last ? `${msg.slice(0, 160)}. It said: ${last}` : msg.slice(0, 240)) || "It failed to start.";
}

/** Starts the server (stdio) or connects (http, sse), lists its tools and closes it. Never leaves a process behind. */
export async function checkMcpServer(s: Server, o: { timeoutMs?: number; cwd?: string; path?: string } = {}): Promise<McpCheck> {
  const timeoutMs = o.timeoutMs ?? 20_000;
  const t0 = Date.now();
  const client = new Client({ name: "shrike-check", version: "0.1.0" });
  let stderr = "";
  let pid: number | null = null;
  let stdio: StdioClientTransport | undefined;
  const headers = s.headers && typeof s.headers === "object" ? (s.headers as Record<string, string>) : undefined;
  let transport;
  if (typeof s.url === "string") {
    const url = new URL(s.url);
    transport = s.type === "sse" ? new SSEClientTransport(url, { requestInit: { headers } }) : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  } else {
    const env = { ...getDefaultEnvironment(), ...(o.path ? { PATH: o.path } : {}), ...((s.env as Record<string, string> | undefined) ?? {}) };
    stdio = new StdioClientTransport({ command: String(s.command), args: Array.isArray(s.args) ? s.args.map(String) : [], env, cwd: typeof s.cwd === "string" ? s.cwd : o.cwd, stderr: "pipe" });
    stdio.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
    transport = stdio;
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, fail) => (timer = setTimeout(() => ((timedOut = true), fail(new Error("timeout"))), timeoutMs)));
  try {
    const work = (async () => {
      await client.connect(transport);
      pid = stdio?.pid ?? null;
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description.split("\n")[0]!.slice(0, 200) } : {}) })));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return tools;
    })();
    work.catch(() => {});
    const tools = await Promise.race([work, deadline]);
    return { ok: true, tools, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, tools: [], error: plain(err, s, stderr, timedOut, timeoutMs), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    pid ??= stdio?.pid ?? null;
    const kids = pid ? await descendants(pid) : [];
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    if (pid && process.platform === "win32") await exec("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    for (const k of [...kids, ...(pid ? [pid] : [])]) if (alive(k)) try { process.kill(k, "SIGKILL"); } catch {}
  }
}
