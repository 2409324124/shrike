import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentOptions, AgentRunInfo, AgentStep, AgentUsage, BrainId, BrainInfo, ShrikeHost } from "@shrike/schema";
import type Anthropic from "@anthropic-ai/sdk";
import { runBuiltin, BUILTIN_MODEL, type AnthropicLike } from "./builtin.ts";
import { claudeArgs, resolveClaude, runClaudeCode, type Effort } from "./claude-code.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { WRITE_TOOLS } from "./branches.ts";
import { mcpPromptLine, readMyMcpServers, withMyMcp, type Server } from "./my-mcp.ts";
import type { StepInput } from "./steps.ts";

export { createStreamParser, claudeArgs, loginPath, resolveClaude, type Effort, type UsageInput } from "./claude-code.ts";

/** Think harder dial: Quick and Deep move the brain's effort; Normal leaves its default. */
export const effortFor = (t: AgentOptions["thinking"]): Effort | undefined => (t === "quick" ? "low" : t === "deep" ? "xhigh" : undefined);

export const PLAN_FIRST =
  "Plan first: before you change any file, call plan with the checks you'll make and the files you expect to touch, and say in one sentence what you'll change. Then go ahead.";

/** The goal the brain receives with the Ask pill's options: skill, plan first, extra context lines. */
export function goalWithOptions(goal: string, o: Pick<AgentOptions, "planFirst" | "skillId" | "context"> = {}): string {
  const lines = [goal.trim()];
  if (o.skillId) lines.push(`Load the ${o.skillId} playbook with load_skill first and follow it.`);
  if (o.planFirst) lines.push(PLAN_FIRST);
  for (const c of o.context ?? []) if (c.trim()) lines.push(c.replace(/\s+/g, " ").trim().slice(0, 400));
  return lines.join("\n");
}
export { fillTemplate, buildSystemPrompt } from "./prompt.ts";
export { checkMcpServer, mcpPromptLine, readClaudeMcp, readMyMcpServers, servers as mcpServersOf, withMyMcp, type ClaudeMcp, type McpCheck, type Server as McpServerConfig } from "./my-mcp.ts"; // B4, MCP
export type { AnthropicLike } from "./builtin.ts";
export * from "./branches.ts"; // C1–C7

/** A run's tools stay on the folder it started in: after a workspace switch they refuse, rather than read or patch the other folder. */
export function bindHost(host: ShrikeHost, root: string, current: () => string | undefined): ShrikeHost {
  return new Proxy(host, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        if (current() !== root) throw new Error(`This run started in ${basename(root)}, which isn't the open workspace now. Switch back to it in Shrike, then ask again.`);
        return v.apply(t, a);
      };
    },
  });
}

export async function detectBrains(): Promise<BrainInfo[]> {
  const bin = await resolveClaude();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      available: Boolean(bin),
      detail: bin ? `v${bin.version} at ${bin.path}` : "Install Claude Code to use your own subscription",
    },
    {
      id: "builtin",
      label: "Built-in (API key)",
      available: hasKey,
      detail: hasKey ? `Uses ANTHROPIC_API_KEY with ${BUILTIN_MODEL}` : "Set ANTHROPIC_API_KEY to enable",
    },
  ];
}

