import type { AgentRunInfo, ChainDef, ChainNodeKind, ChainRun, ChainStep, UpNextItem, UpNextWhen } from "@shrike/schema";

// P: prompt chains. Pure, so main's engine (main/chains.ts) and the renderer share it and node:test covers it.

export const RUN_GATED = new Set<UpNextWhen["on"]>(["finished", "succeeded", "verified", "always"]);
export const MISSED_GRACE_MS = 60_000;

/** The run that just ended, as the gates see it. */
export interface LastRun {
  status: AgentRunInfo["status"];
  verified: boolean;
}

export interface Gate {
  now: number;
  last?: LastRun; // the newest main run that ended in this project; none yet: a succeeded or verified gate waits for one
  app: boolean; // the app is running
  ci: boolean; // the current PR's checks are all green
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The "when" chip, in plain words. */
export function whenLabel(w: UpNextWhen, now = Date.now()): string {
  switch (w.on) {
    case "finished":
      return "After this finishes";
    case "succeeded":
      return "Only if it worked";
    case "verified":
      return "Only if verified";
    case "always":
      return "Always";
    case "app":
      return "When the app runs";
    case "ci":
      return "When CI is green";
    case "time": {
      const mins = Math.round((w.at - now) / 60_000);
      return mins > 0 && mins < 60 ? `In ${mins} min` : `At ${clock(w.at)}`;
    }
  }
}

/** "18:00" from <input type="time">: its next occurrence (today, else tomorrow). */
export function atClock(hhmm: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export const inMinutes = (n: number, now = Date.now()): number => now + Math.max(1, Math.round(n)) * 60_000;

/**
 * What up next does now, while the main session is idle: fire an item, skip one whose gate the last run failed, or nothing.
 * Run-gated items go in order (only the first one is looked at); scheduled ones (time, app, CI) fire when due, wherever they sit.
 */
export function nextUp(items: readonly UpNextItem[], g: Gate): { item: UpNextItem; fire: boolean; why?: string } | null {
  let gatedSeen = false;
  for (const item of items) {
    if (item.state !== "waiting") continue;
    const w = item.when;
    if (w.on === "time") {
      if (g.now >= w.at) return { item, fire: true };
      continue;
    }
    if (w.on === "app" || w.on === "ci") {
      if (w.on === "app" ? g.app : g.ci) return { item, fire: true };
      continue;
    }
    if (gatedSeen) continue;
    gatedSeen = true;
    if (w.on === "always" || w.on === "finished") return { item, fire: true };
    if (!g.last) continue; // no run to judge yet: it waits for the next one
    if (w.on === "succeeded") return g.last.status === "done" ? { item, fire: true } : { item, fire: false, why: "the run before it didn't finish cleanly" };
    return g.last.status === "done" && g.last.verified ? { item, fire: true } : { item, fire: false, why: "the run before it wasn't verified" };
  }
  return null;
}

/** A stopped run pauses up next, unless the next item says "always". */
export function pauseOnStop(items: readonly UpNextItem[]): boolean {
  const head = items.find((i) => i.state === "waiting" && RUN_GATED.has(i.when.on));
  return !!head && head.when.on !== "always";
}

/** After a restart (or a project switch): passed times and run-gated items ask first, since the run they followed is gone; runs that were going are over. */
export function onRelaunch(items: readonly UpNextItem[], now = Date.now()): UpNextItem[] {
  return items.map((i) => {
    if (i.state === "running") return { ...i, state: "done" as const, note: "Shrike closed while it ran" };
    if (i.state === "waiting" && (RUN_GATED.has(i.when.on) || (i.when.on === "time" && i.when.at < now - MISSED_GRACE_MS))) return { ...i, state: "missed" as const };
    return i;
  });
}

const isOpen = (i: UpNextItem) => i.state === "waiting" || i.state === "missed";

/** Drag to reorder: id goes to `index` among the items still to come. Running ones stay on top, finished ones after. */
export function moveItem(items: readonly UpNextItem[], id: string, index: number): UpNextItem[] {
  const it = items.find((i) => i.id === id);
  if (!it || !isOpen(it)) return [...items];
  const open = items.filter((i) => isOpen(i) && i.id !== id);
  open.splice(Math.max(0, Math.min(index, open.length)), 0, it);
  return [...items.filter((i) => i.state === "running"), ...open, ...items.filter((i) => !isOpen(i) && i.state !== "running")];
}

/** Open items first (in order), then the newest few finished ones. */
export function tidy(items: readonly UpNextItem[], keepDone = 8): UpNextItem[] {
  const open = items.filter((i) => i.state === "waiting" || i.state === "running" || i.state === "missed");
  const done = items.filter((i) => !open.includes(i)).slice(-keepDone);
  return [...open, ...done];
}

// ---------- P3: conditional chains ----------

/** "SCORE: 6.5/10", "Score 7 out of 10", "6/10". Null when there's no score. */
export function parseScore(text: string): { score: number; reason: string } | null {
  const m = /score\s*[:=]?\s*\**\s*(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*10/i.exec(text) ?? /\b(\d+(?:\.\d+)?)\s*\/\s*10\b/.exec(text);
  if (!m) return null;
  const score = Math.max(0, Math.min(10, Number(m[1])));
  if (!Number.isFinite(score)) return null;
  const why = /(?:why|reason)\s*[:=]\s*(.+)/i.exec(text)?.[1] ?? text.slice(m.index + m[0].length).replace(/^[\s.:,-]+/, "").split("\n").find((l) => l.trim());
  return { score: Math.round(score * 10) / 10, reason: (why ?? "").trim().slice(0, 240) };
}

export type Next = { go: "critique" } | { go: ChainNodeKind; prompt: string } | { go: "stop"; why: string };

const failedRun = (def: ChainDef, s: ChainStep) => s.status !== "done" || (def.check === "verified" && !s.verified);

/** After a chain step's run ends: critique it, take a branch, or stop. A branch's own run (pass, failed) ends the chain. */
export function afterRun(def: ChainDef, s: ChainStep): Next {
  if (s.status === "stopped") return { go: "stop", why: "You stopped it." };
  if (s.node === "pass" || s.node === "failed") return { go: "stop", why: s.status !== "done" ? "The last step didn't finish." : s.node === "failed" ? "The run failed, so the recovery step ran." : "Chain complete." };
  if (failedRun(def, s)) {
    if (def.failed?.trim()) return { go: "failed", prompt: def.failed };
    return { go: "stop", why: def.check === "verified" && s.status === "done" ? "The fix wasn't verified." : "The run failed." };
  }
  if (def.check === "critique") return s.node === "below" && !def.loop ? { go: "stop", why: "Polished once. Chain complete." } : { go: "critique" };
  return def.pass?.trim() ? { go: "pass", prompt: def.pass } : { go: "stop", why: "Chain complete." };
}

/** After a critique: below the line runs prompt A (while rounds are left), at or over it runs prompt B or stops. */
export function afterScore(def: ChainDef, score: number, round: number): Next {
  if (score >= def.threshold) return def.pass?.trim() ? { go: "pass", prompt: def.pass } : { go: "stop", why: `Scored ${score} / 10. Chain complete.` };
  if (!def.below?.trim()) return { go: "stop", why: `Scored ${score} / 10, under ${def.threshold}.` };
  if (round >= def.maxRounds) return { go: "stop", why: `Stopped after ${def.maxRounds} rounds at ${score} / 10.` };
  return { go: "below", prompt: def.below };
}

/** The loop guard's budget: tokens spent or minutes gone. */
export function overBudget(c: Pick<ChainRun, "def" | "tokens" | "startedAt">, now = Date.now()): string | null {
  const b = c.def.budget;
  if (b.tokens && c.tokens >= b.tokens) return `Out of budget: ${Math.round(c.tokens / 1000)}k tokens used.`;
  if (b.minutes && now - c.startedAt >= b.minutes * 60_000) return `Out of time: ${b.minutes} min.`;
  return null;
}

/** Prompt A carries what the critique said, so the next round knows what to improve. */
export function withCritique(prompt: string, s: Pick<ChainStep, "score" | "reason"> | undefined): string {
  if (s?.score === undefined) return prompt;
  return `${prompt}\n\nA critique scored the last attempt ${s.score} / 10${s.reason ? `: ${s.reason}` : "."}`;
}

// ---------- P4: chains are skills ----------

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "chain";

export const blankChain = (prompt = ""): ChainDef => ({
  id: "",
  name: "",
  prompt,
  check: "critique",
  rubric: "It does what was asked, works, and reads cleanly.",
  threshold: 8,
  below: "Improve it using the critique below. Keep what already works.",
  loop: true,
  maxRounds: 3,
  budget: { tokens: 400_000, minutes: 30 },
});

/** "Repeat until score >= N": one click. */
export const repeatUntil = (d: ChainDef, n: number): ChainDef => ({
  ...d,
  check: "critique",
  threshold: n,
  below: d.below?.trim() || blankChain().below,
  pass: undefined,
  loop: true,
  maxRounds: Math.max(d.maxRounds, 3),
});

/** A chain's fields from a skill's body: its ```json block. Missing or wrong fields fall back to the defaults. */
export function chainFromSkill(s: { id: string; name: string; body: string }): ChainDef | null {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(s.body);
  if (!m) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).slice(0, 4000) : undefined);
  const num = (k: string, lo: number, hi: number) => (typeof v[k] === "number" && Number.isFinite(v[k]) ? Math.max(lo, Math.min(hi, v[k] as number)) : undefined);
  const b = (v.budget && typeof v.budget === "object" ? v.budget : {}) as Record<string, unknown>;
  const d = blankChain();
  const check = v.check === "succeeded" || v.check === "verified" || v.check === "critique" ? v.check : d.check;
  return {
    id: s.id,
    name: s.name,
    prompt: str("prompt") ?? "",
    check,
    rubric: str("rubric") ?? d.rubric,
    threshold: num("threshold", 0, 10) ?? d.threshold,
    ...(str("below") !== undefined ? { below: str("below") } : check === "critique" ? { below: d.below } : {}),
    ...(str("pass") ? { pass: str("pass") } : {}),
    ...(str("failed") ? { failed: str("failed") } : {}),
    loop: typeof v.loop === "boolean" ? v.loop : check === "critique",
    maxRounds: Math.round(num("maxRounds", 1, 10) ?? d.maxRounds),
    budget: {
      ...(typeof b.tokens === "number" && b.tokens > 0 ? { tokens: Math.round(b.tokens) } : {}),
      ...(typeof b.minutes === "number" && b.minutes > 0 ? { minutes: Math.round(b.minutes) } : {}),
    },
  };
}

/** The skill file a chain saves as: front matter, the steps in plain words (so the agent can read it too), and its fields. */
export function chainSkillText(d: ChainDef): string {
  const q = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());
  const steps = [
    d.prompt.trim() ? `Ask: ${d.prompt.trim()}` : "Take the run going now (or the last one).",
    d.check === "critique" ? `A critique scores it from 0 to 10 against: ${d.rubric.trim()}` : d.check === "verified" ? "Check the fix was verified." : "Check the run worked.",
    ...(d.check === "critique" && d.below?.trim() ? [`Under ${d.threshold}: ${d.below.trim()}${d.loop ? ` Then score again (up to ${d.maxRounds} rounds).` : ""}`] : []),
    d.pass?.trim() ? `${d.check === "critique" ? `${d.threshold} or more` : "It worked"}: ${d.pass.trim()}` : "Then stop.",
    ...(d.failed?.trim() ? [`If it failed: ${d.failed.trim()}`] : []),
  ];
  const { id: _id, name: _name, ...fields } = d;
  const when = d.check === "critique" ? `You want it scored and improved until it reaches ${d.threshold}/10` : "You want the next step to run only when this one worked";
  return `---\nname: ${q(d.name || "Prompt chain")}\nwhen: ${q(when)}\nkind: chain\nversion: 1\n---\n\n# ${d.name || "Prompt chain"}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\`\n`;
}

