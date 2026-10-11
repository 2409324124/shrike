import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentUsage } from "@shrike/schema";
import { forkFlags } from "./branches.ts";
import { addUsage, thinkingText, toolResultStep, toolUseStep, turnUsage, usageDelta, type StepInput, type TurnUsage } from "./steps.ts";

export type UsageInput = Omit<AgentUsage, "runId">;
export interface StreamHooks {
  onUsage?(u: UsageInput): void; // A7
  onSession?(id: string): void; // A13: for --resume
}

const exec = promisify(execFile);

export interface ClaudeBinary {
  path: string;
  version: string;
  loginPath?: string; // $PATH from the login shell; GUI apps on macOS start with a minimal one
}

export async function resolveClaude(): Promise<ClaudeBinary | undefined> {
  const home = os.homedir();
  const { found, loginPath } = await fromLoginShell();
  const candidates = [
    process.env.SHRIKE_CLAUDE_BIN, // e2e: a recorded stream stands in for the CLI
    found,
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".local/bin/claude"),
    path.join(home, ".local/bin/claude.exe"), // Windows native installer
  ];
  for (const p of candidates) {
    if (!p || !(await access(p, constants.X_OK).then(() => true, () => false))) continue;
    try {
      const env = loginPath ? { ...process.env, PATH: loginPath } : process.env;
      const { stdout } = await exec(p, ["--version"], { timeout: 10_000, env });
      return { path: p, version: /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? stdout.trim(), loginPath };
    } catch {
      continue;
    }
  }
  return undefined;
}

let pathOnce: Promise<string | undefined> | undefined;
/** $PATH from the login shell (a GUI app starts with a minimal one), once per app session. */
export const loginPath = (): Promise<string | undefined> => (pathOnce ??= fromLoginShell().then((r) => r.loginPath));

