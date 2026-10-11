import type { VoiceChip } from "@shrike/schema";
import { ACTIONS, BY_ID, type ActionDef, type LiveContext, type Slot } from "../../actions/registry.ts";
import { known, normalize } from "./normalize.ts";
import { decide, nameScore, snapAll, type Snap } from "./snap.ts";
import { rankFiles } from "../grammar.ts";

// Tier 1 (docs/16 §2.4): canonical words to a plan with no model, under a millisecond.
// Clause splitter, order-free templates from the registry, slots snapped to live lists.
// Every clause must parse or the grammar abstains (the planner gets it). Tested in understand.test.ts.

export type SlotValue = string | number;
export interface Step {
  action: string;
  slots: Record<string, SlotValue>;
}
export type Parsed =
  | { kind: "plan"; steps: Step[] }
  | { kind: "close"; options: Step[][] } // two live values too close to call: "Did you mean" chips
  | { kind: "none"; clauses: number; known: number };

type Group = { alts: string[]; opt: boolean; slot?: undefined } | { slot: Slot; opt: boolean; alts?: undefined };
interface Template {
  def: ActionDef;
  groups: Group[];
  vocab: Set<string>; // every literal word it knows: a second one left over is a repeat, not another command
}

const TEMPLATES: Template[] = ACTIONS.flatMap((def) =>
  def.say.map((t) => ({
    def,
    groups: t.split(" ").map((g): Group => {
      const opt = g.startsWith("[") && g.endsWith("]");
      const body = opt ? g.slice(1, -1) : g;
      const m = /^\{(\w+)\}$/.exec(body);
      if (m) {
        const slot = def.slots?.find((x) => x.name === m[1]);
        if (!slot) throw new Error(`${def.id}: template slot {${m[1]}} has no slot`);
        return { slot, opt };
      }
      return { alts: body.split("|"), opt };
    }),
    vocab: new Set(t.replace(/[[\]]/g, "").split(/[\s|]+/).filter((w) => !w.startsWith("{"))),
  })),
);

const SOFT = new Set(["go", "do", "all"]);
const PANEL_WORD: Record<string, string> = {
  logs: "logs", network: "network", request: "network", api: "api", routes: "api", terminal: "terminal", details: "details", app: "app", skills: "skills", skill: "skills",
  flows: "flows", flow: "flows", tools: "tools", ship: "ship", time: "time", changes: "changes", checks: "checks", workspace: "workspaces",
};
const METHODS = new Set(["get", "post", "put", "delete", "patch"]);
const CHECK_WORDS = new Set(["check", "checks", "ci"]);
const FILE_NOISE = new Set(["file", "files", "code", "open", "show", "edit", "go"]);

interface Fill {
  value: SlotValue;
  idx: number[];
  score: number;
  close?: SlotValue[];
}

interface Clause {
  words: string[];
  src: string[];
}

const free = (used: boolean[]): number[] => used.flatMap((u, i) => (u ? [] : [i]));

/** Snap the free words to a live list. */
function snapSlot<T>(c: Clause, used: boolean[], items: readonly T[], label: (t: T) => string[], value: (t: T) => SlotValue): Fill | null {
  const idx = free(used);
  const words = idx.map((i) => c.src[i] || c.words[i]!);
  const d = decide(snapAll(words, items, label));
  if (!d) return null;
  const pick = (s: Snap<T>, at: number): number[] => idx.slice(at, at + s.span);
  const at = (s: Snap<T>): number => {
    for (let i = 0; i < words.length; i++) if (nameScore(words.slice(i, i + s.span).join(" "), label(s.value)[0] ?? "") >= s.score - 1e-9) return i;
    for (let i = 0; i < words.length; i++) if (label(s.value).some((l) => nameScore(words.slice(i, i + s.span).join(" "), l) >= s.score - 1e-9)) return i;
    return 0;
  };
  if ("close" in d) return { value: value(d.close[0]!.value), idx: pick(d.close[0]!, at(d.close[0]!)), score: d.close[0]!.score, close: d.close.map((x) => value(x.value)) };
  return { value: value(d.value), idx: pick(d.snap, at(d.snap)), score: d.snap.score };
}

