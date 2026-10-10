// C1–C7 conversation branches: the pure parts (names, colours, fork prompts, built-in slicing, worktree routing).
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRunInfo, AgentStep } from "@shrike/schema";

export type BrainMessage = Anthropic.MessageParam; // the built-in brain's history, for callers without the SDK

export const BRANCH_COLORS = ["violet", "cyan", "amber", "magenta", "teal"] as const;

/** The first colour no live branch uses; when all five are taken, they repeat in order. */
export function nextColor(used: (string | undefined)[]): string {
  return BRANCH_COLORS.find((c) => !used.includes(c)) ?? BRANCH_COLORS[used.length % BRANCH_COLORS.length]!;
}

const FILLER = new Set("a an the is it its of to in on for and or but if what whats what's how why when where which who does do did can could would should will be this that these those maybe instead try trying let lets let's me my we our you your about with from there here than then just really".split(" "));

/** A short label: the name given, else 3–4 telling words of the question ("try the cache instead?" -> "cache"). */
export function branchName(question: string, given?: string): string {
  const g = given?.replace(/\s+/g, " ").trim().slice(0, 40);
  if (g) return g;
  const words = question.toLowerCase().replace(/['’]/g, "").match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  const kept = words.filter((w) => !FILLER.has(w));
  return (kept.length ? kept : words).slice(0, 4).join(" ").slice(0, 40) || "branch";
}

/** A worktree name for a branch (worktrees.ts NAME_RE: lowercase, digits, dashes, at most 40). */
export function worktreeName(name: string, suffix: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return `branch-${slug || "x"}-${suffix}`.slice(0, 40);
}

export const ASIDE_RULE =
  "This is a side question. Answer it in a few sentences from what you already know or can read. Don't propose or apply patches, and don't click, type or send requests.";
/** Shrike tools that change code, drive the app, move your view or write state: denied to asides and read-only branches, not just asked. */
export const WRITE_TOOLS = [
  "propose_patch", "propose_skill_update", "remember", "app_click", "app_type", "app_navigate", "send_request", "run_scenario",
  "run_flow", "record_flow", "run_app", "stop_app", "open_project", "ask_agent", "focus_trip", "open_file",
] as const;

export const READ_ONLY_RULE = "This branch can't have its own copy of the code, so don't propose or apply patches: describe the fix in words instead.";

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * C1: the first message of a branch. Forked from the latest point there is nothing to set aside; from an earlier step,
 * the branch is told to set aside what came after it (ponytail: Claude Code can't resume at a message, so this is an instruction, not a cut).
 */
export function branchQuestion(question: string, from?: { text: string; latest: boolean }): string {
  const q = question.trim();
  if (!from || from.latest) return q;
  return `Set aside everything after this point of our conversation ("${clip(from.text, 160)}"), as if it never happened, and think about it differently from there: ${q}`;
}

/** Nothing meaningful came after this step (its own tool's answer, closing words, "Done"), so a fork from it needs no set-aside. */
export const isLatest = (steps: AgentStep[], at: number): boolean =>
  steps.slice(at + 1).every((s) => s.kind === "done" || (s.kind === "message" && !s.tool) || (s.kind === "tool_result" && !!s.tool && s.tool === steps[at]?.tool));

/** Claude Code flags for a fork: copy the session under a new id, so the parent session is never changed. */
export const forkFlags = (session: string) => ["--resume", session, "--fork-session"];

/** The built-in brain branches exactly: the parent's messages up to the step's turn, then the new question. */
export function sliceHistory(history: Anthropic.MessageParam[], cut: number | undefined, question: string): Anthropic.MessageParam[] {
  const msgs = history.slice(0, cut ?? history.length);
  const last = msgs.at(-1);
  if (last?.role === "user") {
    // after tool results: the question joins that turn, so user and assistant still alternate
    const content: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
    return [...msgs.slice(0, -1), { role: "user", content: [...content, { type: "text", text: question }] }];
  }
  return [...msgs, { role: "user", content: question }];
}

/** What a branch concluded, in one line: its findings, else its final words. */
export function branchFinding(steps: AgentStep[]): string | undefined {
  const f = steps.findLast((s) => s.kind === "findings");
  const done = steps.findLast((s) => s.kind === "done");
  const said = steps.findLast((s) => s.kind === "message" && !s.tool);
  const text = f?.summary || f?.findings?.[0]?.claim || (done?.summary && done.summary !== "Done" ? done.summary : undefined) || done?.detail || said?.text;
  return text ? clip(text, 400) : undefined;
}

/** C5: the one short message main gets. */
export const bringBackText = (finding: string) => `Another line of thinking found: ${clip(finding, 400)}`;

export interface WorktreeApi {
  create(name: string, note: string): Promise<void>;
  target(name: string): Promise<{ cwd: string; mcp: { url: string; token: string } }>;
  remove(name: string): Promise<void>;
}

/** C6: a branch that may change code works in its own worktree; an aside, or a project that can't have one, stays read-only. */
export async function branchTarget(
  b: Pick<AgentRunInfo, "name" | "aside">,
  api: WorktreeApi,
  suffix: string,
): Promise<{ worktree?: string; mcp?: { url: string; token: string }; readOnly: boolean; why?: string }> {
  if (b.aside) return { readOnly: true };
  const name = worktreeName(b.name ?? "branch", suffix);
  const why = (err: unknown) => ({ readOnly: true, why: err instanceof Error ? err.message : String(err) });
  try {
    await api.create(name, `branch: ${b.name ?? ""}`.trim());
  } catch (err) {
    return why(err);
  }
  try {
    return { worktree: name, mcp: (await api.target(name)).mcp, readOnly: false };
  } catch (err) {
    await api.remove(name).catch(() => {}); // a copy that can't run is no use; nothing was changed in it yet
    return why(err);
  }
}