export function startAgentRun(opts: {
  goal: string;
  brain: BrainId;
  cwd: string;
  mcp: { url: string; token: string };
  context: { frontend?: string; backend?: string; appUrl?: string; routeCount: number; recentActions: string; memory?: string; skills?: string };
  onStep(step: AgentStep): void;
  onStatus(info: AgentRunInfo): void;
  onUsage?(usage: AgentUsage): void; // A7
  onSession?(sessionId: string): void; // A13: Claude Code session, for resume
  resume?: string; // Claude Code session id to continue (goal is then the follow-up prompt)
  promptsDir: string;
  effort?: Effort; // Think harder dial
  useMyMcp?: boolean; // B4: also give Claude Code the user's own MCP servers; never by default
  myMcp?(): Promise<Record<string, Server>>; // MCP6: the servers to pass (Claude Code's and Shrike's own, this project's on/off); defaults to Claude Code's
  anthropic?: AnthropicLike; // tests inject a fake; defaults to the real SDK client
  fork?: boolean; // C1: with resume, Claude Code copies the session (--fork-session) and leaves the parent untouched
  history?: Anthropic.MessageParam[]; // C1: built-in brain starts from these messages (sliceHistory)
  onHistory?(messages: Anthropic.MessageParam[], cuts: ReadonlyMap<string, number>): void; // C1: built-in turns, step id -> messages to keep
  branch?: Pick<AgentRunInfo, "parentRunId" | "branchFromStepId" | "name" | "color" | "aside" | "worktree" | "continues">; // C: carried on info
  readOnly?: boolean; // C3/C6: the brain can't call WRITE_TOOLS
  prompt?: { file: string; vars: Record<string, string> }; // R: another system prompt in promptsDir (start.md) with its own variables
}): { info: AgentRunInfo; stop(): void } {
  const info: AgentRunInfo = { id: randomUUID(), goal: opts.goal, brain: opts.brain, status: "running", ...opts.branch };
  const deny = opts.readOnly ? WRITE_TOOLS : undefined;
  const cuts = new Map<string, number>();
  let uncut: string[] = []; // built-in step ids of the turn in flight
  const abort = new AbortController();
  let kill: (() => void) | undefined;
  let cleanup: (() => Promise<void>) | undefined; // B4 temp config

  // The final card only claims "verified" when a re-run after the applied fix came back clean.
  let applied: string | undefined;
  let verified: boolean | undefined;
  let skill: string | undefined; // A4: every step after load_skill carries the playbook id
  const emit = (s: StepInput) => {
    if (info.status !== "running") return;
    if (s.tool === "load_skill" && s.skill) skill = s.skill;
    if (skill && !s.skill) s = { ...s, skill };
    if (s.kind === "patch" && s.text === "Fix applied") {
      applied = s.patchId;
      verified = undefined;
    } else if (applied && s.kind === "tool_result" && (s.tool === "run_scenario" || s.tool === "compare_actions")) {
      const t = s.detail ?? "";
      if (/Result: PASS|Verdict: fixed/.test(t)) verified = true;
      else if (/Result: FAIL|Verdict: (not fixed|regressed)/.test(t)) verified = false;
    } else if (s.kind === "done" && applied) {
      const summary = verified ? "Fixed and verified" : verified === false ? "Fix applied, but the re-run still shows a problem" : "Fix applied, not verified yet";
      s = { ...s, summary, patchId: applied };
    }
    const id = randomUUID();
    uncut.push(id);
    opts.onStep({ ...s, id, runId: info.id, createdAt: Date.now() });
  };
  const finish = (status: AgentRunInfo["status"]) => {
    if (info.status !== "running") return;
    info.status = status;
    void cleanup?.().catch(() => {});
    opts.onStatus({ ...info });
  };
  const onUsage = (u: Omit<AgentUsage, "runId">) => {
    if (info.status === "running") opts.onUsage?.({ ...u, runId: info.id });
  };
  const fail = (text: string) => {
    emit({ kind: "error", text });
    finish("failed");
  };

  const go = async () => {
    const c = opts.context;
    const system = await buildSystemPrompt(opts.promptsDir, {
      frontend: c.frontend ?? "unknown",
      backend: c.backend ?? "unknown",
      appUrl: c.appUrl ?? "not running yet",
      routeCount: String(c.routeCount),
      autonomy: "fix",
      recentActions: c.recentActions.trim() || "  (nothing recorded yet)",
      memory: c.memory?.trim() || "(nothing yet)",
      skills: c.skills?.trim() || "  (none)",
      goal: opts.goal,
      ...opts.prompt?.vars,
    }, opts.prompt?.file);
    if (abort.signal.aborted) return;

    if (opts.brain === "builtin") {
      if (!opts.anthropic && !process.env.ANTHROPIC_API_KEY) return fail("Set ANTHROPIC_API_KEY to use the built-in agent.");
      const onTurn = (m: Anthropic.MessageParam[]) => {
        for (const id of uncut) cuts.set(id, m.length);
        uncut = [];
        opts.onHistory?.(m.slice(), cuts);
      };
      const failed = await runBuiltin({ goal: opts.goal, system, mcp: opts.mcp, emit, signal: abort.signal, anthropic: opts.anthropic, onUsage, effort: opts.effort, history: opts.history, onTurn, deny });
      return finish(failed ? "failed" : "done");
    }

    const bin = await resolveClaude();
    if (abort.signal.aborted) return;
    if (!bin) return fail("Claude Code isn't installed. Install it, or set ANTHROPIC_API_KEY to use the built-in agent.");
    const own = opts.useMyMcp ? await (opts.myMcp?.() ?? readMyMcpServers(opts.cwd)) : {};
    const promptDir = await mkdtemp(join(tmpdir(), "shrike-prompt-"));
    const promptFile = join(promptDir, "system.md");
    const line = mcpPromptLine(Object.keys(own));
    await writeFile(promptFile, line ? `${system}\n\n${line}\n` : system, { mode: 0o600 });
    cleanup = () => rm(promptDir, { recursive: true, force: true });
    let args = claudeArgs(opts.goal, opts.mcp, promptFile, opts.resume, opts.effort, opts.fork, deny);
    if (opts.useMyMcp) {
      const mine = await withMyMcp(args, own);
      args = mine.args;
      cleanup = async () => (await mine.remove(), await rm(promptDir, { recursive: true, force: true }));
    }
    if (abort.signal.aborted) return void (await cleanup());
    kill = runClaudeCode({
      bin,
      args,
      cwd: opts.cwd,
      emit,
      hooks: { onUsage, onSession: (id) => opts.onSession?.(id) },
      onExit: (failed) => finish(failed ? "failed" : "done"),
    }).kill;
  };

  queueMicrotask(() => {
    if (info.status !== "running") return;
    opts.onStatus({ ...info });
    go().catch((err) => fail(err instanceof Error ? err.message : String(err)));
  });

  return {
    info,
    stop() {
      if (info.status !== "running") return;
      abort.abort();
      kill?.();
      finish("stopped");
    },
  };
}