function fillSlot(slot: Slot, c: Clause, used: boolean[], ctx: LiveContext): Fill | null {
  const idx = free(used);
  switch (slot.kind) {
    case "pr": {
      const i = idx.find((j) => /^\d+$/.test(c.words[j]!));
      if (i === undefined) return null;
      const n = Number(c.words[i]);
      if (ctx.prs.length && !ctx.prs.some((p) => p.number === n)) return null; // not a live PR
      return { value: n, idx: [i], score: 1 };
    }
    case "panel": {
      const i = idx.find((j) => PANEL_WORD[c.words[j]!]);
      return i === undefined ? null : { value: PANEL_WORD[c.words[i]!]!, idx: [i], score: 1 };
    }
    case "check": {
      const cw = idx.filter((j) => CHECK_WORDS.has(c.words[j]!));
      const st = idx.find((j) => c.words[j] === "failing" || c.words[j] === "pending");
      if (st !== undefined) {
        const want = c.words[st] === "failing" ? "fail" : "pending";
        const hits = ctx.checks.filter((k) => k.state === want);
        const use = [st, ...cw];
        if (!ctx.checks.length) return { value: c.words[st]!, idx: use, score: 1 };
        if (!hits.length) return null;
        return hits.length === 1 ? { value: hits[0]!.name, idx: use, score: 1 } : { value: hits[0]!.name, idx: use, score: 1, close: hits.map((h) => h.name) };
      }
      if (!cw.length) return null; // a check by name needs the word "check" / "ci"
      const rest = used.slice();
      for (const j of cw) rest[j] = true;
      const f = snapSlot(c, rest, ctx.checks, (k) => [k.name], (k) => k.name);
      return f ? { ...f, idx: [...f.idx, ...cw] } : null;
    }
    case "workspace":
      return snapSlot(c, used, ctx.workspaces, (w) => [w.name, ...(w.label ? [w.label] : [])], (w) => w.name);
    case "branch":
      return snapSlot(c, used, ctx.branches, (b) => [b], (b) => b);
    case "worktree":
      return snapSlot(c, used, ctx.worktrees, (b) => [b], (b) => b);
    case "chain":
      return snapSlot(c, used, ctx.chains, (b) => [b], (b) => b);
    case "skill":
      return snapSlot(c, used, ctx.skills, (k) => [k.name, k.id], (k) => k.id);
    case "flow":
      return snapSlot(c, used, ctx.flows, (k) => [k.name], (k) => k.id);
    case "route":
      return snapSlot(c, used, ctx.routes, (r) => [r.path, r.path.split("/").filter(Boolean).pop() ?? r.path], (r) => `${r.method} ${r.path}`);
    case "method": {
      const i = idx.find((j) => METHODS.has(c.words[j]!));
      return i === undefined ? null : { value: c.words[i]!.toUpperCase(), idx: [i], score: 1 };
    }
    case "path": {
      const i = idx.find((j) => (c.src[j] ?? "").startsWith("/"));
      return i === undefined ? null : { value: c.src[i]!, idx: [i], score: 1 };
    }
    case "name": {
      const k = idx.find((j) => c.words[j] === "called");
      const i = k !== undefined ? idx.find((j) => j > k) : idx.find((j) => !known(c.words[j]!));
      if (i === undefined) return null;
      return { value: (c.src[i] || c.words[i]!).replace(/[^\p{L}\p{N}_-]+/gu, ""), idx: k !== undefined ? [k, i] : [i], score: 1 };
    }
    case "file": {
      const inNames = (w = "") => w.length >= 3 && ctx.files.some((f) => f.toLowerCase().includes(w.toLowerCase())); // "list" in TodoList is a name, not "show"
      const words = idx.filter((j) => !FILE_NOISE.has(c.words[j]!) || inNames(c.src[j]));
      if (!words.length) return null;
      const q = words.map((j) => c.src[j] || c.words[j]!).join(" ");
      const [top, next] = rankFiles(q, ctx.files);
      if (!top) return null;
      const path = top.path;
      const explicit = idx.some((j) => c.words[j] === "file" || c.words[j] === "files") || /\.\w{1,5}\b/.test(q);
      const parts = path.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const strong = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !["ts", "tsx", "js", "dot", "the"].includes(w)).every((w) => parts.some((p) => p.startsWith(w) || w.startsWith(p) || nameScore(w, p) >= 0.9));
      if (!explicit && !strong) return null;
      return { value: path, idx, score: explicit ? 1 : 0.8, ...(next && top.score - next.score < 2 ? { close: [path, next.path] } : {}) }; // a tie: "did you mean" chips
    }
    case "text":
      return null;
  }
}