async function fromLoginShell(): Promise<{ found?: string; loginPath?: string }> {
  // Windows: no login shell, the app already has the full PATH. spawn can't run the npm .cmd shim without a shell, so only an .exe counts.
  if (process.platform === "win32") return exec("where.exe", ["claude"], { timeout: 5000 }).then(({ stdout }) => ({ found: stdout.split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim()))?.trim() }), () => ({}));
  try {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"); // NixOS has no /bin/zsh
    const { stdout } = await exec(shell, ["-lc", 'printf "\\n__SHRIKE__%s\\n" "$(command -v claude)" "$PATH"'], { timeout: 5000 });
    const [cmd, p] = [...stdout.matchAll(/^__SHRIKE__(.*)$/gm)].map((m) => m[1]!.trim());
    const alias = /^alias claude=['"]?(.+?)['"]?$/.exec(cmd ?? "")?.[1];
    const found = alias ?? cmd;
    return { found: found && path.isAbsolute(found) ? found : undefined, loginPath: p || undefined };
  } catch {
    return {};
  }
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// The system prompt goes in a file, never on the command line: a project's own scripts may `pkill -f <word>` (xyne-spaces'
// process-compose pre-hook does), and a prompt that mentions the word would get Claude killed.
export function claudeArgs(goal: string, mcp: { url: string; token: string }, systemPromptFile: string, resume?: string, effort?: Effort, fork?: boolean, deny?: readonly string[]) {
  const config = { mcpServers: { shrike: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}`, "x-shrike-internal": "1" } } } };
  return [
    ...(resume ? (fork ? forkFlags(resume) : ["--resume", resume]) : []), // C1: a fork copies the session, the parent stays as it was
    "-p", goal,
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", JSON.stringify(config),
    "--strict-mcp-config",
    "--tools", "",
    "--allowedTools", "mcp__shrike",
    ...(deny?.length ? ["--disallowedTools", deny.map((t) => `mcp__shrike__${t}`).join(",")] : []), // C3/C6: read-only runs can't call these
    "--append-system-prompt-file", systemPromptFile,
    ...(effort ? ["--effort", effort] : []),
  ];
}

type Json = Record<string, any>;

export interface ParserState {
  gotResult: boolean;
  resultError: boolean;
  giveUp: boolean; // a failure retrying won't fix (sign-in): the caller stops Claude Code now
  unreadable: number; // lines that weren't JSON: another output format
  openTools: number; // tool calls without a result yet
}

// Newline-delimited JSON from `claude -p --output-format stream-json --verbose`.
export function createStreamParser(emitStep: (s: StepInput) => void, hooks: StreamHooks = {}) {
  let buf = "";
  // X3/X6: thinking and per-message usage ride on the next step emitted.
  let pending: Pick<StepInput, "usage" | "thinking"> = {};
  const turns = new Map<string, TurnUsage>();
  const emit = (s: StepInput) => {
    if (pending.usage || pending.thinking) (s = { ...s, ...pending }), (pending = {});
    emitStep(s);
  };
  const names = new Map<string, string>();
  const state: ParserState = { gotResult: false, resultError: false, giveUp: false, unreadable: 0, openTools: 0 };
  let session: string | undefined;
  // One assistant message can span several lines that repeat its usage: keep the latest per message id.
  const perMessage = new Map<string, { input: number; output: number }>();
  const usage: UsageInput = { inputTokens: 0, outputTokens: 0 };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = (u: Json) => n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
  const sendUsage = () => hooks.onUsage?.({ ...usage });

  const handle = (o: Json) => {
    if (typeof o.session_id === "string" && o.session_id && o.session_id !== session) {
      session = o.session_id;
      hooks.onSession?.(session);
    }
    if (o.type === "system" && o.subtype === "init") {
      // ponytail: the window size until the result line reports it; "[1m]" models have 1M, the rest 200k.
      if (typeof o.model === "string") usage.contextLimit = /\[1m\]/i.test(o.model) ? 1_000_000 : 200_000;
      const shrike = (o.mcp_servers as Json[] | undefined)?.find((s) => s.name === "shrike");
      if (shrike && shrike.status !== "connected") {
        emit({ kind: "error", text: "Claude Code could not connect to Shrike's tools.", detail: JSON.stringify(shrike) });
      }
      for (const s of (o.mcp_servers ?? []) as Json[]) {
        if (s.name !== "shrike" && s.status === "failed") emit({ kind: "message", text: `Your tool ${s.name} didn't start, so this run goes on without it.`, detail: JSON.stringify(s) });
      }
    } else if (o.type === "system" && o.subtype === "api_retry") {
      // Claude Code retries 10 times over ~3 minutes, even a sign-in it can't fix: stop after the second (the first may follow a token refresh),
      // and say why the run shows Working for the rest.
      if (o.error === "authentication_failed" || o.error_status === 401 || o.error_status === 403) {
        if (state.giveUp || n(o.attempt) < 2) return;
        state.giveUp = state.resultError = true;
        return emit({ kind: "error", text: SIGN_IN, detail: JSON.stringify(o) });
      }
      if (o.attempt !== 3) return; // third try, so a blip stays quiet
      const text =
        o.error_status === 429 || o.error === "rate_limit"
          ? "Claude Code hit a rate limit. It keeps retrying for a few minutes."
          : o.error_status
            ? "Claude's servers are busy right now. Claude Code keeps retrying."
            : "Claude Code can't reach Claude's servers. It keeps retrying; check your internet connection.";
      emit({ kind: "message", text, detail: JSON.stringify(o) });
    } else if (o.type === "assistant") {
      if (o.is_api_error_message || o.error) return; // the result line reports it
      const u = o.message?.usage as Json | undefined;
      if (u && typeof o.message?.id === "string") {
        perMessage.set(o.message.id, { input: prompt(u), output: n(u.output_tokens) });
        const all = [...perMessage.values()];
        usage.inputTokens = all.reduce((a, m) => a + m.input, 0);
        usage.outputTokens = all.reduce((a, m) => a + m.output, 0);
        usage.contextTokens = prompt(u) + n(u.output_tokens);
        sendUsage();
        const t = turnUsage(u);
        const d = usageDelta(turns.get(o.message.id), t);
        turns.set(o.message.id, t);
        if (d) pending.usage = addUsage(pending.usage, d);
      }
      for (const b of (o.message?.content ?? []) as Json[]) {
        if (b.type === "thinking") pending.thinking = thinkingText(b.thinking) ?? pending.thinking;
        else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) emit({ kind: "message", text: b.text.trim() });
        else if (b.type === "tool_use") {
          names.set(b.id, b.name);
          state.openTools++;
          emit(toolUseStep(b.name, b.input));
        }
      }
    } else if (o.type === "user") {
      const content = o.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content as Json[]) {
        if (b.type !== "tool_result") continue;
        state.openTools = Math.max(0, state.openTools - 1);
        emit(toolResultStep(names.get(b.tool_use_id), resultText(b.content), b.is_error === true));
      }
    } else if (o.type === "rate_limit_event") {
      const at = n(o.rate_limit_info?.resetsAt);
      if (at) {
        usage.rateLimitResetsAt = at * 1000;
        sendUsage();
      }
    } else if (o.type === "result") {
      state.gotResult = true;
      if (o.usage && typeof o.usage === "object") {
        usage.inputTokens = prompt(o.usage);
        usage.outputTokens = n(o.usage.output_tokens);
      }
      // X6: per-line output_tokens undercount (they are sent before the message finishes); the result line's total is right, so the done step carries the rest.
      const said = [...turns.values()].reduce((a, t) => a + t.output, 0);
      const rest = o.usage && typeof o.usage === "object" ? Math.max(0, n(o.usage.output_tokens) - said) : 0;
      if (rest || typeof o.total_cost_usd === "number") {
        const p = pending.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        pending.usage = { ...p, output: p.output + rest, ...(typeof o.total_cost_usd === "number" ? { costUsd: o.total_cost_usd } : {}) };
      }
      if (typeof o.total_cost_usd === "number") usage.costUsd = o.total_cost_usd;
      const windows = Object.values((o.modelUsage ?? {}) as Record<string, Json>).map((m) => n(m.contextWindow)).filter(Boolean);
      if (windows.length) usage.contextLimit = Math.max(...windows);
      if (o.usage || o.total_cost_usd !== undefined) sendUsage();
      if (o.is_error) {
        if (state.giveUp) return; // said already
        state.resultError = true;
        emit(errorStep(o));
      } else {
        emit({ kind: "done", text: "Done", detail: typeof o.result === "string" ? o.result : undefined });
      }
    }
  };

  const line = (l: string) => {
    if (!l.trim()) return;
    let o: unknown;
    try {
      o = JSON.parse(l);
    } catch {
      state.unreadable++;
      return;
    }
    if (o && typeof o === "object") handle(o as Json);
  };

  return {
    state,
    session: () => session,
    push(chunk: string) {
      buf += chunk;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      line(buf);
      buf = "";
    },
  };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[]).filter((c) => c.type === "text").map((c) => String(c.text)).join("\n");
}