// ---------- the renderer's view ----------

export const isOpenItem = (i: UpNextItem): boolean => i.state === "waiting" || i.state === "running" || i.state === "missed";

/** The "when" menu, in order. Time is its own row (a clock field). */
export const WHEN_CHOICES: UpNextWhen[] = [{ on: "finished" }, { on: "succeeded" }, { on: "verified" }, { on: "always" }, { on: "app" }, { on: "ci" }];

export type Branch = "below" | "pass" | "failed";

/** What the mini-Thread lights: the node working now, the branch taken last, the newest score. */
export function chainView(c: ChainRun | null): { active: ChainNodeKind | "critique" | null; lit: Branch | null; score?: number; reason?: string } {
  if (!c) return { active: null, lit: null };
  const last = c.steps.at(-1);
  const scored = c.steps.findLast((s) => s.score !== undefined);
  const took = c.steps.findLast((s) => s.took)?.took;
  const branch = (n?: ChainNodeKind | "stop"): Branch | null => (n === "below" || n === "pass" || n === "failed" ? n : null);
  const lit: Branch | null =
    took !== "stop"
      ? branch(took)
      : ((last?.score === undefined ? branch(last?.node) : null) ?? (scored?.score !== undefined && scored.score >= c.def.threshold ? "pass" : last?.status === "done" && c.def.check !== "critique" ? "pass" : null)); // a branch's own run ended it: that branch stays lit

  const active = c.state === "critiquing" ? "critique" : c.state === "running" && last && !last.status ? last.node : null;
  return { active, lit, ...(scored ? { score: scored.score, reason: scored.reason ?? "" } : {}) };
}

