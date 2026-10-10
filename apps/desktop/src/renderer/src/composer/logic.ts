import type { AgentRunInfo, AgentStep } from "@shrike/schema";

// The composer's pure parts (Q1–Q3): the @file query under the caret and the conversation's turns.

/** `@que|` before the caret: where the @ starts and what follows it. */
export function atQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
}

/** Drops the `@que` at `start` (a chip carries the file instead). */
export const dropAt = (text: string, start: number, caret: number): string => (text.slice(0, start) + text.slice(caret)).replace(/ {2,}/g, " ");

export interface Turn {
  run: AgentRunInfo;
  prompt: string; // what you typed
  context: string[]; // the "Context: …" lines your chips added
  answer?: string; // the agent's last word
  state: "working" | "done" | "failed" | "stopped";
  steps: AgentStep[]; // everything in between, shown collapsed
  branch?: { name: string; color?: string };
}

/** The goal as sent: your words, then one `Context:` line per chip (goalWithContext). */
export function splitGoal(goal: string): { prompt: string; context: string[] } {
  const lines = goal.split("\n");
  const context = lines.filter((l) => /^Context: /.test(l)).map((l) => l.replace(/^Context: /, ""));
  return { prompt: lines.filter((l) => !/^Context: /.test(l)).join("\n").trim(), context };
}

/** The agent's answer to a run: its summary, else what it found, else its last message or error. */
export function answerOf(steps: AgentStep[]): string | undefined {
  const done = steps.findLast((s) => s.kind === "done" && s.summary?.trim());
  if (done) return done.summary!.trim();
  const found = steps.findLast((s) => s.kind === "findings" && (s.findings?.length || s.summary));
  if (found) return found.summary?.trim() || found.findings!.map((f) => `**${cap(f.confidence)}.** ${f.claim}${f.file ? ` → \`${f.file}${f.line ? `:${f.line}` : ""}\`` : ""}`).join("\n\n");
  return steps.findLast((s) => (s.kind === "message" || s.kind === "error" || s.kind === "done") && s.text.trim())?.text.trim();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One turn per run of this worktree's session, oldest first. Asides never enter the session. */
export function turns(runs: AgentRunInfo[], stepsOf: (runId: string) => AgentStep[] | undefined): Turn[] {
  return runs
    .filter((r) => !r.aside)
    .map((run) => {
      const steps = stepsOf(run.id) ?? [];
      const { prompt, context } = splitGoal(run.goal);
      return {
        run,
        prompt,
        context,
        answer: answerOf(steps),
        state: run.status === "running" ? "working" : run.status,
        steps: steps.filter((s) => s.kind !== "done" && s.kind !== "findings"),
        ...(run.parentRunId ? { branch: { name: run.name ?? "branch", ...(run.color ? { color: run.color } : {}) } } : {}),
      };
    });
}