const SIGN_IN = "Sign in to Claude Code again: open a terminal, run claude, and type /login. Then try again.";

// The result texts Claude Code 2.1 ends with (recorded against a local stand-in for Claude's API), in plain words. The CLI's own text stays in detail.
const PLAIN: [RegExp, string][] = [
  [/invalid api key|x-api-key/i, "Claude Code's API key was refused. Check ANTHROPIC_API_KEY, or remove it and sign in with claude, then /login."],
  [/not logged in|\/login|authenticat|oauth token|token has expired/i, SIGN_IN],
  [/credit balance|billing/i, "Your Anthropic account is out of credit. Add credit, then try again."],
  [/usage limit|limit reached|hit your limit|rate.?limit|\b429\b/i, "Claude Code hit its usage limit. Try again when it resets."],
  [/overloaded|\b529\b|capacity/i, "Claude's servers are busy. Try again in a moment."],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|connection|network|timed out|fetch failed|offline/i, "Claude Code couldn't reach Claude's servers. Check your internet connection, then try again."],
];

function errorStep(o: Json): StepInput {
  const raw = typeof o.result === "string" && o.result ? o.result : Array.isArray(o.errors) ? o.errors.join("; ") : "";
  const plain = PLAIN.find(([re]) => re.test(raw))?.[1];
  if (plain) return { kind: "error", text: plain, detail: raw };
  return { kind: "error", text: raw || `Claude Code stopped (${o.subtype ?? "error"}).`, detail: JSON.stringify(o) };
}

