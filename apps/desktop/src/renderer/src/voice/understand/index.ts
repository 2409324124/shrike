import type { VoiceChip } from "@shrike/schema";
import type { LiveContext } from "../../actions/registry.ts";
import { checkPlan, plannerContext, plannerSchema, PLANNER_PREFIX, type Checked } from "./plan.ts";
import { nearest, parse, type Step } from "./parse.ts";

// The cascade (docs/16 §2.4): tier 0 + 1 grammar, then the bundled planner, then "Didn't catch that" with chips.
// Never a silent agent run: the agent only gets words the grammar or the planner sent there (agent.ask).

export type { Step } from "./parse.ts";

export type Understood =
  | { kind: "plan"; steps: Step[]; source: "grammar" | "planner"; ms: number; dropped?: Checked["dropped"] }
  | { kind: "close"; options: Step[][]; ms: number }
  | { kind: "none"; chips: VoiceChip[]; ms: number; why: "nothing" | "timeout" | "missing" | "failed" };

/** Asks the planner; null when there's none (not downloaded) or it failed. */
export type PlanFn = (ask: { prefix: string; context: string; text: string; schema: Record<string, unknown> }) => Promise<{ json: unknown } | { error: "missing" | "timeout" | "failed" }>;

export async function understand(text: string, ctx: LiveContext, plan?: PlanFn): Promise<Understood> {
  const t = performance.now();
  const g = parse(text, ctx);
  if (g.kind === "plan") return { kind: "plan", steps: g.steps, source: "grammar", ms: performance.now() - t };
  if (g.kind === "close") return { kind: "close", options: g.options, ms: performance.now() - t };
  const miss = (why: "nothing" | "timeout" | "missing" | "failed"): Understood => ({ kind: "none", chips: nearest(text), ms: performance.now() - t, why });
  if (!plan || !text.trim()) return miss("nothing");
  const r = await plan({ prefix: PLANNER_PREFIX, context: plannerContext(ctx), text, schema: plannerSchema(ctx) }).catch(() => ({ error: "failed" as const }));
  if ("error" in r) return miss(r.error);
  const checked = checkPlan(r.json, text, ctx);
  if (!checked.steps.length) return miss("nothing");
  return { kind: "plan", steps: checked.steps, source: "planner", ms: performance.now() - t, dropped: checked.dropped };
}

export { parse, nearest, stepTitle, agentText, clauseCount, goAhead } from "./parse.ts";
export { checkPlan, plannerContext, plannerSchema, PLANNER_PREFIX } from "./plan.ts";
export { normalize } from "./normalize.ts";