interface Cand {
  step: Step;
  score: number;
  close?: { slot: string; values: SlotValue[] };
}

function matchTemplate(t: Template, c: Clause, ctx: LiveContext): Cand | null {
  const used = new Array<boolean>(c.words.length).fill(false);
  let score = 0;
  let required = 0;
  for (const g of t.groups) {
    if (!g.alts) continue;
    if (!g.opt) required++;
    const i = c.words.findIndex((w, j) => !used[j] && g.alts.includes(w));
    if (i >= 0) {
      used[i] = true;
      score += 1;
    } else if (!g.opt) return null;
  }
  const slots: Record<string, SlotValue> = {};
  let close: Cand["close"];
  for (const g of t.groups) {
    if (!g.slot) continue;
    if (!g.opt) required++;
    const f = fillSlot(g.slot, c, used, ctx);
    if (!f) {
      if (g.opt) continue;
      return null;
    }
    for (const i of f.idx) used[i] = true;
    slots[g.slot.name] = f.value;
    score += f.idx.length * f.score * 0.99; // a literal word beats a slot on a tie ("stop app" is app.stop, not hide app)
    if (f.close) close = { slot: g.slot.name, values: f.close };
  }
  let soft = 0;
  let unknown = 0;
  for (let i = 0; i < c.words.length; i++) {
    if (used[i]) continue;
    const w = c.words[i]!;
    if (SOFT.has(w) || t.vocab.has(w)) soft++;
    else if (known(w)) return null; // a command word this template doesn't explain
    else unknown++;
  }
  if (unknown > (score >= 2 ? 1 : 0)) return null;
  const penalty = unknown * 0.75 + soft * 0.25 + (t.def.id === "file.open" ? 0.5 : 0);
  return { step: { action: t.def.id, slots }, score: score - penalty + required * 0.001, ...(close ? { close } : {}) };
}

