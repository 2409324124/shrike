import type { AgentStep } from "@shrike/schema";

// X-ray: pure helpers over a run's steps (X1 activity, X2 files, X3 thinking, X4 skill, X6 tokens).

type Action = "read" | "search" | "edit";
export interface FileTouch { path: string; action: Action; count: number; ranges: [number, number][]; first: Action; by: Partial<Record<Action, { count: number; ranges: [number, number][] }>>; applied?: boolean }
export interface Turn { stepId: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd?: number }

const RANK: Record<Action, number> = { search: 0, read: 1, edit: 2 };

/** The step after a propose_patch call that says how it ended (the patch step), if any yet. */
function patchOutcome(steps: AgentStep[], i: number): "applied" | "rejected" | undefined {
  for (let j = i + 1; j < steps.length; j++) {
    const s = steps[j]!;
    if (s.kind === "patch") return /rejected/i.test(s.text) ? "rejected" : "applied";
    if (s.kind === "tool_call" && s.tool === "propose_patch") return undefined;
  }
  return undefined;
}

/** X2: one chip per file, the strongest action wins the icon (changed > read > searched), counts and ranges per action for hover. A rejected proposal is dropped. */
export function fileTouches(steps: AgentStep[]): FileTouch[] {
  const by = new Map<string, FileTouch>();
  steps.forEach((s, i) => {
    const outcome = s.kind === "tool_call" && s.tool === "propose_patch" ? patchOutcome(steps, i) : undefined;
    for (const f of s.files ?? []) {
      if (f.action === "edit" && outcome === "rejected") continue;
      const t = by.get(f.path) ?? { path: f.path, action: f.action, count: 0, ranges: [], first: f.action, by: {} };
      t.count++;
      if (RANK[f.action] > RANK[t.action]) t.action = f.action;
      if (f.action === "edit" && outcome === "applied") t.applied = true;
      const a = (t.by[f.action] ??= { count: 0, ranges: [] });
      a.count++;
      if (f.lines && !a.ranges.some((r) => r[0] === f.lines![0] && r[1] === f.lines![1])) a.ranges.push(f.lines);
      if (f.lines && !t.ranges.some((r) => r[0] === f.lines![0] && r[1] === f.lines![1])) t.ranges.push(f.lines);
      by.set(f.path, t);
    }
  });
  return [...by.values()];
}

/** Paths the agent read (not only searched), for the Thread's "looked here" outlines. */
export const readPaths = (steps: AgentStep[]): string[] => [...new Set(steps.flatMap((s) => (s.files ?? []).filter((f) => f.action === "read").map((f) => f.path)))];

const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
export const wasRead = (paths: string[], file: string | undefined) => !!file && paths.some((p) => sameFile(p, file));

/** X1: the live action. */
export function activityOf(steps: AgentStep[]): string | undefined {
  const s = steps.at(-1);
  if (!s) return undefined;
  // A result alone loses its target ("Found 3 matches"): show the call it answers.
  const call = s.kind === "tool_result" && !s.activity ? steps.findLast((x) => x.kind !== "tool_result" && !!s.tool && x.tool === s.tool) : undefined; // a playbook's text too
  const t = (s.activity ?? call?.activity ?? call?.text ?? (s.kind === "done" ? (s.summary ?? "Done") : s.text)).split("\n")[0]!.trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : t;
}

/** X3: the latest reasoning the brain sent. */
export const latestThinking = (steps: AgentStep[]): string | undefined => steps.findLast((s) => !!s.thinking)?.thinking;

/** X4: the loaded skill, and why, when the agent said so in the words right before loading it. */
export function activeSkill(steps: AgentStep[]): { id: string; why?: string } | undefined {
  const i = steps.findIndex((s) => s.tool === "load_skill" && !!s.skill);
  if (i < 0) {
    const any = steps.find((s) => s.skill);
    return any?.skill ? { id: any.skill } : undefined;
  }
  const prev = steps[i - 1];
  const why = prev?.kind === "message" && !prev.tool ? prev.text.split("\n")[0]!.trim() : undefined;
  return { id: steps[i]!.skill!, ...(why ? { why } : {}) };
}

