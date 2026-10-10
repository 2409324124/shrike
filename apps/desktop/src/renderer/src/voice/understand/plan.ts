import { z } from "zod";
import { ACTIONS, BY_ID, PANELS, type ActionDef, type LiveContext, type SlotKind } from "../../actions/registry.ts";
import { known, normalize } from "./normalize.ts";
import { clauseCount, type Step } from "./parse.ts";

// Tier 2 (docs/16 §2.4): the bundled planner's prompt, its per-turn JSON schema, and the rule checks on what it returns.
// The prompt prefix never changes, so the planner keeps it evaluated; live context rides in the user turn.
// Tested in understand.test.ts; scored by fixtures/voice/eval.ts.

export const PLANNER_ACTIONS: ActionDef[] = ACTIONS.filter((a) => !a.meta && a.id !== "chain.queue" && a.id !== "agent.options");

const EXAMPLES: [string, Record<string, unknown>[]][] = [
  ["open the terminal and run the app", [{ a: "panel.show", panel: "terminal" }, { a: "app.run" }]],
  ["PR 12 kholo", [{ a: "pr.open", pr: 12 }]],
  ["सारे बदलाव कमिट करो", [{ a: "git.commit" }]],
  ["ask Claude what the todos route returns", [{ a: "agent.ask", text: "what the todos route returns" }]],
  ["shop workspace pe chalo", [{ a: "workspace.switch", workspace: "shop" }]],
  ["fix the lint check", [{ a: "ci.fix_check", check: "lint" }]],
  ["सब फाइलें ऐड करो फिर पुश कर दो", [{ a: "git.stage_all" }, { a: "git.push" }]],
  ["what did the server print", [{ a: "panel.show", panel: "terminal" }]],
  ["band karo app ko", [{ a: "app.stop" }]],
  ["take a look at pull request seven", [{ a: "pr.open", pr: 7 }]],
  ["galti kahan hui", [{ a: "failure.next" }]],
  ["muéstrame la red", [{ a: "panel.show", panel: "network" }]],
  ["which checks are failing", [{ a: "ci.open_check", check: "unit" }]],
  ["सर्वर फिर से शुरू करो", [{ a: "app.restart" }]],
  ["what a lovely day", []],
];

const sig = (a: ActionDef): string => (a.slots?.length ? `(${a.slots.map((s) => `${s.name}${s.optional ? "?" : ""}`).join(", ")})` : "");

/** The fixed part of the prompt: built once, identical every turn (the planner caches its evaluation). */
export const PLANNER_PREFIX = [
  "You turn a spoken command for the Shrike debugger app into a JSON plan of actions. The words come from speech recognition in English, Hindi, Hinglish or another language, and may be misheard.",
  "Actions:",
  ...PLANNER_ACTIONS.map((a) => `- ${a.id}${sig(a)}: ${a.help}`),
  "Rules: only the actions the person asked for, in the order they said them, never extra steps. Slot values must come from the app state given with the command. \"the failing check\" is the check whose state is fail. Use agent.ask for questions and requests that are not one of these actions. If it is not a command for this app, return an empty plan.",
  "Examples:",
  ...EXAMPLES.map(([t, plan]) => `${JSON.stringify(t)} -> ${JSON.stringify({ plan })}`),
].join("\n");