const UPDATE = "Update Claude Code (run claude update in a terminal), then try again.";
// A long tool call (MCP_TOOL_TIMEOUT 10 min) or a deep turn can be quiet for minutes; a run silent this long is stuck.
export const SILENCE = { noteMs: 3 * 60_000, stopMs: 15 * 60_000 };

export function runClaudeCode(o: {
  bin: ClaudeBinary;
  args: string[];
  cwd: string;
  emit: (s: StepInput) => void;
  onExit: (failed: boolean) => void;
  hooks?: StreamHooks;
  silence?: typeof SILENCE; // tests shorten it
}): { kill(): void } {
  const env = { ...process.env, ...(o.bin.loginPath ? { PATH: o.bin.loginPath } : {}), MCP_TOOL_TIMEOUT: "600000" };
  const child = spawn(o.bin.path, o.args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const parser = createStreamParser(o.emit, o.hooks);
  const stderr: string[] = [];
  let exited = false;
  let spawnError: Error | undefined;
  let stuck = false;
  const silence = o.silence ?? SILENCE;
  let heard = Date.now();
  let noted = false;
  const watch = setInterval(() => {
    const quiet = Date.now() - heard;
    if (quiet >= silence.stopMs) {
      stuck = true;
      kill();
    } else if (quiet >= silence.noteMs && !noted && !parser.state.openTools) {
      noted = true;
      o.emit({ kind: "message", text: "No word from Claude Code for a few minutes. It may be offline or stuck; you can stop it and try again." });
    }
  }, Math.min(15_000, silence.noteMs / 2));
  watch.unref();

  child.stdout.setEncoding("utf8").on("data", (c: string) => {
    heard = Date.now();
    noted = false;
    parser.push(c);
    if (parser.state.giveUp) kill();
  });
  child.stderr.setEncoding("utf8").on("data", (c: string) => {
    stderr.push(...c.split("\n").filter((l) => l.trim()));
    if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
  });
  child.on("error", (err) => (spawnError = err));
  child.on("close", (code, signal) => {
    exited = true;
    clearInterval(watch);
    parser.end();
    const { gotResult, resultError, unreadable } = parser.state;
    if (spawnError) {
      o.emit({ kind: "error", text: `Couldn't start Claude Code: ${spawnError.message}` });
      return o.onExit(true);
    }
    if (resultError) return o.onExit(true);
    if (code !== 0 || !gotResult) {
      const tail = stderr.slice(-20).join("\n") || undefined;
      const text = stuck
        ? `Claude Code stopped answering for ${Math.round(silence.stopMs / 60_000)} minutes, so Shrike stopped it. Try again.`
        : /unknown option|unknown argument|unexpected argument/i.test(tail ?? "")
          ? `This version of Claude Code (${o.bin.version}) doesn't accept what Shrike asks of it. ${UPDATE}`
          : code === 0 && unreadable
            ? `Claude Code answered in a way Shrike can't read. ${UPDATE}`
            : code !== null
              ? `Claude Code quit before finishing (exit code ${code}). Try again.`
              : `Claude Code was stopped (${signal}) before finishing. Try again.`;
      o.emit({ kind: "error", text, detail: tail });
      return o.onExit(true);
    }
    o.onExit(false);
  });

  function kill() {
    if (exited) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 3000).unref();
  }
  return { kill };
}