// Relative prices that hold across Claude models (input 1, output 5, cache read 0.1, cache write 1.25): used only to share the run's real cost across turns.
const weight = (t: Omit<Turn, "stepId">) => t.input + t.output * 5 + t.cacheRead * 0.1 + t.cacheWrite * 1.25;

/** X6: tokens per agent turn (a message's later lines fold into it), the run total, and the most expensive turn. */
export function turnTokens(steps: AgentStep[]): { turns: Turn[]; total: Omit<Turn, "stepId">; costliest?: string } {
  const turns: Turn[] = [];
  let cost: number | undefined;
  let missed = 0;
  for (const s of steps) {
    const u = s.usage;
    if (!u) continue;
    if (u.costUsd != null) cost = (cost ?? 0) + u.costUsd;
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    if (!prompt && turns.length && (s.kind === "done" || s.kind === "error")) missed += u.output; // the result line's correction
    else if (prompt > 0 || !turns.length) {
      if (prompt || u.output) turns.push({ stepId: s.id, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
    } else turns.at(-1)!.output += u.output;
  }
  // ponytail: the correction is shared by each turn's reported output; the stream doesn't say which turn it belongs to.
  const said = turns.reduce((a, t) => a + t.output, 0);
  let left = missed;
  turns.forEach((t, i) => {
    const add = i === turns.length - 1 ? left : Math.round((missed * (said ? t.output : 1)) / (said || turns.length));
    left -= add;
    t.output += add;
  });
  const total = turns.reduce((a, t) => ({ input: a.input + t.input, output: a.output + t.output, cacheRead: a.cacheRead + t.cacheRead, cacheWrite: a.cacheWrite + t.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as Omit<Turn, "stepId">);
  const all = turns.reduce((a, t) => a + weight(t), 0);
  if (cost != null && all > 0) for (const t of turns) t.costUsd = (cost * weight(t)) / all;
  const top = turns.length > 1 ? turns.reduce((a, t) => (weight(t) > weight(a) ? t : a)) : undefined;
  return { turns, total: cost != null ? { ...total, costUsd: cost } : total, ...(top ? { costliest: top.stepId } : {}) };
}

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n)));
export const fmtCost = (usd: number) => (usd < 0.001 ? "<$0.001" : `$${usd.toFixed(usd < 1 ? 3 : 2)}`);
export const rangeText = (r: [number, number]) => (r[0] === r[1] ? `line ${r[0]}` : `lines ${r[0]}-${r[1]}`);

// ---- MCP6: calls to the user's own MCP servers (mcp__<server>__<tool>; Shrike's own tools arrive without their prefix) ----

export function mcpCall(tool: string | undefined): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool ?? "");
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
}

/** Each call step's time until its result (the next result of the same tool), by step id. */
export function mcpTimings(steps: AgentStep[]): Map<string, { ms?: number; failed?: boolean }> {
  const out = new Map<string, { ms?: number; failed?: boolean }>();
  const open: AgentStep[] = [];
  for (const s of steps) {
    if (!mcpCall(s.tool)) continue;
    if (s.kind === "tool_call") (open.push(s), out.set(s.id, {}));
    else if (s.kind === "tool_result") {
      const i = open.findIndex((c) => c.tool === s.tool);
      if (i < 0) continue;
      const [c] = open.splice(i, 1);
      out.set(c!.id, { ms: Math.max(0, s.createdAt - c!.createdAt), ...(s.text.startsWith("Problem:") ? { failed: true } : {}) });
    }
  }
  return out;
}

export interface McpUse { server: string; calls: number; ms: number; tools: string[]; failed: number }
/** The servers a run used, in first-use order: calls, time spent, which tools, how many failed. */
export function mcpUsage(steps: AgentStep[]): McpUse[] {
  const t = mcpTimings(steps);
  const by = new Map<string, McpUse>();
  for (const s of steps) {
    const c = s.kind === "tool_call" ? mcpCall(s.tool) : undefined;
    if (!c) continue;
    const u = by.get(c.server) ?? { server: c.server, calls: 0, ms: 0, tools: [], failed: 0 };
    u.calls++;
    u.ms += t.get(s.id)?.ms ?? 0;
    if (t.get(s.id)?.failed) u.failed++;
    if (!u.tools.includes(c.tool)) u.tools.push(c.tool);
    by.set(c.server, u);
  }
  return [...by.values()];
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