/** The live state the slot values must come from, one line each. */
export function plannerContext(ctx: LiveContext): string {
  const lines = [
    ctx.focus && `Focused: ${ctx.focus}`,
    ctx.branch && `Branch: ${ctx.branch}${ctx.ahead ? `, ${ctx.ahead} commits ahead` : ""}${ctx.dirty ? `, ${ctx.dirty} changed files` : ""}${ctx.staged ? `, ${ctx.staged} staged` : ""}`,
    ctx.prs.length && `Open PRs: ${ctx.prs.map((p) => `#${p.number} ${p.title}`).join("; ")}`,
    ctx.checks.length && `CI checks: ${ctx.checks.map((c) => `${c.name}=${c.state}`).join("; ")}`,
    ctx.workspaces.length && `Workspaces: ${ctx.workspaces.map((w) => w.label ?? w.name).join(", ")}`,
    ctx.branches.length && `Branches: ${ctx.branches.slice(0, 15).join(", ")}`,
    ctx.files.length && `Recent files: ${ctx.files.slice(0, 30).join(", ")}`,
    ctx.chains.length && `Chains: ${ctx.chains.join(", ")}`,
    ctx.skills.length && `Skills: ${ctx.skills.map((s) => s.name).join(", ")}`,
    ctx.flows.length && `Flows: ${ctx.flows.map((s) => s.name).join(", ")}`,
  ];
  return lines.filter(Boolean).join("\n");
}

type JsonSchema = Record<string, unknown>;

/** Allowed values per slot kind, from live context. null: free-form (typed below); []: nothing live, the action can't be planned. */
function values(kind: SlotKind, ctx: LiveContext): (string | number)[] | null {
  switch (kind) {
    case "pr": return ctx.prs.map((p) => p.number);
    case "check": return ctx.checks.map((c) => c.name);
    case "panel": return [...PANELS];
    case "workspace": return ctx.workspaces.map((w) => w.name);
    case "branch": return ctx.branches.slice(0, 30);
    case "worktree": return ctx.worktrees;
    case "file": return ctx.files.slice(0, 30);
    case "chain": return ctx.chains;
    case "skill": return ctx.skills.map((s) => s.id);
    case "flow": return ctx.flows.map((s) => s.id);
    case "route": return ctx.routes.map((r) => `${r.method} ${r.path}`);
    case "method": return ["GET", "POST", "PUT", "PATCH", "DELETE"];
    default: return null;
  }
}

const FREE: Partial<Record<SlotKind, JsonSchema>> = {
  text: { type: "string", minLength: 2, maxLength: 300 },
  name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
  path: { type: "string", pattern: "^/[^\\s]{0,200}$" },
};

/** This turn's output schema: one object per plannable action, every slot an enum of live values. */
export function plannerSchema(ctx: LiveContext): JsonSchema {
  const steps: JsonSchema[] = [];
  for (const a of PLANNER_ACTIONS) {
    const props: Record<string, JsonSchema> = { a: { const: a.id } };
    const required = ["a"];
    let ok = true;
    for (const s of a.slots ?? []) {
      const v = values(s.kind, ctx);
      if (v && !v.length) {
        if (!s.optional) ok = false;
        continue;
      }
      props[s.name] = v ? { enum: v } : FREE[s.kind]!;
      if (!s.optional) required.push(s.name);
    }
    if (ok) steps.push({ type: "object", properties: props, required, additionalProperties: false });
  }
  return { type: "object", properties: { plan: { type: "array", maxItems: 6, items: { oneOf: steps } } }, required: ["plan"], additionalProperties: false };
}

const RawPlan = z.object({ plan: z.array(z.record(z.unknown()).and(z.object({ a: z.string() }))).max(6) });

const ANCHORS = new Map<string, Set<string>>();
function anchors(a: ActionDef): Set<string> {
  let s = ANCHORS.get(a.id);
  if (s) return s;
  s = new Set<string>();
  for (const t of a.say) for (const w of t.replace(/[[\]]/g, " ").split(/[\s|]+/)) if (w && !w.startsWith("{")) s.add(w);
  for (const e of a.examples) for (const w of normalize(e).words) if (w !== "then" && known(w)) s.add(w);
  for (const w of ["show", "open", "go", "do", "all"]) if (a.id !== "panel.show" && a.id !== "pr.list") s.delete(w); // too common to tie a step to a clause
  ANCHORS.set(a.id, s);
  return s;
}