/** "/chain polish-until-8 build the about page": the chain by id (with or without `chain-`) or name start, and the rest as its prompt. */
export function pickChain(defs: readonly ChainDef[], text: string): { def: ChainDef; prompt: string } | null {
  const [word = "", ...rest] = text.trim().split(/\s+/);
  const w = slug(word);
  if (!word) return null;
  const def = defs.find((d) => d.id === w || d.id === `chain-${w}`) ?? defs.find((d) => slug(d.name).startsWith(w) || d.id.replace(/^chain-/, "").startsWith(w));
  return def ? { def, prompt: rest.join(" ") } : null;
}

/** Why a missed item is asking, in plain words. */
export const missedWhy = (i: UpNextItem, now = Date.now()): string => (i.when.on === "time" ? `It was due at ${whenLabel(i.when, now).replace(/^(At|In) /, "")}.` : "Shrike closed before it ran.");

export const TOAST_MS: Record<string, number> = { saved: 2600, queued: 1600, next: 2000, skipped: 2400, paused: 2400, critique: 2600, complete: 3000, stopped: 2600, missed: 3200 };

/** One toast at a time: a repeat of the one waiting is dropped, and past `max` the oldest plain "queued" goes first. */
export function enqueueToast<T extends { kind: string; text: string }>(queue: readonly T[], e: T, max = 4): T[] {
  if (queue.some((q) => q.kind === e.kind && q.text === e.text)) return [...queue];
  const q = [...queue, e];
  while (q.length > max) q.splice(Math.max(0, q.findIndex((x) => x.kind === "queued")), 1);
  return q;
}