function matchClause(c: Clause, ctx: LiveContext): Cand | null {
  let best: Cand | null = null;
  for (const t of TEMPLATES) {
    const m = matchTemplate(t, c, ctx);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}

const ASK_EDGE = new Set(["ask", "tell", "have", "claude", "agent", "se", "ko", "to", "the", "ki", "kya", "a", "à", "al", "look", "into", "pucho", "poocho", "puchho", "poochho", "frag", "pregunta", "demande", "and", "ke", "please"]);

/** "ask Claude why X", "X Claude se pucho", "why does X": the words for the agent, or null. */
export function agentText(text: string): string | null {
  const n = normalize(text);
  const w = n.words;
  const asks = (w.includes("claude") || w.includes("agent")) && w.includes("ask");
  const question = w[0] === "why" || w[0] === "how";
  if (!asks && !question) return null;
  if (question && !asks) return n.roman.split(" ").length >= 3 ? n.roman : null;
  const r = n.roman.split(" ");
  const canon = r.map((x) => normalize(x).words[0] ?? "");
  let a = 0;
  let b = r.length;
  while (a < b && (ASK_EDGE.has(r[a]!) || ["claude", "agent", "ask"].includes(canon[a]!))) a++;
  while (b > a && (ASK_EDGE.has(r[b - 1]!) || ["claude", "agent", "ask"].includes(canon[b - 1]!))) b--;
  const out = r.slice(a, b).join(" ").trim();
  return out.split(" ").length >= 2 ? out : null;
}

// "Yes, ship it" as the recognizer runs it together ("Yeshipper", "yesship it"): the whole utterance snapped to a go-ahead.
const GO_AHEAD = ["yes ship it", "yeah ship it", "yes please", "go ahead", "yes do it"];
const GO_WORDS = new Set(["yes", "create", "pr", "ship"]);

/** A go-ahead: words that only say yes ("ship it", "Yeshipper"). No other command word, so "yes stop it" never is one. */
export function goAhead(text: string): boolean {
  const n = normalize(text);
  return n.words.length > 0 && n.words.every((w) => GO_WORDS.has(w) || !known(w)) && GO_AHEAD.some((p) => nameScore(n.roman, p) >= 0.87);
}

const QUEUE = /^(?:up next|queue|after (?:it finishes|it's done|it is done|this))[,:]?\s+(.{3,})$/i;
const OPTIONS = /^(?:show|give)(?: me)?(?: some)? options(?:\s+(?:for|on|about))?[,:]?\s*(.*)$/i;
const LONE = new Set(["show", "open", "go", "do"]);

export function splitClauses(words: string[], src: string[]): Clause[] {
  const out: Clause[] = [{ words: [], src: [] }];
  words.forEach((w, i) => {
    if (w === "then") out.push({ words: [], src: [] });
    else (out.at(-1)!.words.push(w), out.at(-1)!.src.push(src[i] ?? ""));
  });
  return out.filter((c) => c.words.length);
}

/** Tier 0 + tier 1. */
export function parse(text: string, ctx: LiveContext): Parsed {
  const raw = text.trim().replace(/[.!?]+$/, "");
  const q = QUEUE.exec(raw);
  if (q) return { kind: "plan", steps: [{ action: "chain.queue", slots: { text: q[1]!.trim() } }] };
  const o = OPTIONS.exec(raw);
  if (o) return { kind: "plan", steps: [{ action: "agent.options", slots: o[1]!.trim() ? { text: o[1]!.trim() } : {} }] };
  const ask = agentText(raw);
  if (ask) return { kind: "plan", steps: [{ action: "agent.ask", slots: { text: ask } }] };
  const n = normalize(raw);
  const clauses = splitClauses(n.words, n.src).filter((c, i) => i === 0 || !c.words.every((w) => LONE.has(w)));
  const knownCount = n.words.filter(known).length;
  if (!clauses.length) return { kind: "none", clauses: 0, known: 0 };
  const cands: Cand[] = [];
  for (const c of clauses) {
    const m = matchClause(c, ctx);
    if (!m) return goAhead(raw) ? { kind: "plan", steps: [{ action: "confirm.yes", slots: {} }] } : { kind: "none", clauses: clauses.length, known: knownCount };
    cands.push(m);
  }
  const steps = cands.map((c) => c.step);
  const amb = cands.findIndex((c) => c.close);
  if (amb >= 0) {
    const cl = cands[amb]!.close!;
    return { kind: "close", options: cl.values.map((v) => steps.map((s, i) => (i === amb ? { ...s, slots: { ...s.slots, [cl.slot]: v } } : s))) };
  }
  return { kind: "plan", steps };
}

/** How many clauses the words hold: the planner may not return more steps than this. */
export function clauseCount(text: string): number {
  const n = normalize(text);
  return Math.max(1, splitClauses(n.words, n.src).filter((c, i) => i === 0 || !c.words.every((w) => LONE.has(w))).length);
}

/** Card copy for a step: the title with its slots filled ("Open PR 42"). */
export function stepTitle(s: Step): string {
  const def = BY_ID.get(s.action);
  const t = def?.title ?? s.action;
  return t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = s.slots[k];
    if (v === undefined) return "";
    if (k === "path" && typeof v === "string" && def?.slots?.find((x) => x.name === k)?.kind === "file") return v.split("/").pop() ?? v;
    return String(v);
  }).replace(/\s+/g, " ").trim();
}

/** The three commands nearest to what was heard, for "Didn't catch that". */
export function nearest(text: string, n = 3): VoiceChip[] {
  const w = new Set(normalize(text).words.filter((x) => x !== "then"));
  if (!w.size) return [];
  const scored = ACTIONS.filter((a) => !a.meta && !a.slots?.some((s) => !s.optional))
    .map((a) => {
      const vocab = new Set(a.say.join(" ").replace(/[[\]{}]/g, " ").split(/[\s|]+/).filter(Boolean));
      let hit = 0;
      for (const x of w) if (vocab.has(x)) hit++;
      return { a, hit };
    })
    .filter((x) => x.hit > 0)
    .sort((x, y) => y.hit - x.hit);
  return scored.slice(0, n).map(({ a }) => ({ label: a.title, action: a.id, say: a.examples[0] }));
}