/** The words a template can't do without: "discard" in "discard [all] [changes|files]". */
const heads = (a: ActionDef): Set<string> => new Set(a.say.flatMap((t) => t.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ").split(/[\s|]+/).filter(Boolean)));

export interface Checked {
  steps: Step[];
  dropped: { step: Step; why: string }[];
}

/**
 * The rule checks after the planner (docs/16 §2.4): zod against the registry, every slot value live,
 * every step tied to something said, no more steps than clauses, garbled input gets one step at most.
 */
export function checkPlan(raw: unknown, text: string, ctx: LiveContext): Checked {
  const dropped: Checked["dropped"] = [];
  const parsed = RawPlan.safeParse(raw);
  if (!parsed.success) return { steps: [], dropped };
  const steps: Step[] = [];
  const heard = normalize(text);
  const heardWords = new Set(heard.roman.split(" "));
  const heardNums = heard.words.filter((w) => /^\d+$/.test(w)).map(Number);
  for (const r of parsed.data.plan) {
    const { a, ...rest } = r as { a: string } & Record<string, unknown>;
    const step: Step = { action: a, slots: {} };
    const def = BY_ID.get(a);
    if (!def || def.meta) {
      dropped.push({ step, why: "not an action" });
      continue;
    }
    let bad = "";
    for (const [k, v] of Object.entries(rest)) {
      const slot = def.slots?.find((s) => s.name === k);
      if (!slot) continue; // stray key: ignore
      const allowed = values(slot.kind, ctx);
      const free = FREE[slot.kind];
      if (allowed ? !allowed.includes(v as string | number) : !(typeof v === "string" && (!free?.pattern || new RegExp(free.pattern as string).test(v)) && v.trim().length >= 1)) {
        bad = `${k} not live`;
        break;
      }
      // free text must be the person's words, not an example's; a number said aloud must be the number used
      if (slot.kind === "text" && typeof v === "string") {
        const w = normalize(v).roman.split(" ").filter(Boolean);
        if (w.filter((x) => heardWords.has(x)).length < Math.ceil(w.length / 2)) {
          bad = `${k} not said`;
          break;
        }
      }
      if (typeof v === "number" && heardNums.length && !heardNums.includes(v)) {
        bad = `${k} not the number said`;
        break;
      }
      step.slots[k] = v as string | number;
    }
    for (const s of def.slots ?? []) if (!s.optional && step.slots[s.name] === undefined) bad ||= `${s.name} missing`;
    if (bad) dropped.push({ step, why: bad });
    else if (!steps.some((x) => x.action === step.action && JSON.stringify(x.slots) === JSON.stringify(step.slots))) steps.push(step);
  }
  const words = new Set(heard.words);
  // a card nobody asked for is noise: outward needs one of its words said, destructive its own verb ("Fall the latest changes" is not discard)
  for (const st of [...steps]) {
    const def = BY_ID.get(st.action)!;
    const need = def.risk === "destructive" ? heads(def) : def.risk === "outward" ? anchors(def) : null;
    if (need && ![...need].some((w) => words.has(w) && w !== "pr" && !/^\d+$/.test(w))) { // "PR 42 colo" is not a merge
      steps.splice(steps.indexOf(st), 1);
      dropped.push({ step: st, why: "its word wasn't said" });
    }
  }
  if (steps.length <= 1) return { steps, dropped };
  const tied = steps.map((s) => {
    const def = BY_ID.get(s.action)!;
    let hit = 0;
    for (const w of anchors(def)) if (words.has(w)) hit++;
    for (const v of Object.values(s.slots)) if (String(v).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((p) => p.length > 1 && heard.roman.includes(p))) hit++;
    return hit;
  });
  let kept = steps;
  if (tied.some((h) => h > 0)) {
    kept = steps.filter((s, i) => {
      if (tied[i]) return true;
      dropped.push({ step: s, why: "nothing said asks for it" });
      return false;
    });
  }
  const cap = heard.words.filter((w) => w !== "then" && known(w)).length < 2 ? 1 : clauseCount(text);
  for (const s of kept.slice(cap)) dropped.push({ step: s, why: "more steps than were said" });
  return { steps: kept.slice(0, cap), dropped };
}
