import type { ActionView, DebugEvent, FileNode, Place } from "@shrike/schema";
import { firstFailure, type Station, type Trip } from "../lib/thread-layout.ts";
import { statusWords, toSteps } from "../lib/steps.ts";
import { blockEnd, codeTarget, stationEvents } from "../thread/logic.ts";

// The Files view (FV): the Thread's trip re-drawn on the real folder tree. Pure: which file and lines each station
// lit, the cards in story order, the threads between them, and what the tree shows at any step, both ways.
// Spec: docs/06-design.md "Files view". Tested in logic.test.ts.

export interface Loc {
  file: string;
  line: number;
}
export interface Fact {
  k: string;
  v: string;
  err?: boolean;
}
export interface Frame {
  id: string;
  label: string;
  at?: string; // "todos.controller.ts:18"
  station: number; // -1: not a station of this trip
}
export interface FStep {
  i: number; // the station index, shared with the Thread
  label: string;
  caption: string;
  kind: Station["kind"];
  err: boolean; // red: where it broke (the snap, the call that got the bad value, the Thread's landing step), never a step the failure only passed through
  snap: boolean;
  ms: number;
  lane: string; // PAGE, SERVER, API
  file?: string; // the card this step lights
  line?: number; // its live line
  def?: number; // where the function around the live line starts, when the event says
  enter?: Loc; // a call: the function it entered (its own card gets a band there)
  place?: Place; // a database, cache or outside service: a place card, not a file
  weak?: "Used here" | "Roughly here";
  secret?: boolean; // .env and friends: never show the code
  chip?: string;
  chipError?: boolean;
  facts: Fact[];
  stack: Frame[]; // outermost first, this step last
  gone: Frame[]; // frames the previous step had that have returned
}

const base = (f: string) => f.split("/").pop() ?? f;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const msText = (ms: number) => (ms < 1 && ms > 0 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`);
const args = (e: DebugEvent) => (e.args ?? []).filter((a) => a !== "res" && !a.startsWith("[Function"));
const pathOf = (url = "") => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
export const SECRET = /(^|\/)\.env(\.|$)|\.(pem|key)$/;
export const placeKey = (p: Place) => `place:${p.id}`;

export function laneName(p: Place): string {
  if (p.kind === "client" || p.kind === "caller") return "PAGE";
  return p.name.split(" · ")[0]!.toUpperCase();
}

function factsOf(e: DebugEvent, st: Station): Fact[] {
  const out: Fact[] = [];
  const add = (k: string, v: string | undefined, err?: boolean) => v && out.push({ k, v: clip(v, 160), ...(err ? { err } : {}) });
  const code = e.http?.status;
  switch (e.kind) {
    case "function":
      add("CALL", st.label);
      add("ARGS", args(e).join(", "), st.chipError);
      add("RETURNED", e.returned);
      add("ERROR", e.error?.message, true);
      if (e.callSite) add("CALLED AT", `${base(e.callSite.file)}:${e.callSite.line}`);
      break;
    case "http_request":
    case "external_call":
      add("REQUEST", `${e.http?.method ?? ""} ${pathOf(e.http?.url) || e.name}`.trim());
      add("SENT", e.http?.reqBody);
      add("REPLIED", code ? statusWords(code) : undefined, (code ?? 0) >= 400);
      break;
    case "db_query":
      add("QUERY", e.db?.statement ?? e.name);
      add("VALUES", e.db?.params);
      add("ERROR", e.error?.message, true);
      break;
    case "cache_op":
      add("CACHE", `${e.cache?.op ?? "op"} ${e.cache?.key ?? ""}`.trim());
      add("RESULT", e.cache?.hit === true ? "hit" : e.cache?.hit === false ? "miss" : undefined);
      break;
    case "log":
      add("LOG", e.log?.message ?? e.name, e.log?.level === "error");
      add("LEVEL", e.log?.level);
      break;
    case "user_action":
      add("EVENT", e.name);
      if (e.source) add("ELEMENT", `${base(e.source.file)}:${e.source.line}`);
      break;
    case "error":
      add("ERROR", e.error?.message ?? e.name, true);
      add("TYPE", e.error?.type);
      break;
  }
  if ((st.count ?? 1) > 1) add("REPEATED", `${st.count} times`);
  add("TIME", msText(st.ms));
  return out;
}

const FRAME_KINDS = new Set<DebugEvent["kind"]>(["user_action", "http_request", "function", "external_call", "db_query", "cache_op"]);

function frameOf(e: DebugEvent, trip: Trip): Frame {
  const at = e.callSite ?? e.source;
  const label = e.kind === "function" ? e.name.replace(/\(\)$/, "") : e.kind === "user_action" ? "click" : e.kind === "db_query" ? (e.db?.system ?? "database").toUpperCase() : e.http ? `${e.http.method} ${pathOf(e.http.url)}` : e.name;
  return { id: e.id, label: clip(label, 40), at: at ? `${base(at.file)}:${at.line}` : undefined, station: trip.stations.findIndex((s) => s.eventIds.includes(e.id)) };
}

/** Every station of the trip as a step on the folder tree: the file and line it lit, its facts, its call stack. */
export function fileSteps(view: ActionView, trip: Trip): FStep[] {
  const steps = toSteps(view);
  const out: FStep[] = [];
  const landing = trip.status === "error" ? firstFailure(trip) : -1;
  trip.stations.forEach((st, i) => {
    const { event, parent } = stationEvents(view, st.stepIndex);
    const e = event ?? view.root;
    const s: FStep = { i, label: st.label, caption: st.caption, kind: st.kind, err: st.status === "error" && (!!st.snap || !!st.chipError || st.kind === "error" || i === landing), snap: !!st.snap, ms: st.ms, lane: laneName(st.place), chip: st.chip, chipError: st.chipError, facts: st.kind === "express" ? [{ k: "STEPS", v: `${st.count ?? 0} routine steps` }] : factsOf(e, st), stack: [], gone: [] };
    const isPlace = st.opaque || ["data", "cache", "outside"].includes(st.place.kind);
    if (isPlace) s.place = st.place;
    if (st.kind !== "express") {
      const t = codeTarget(e, parent);
      if (t) Object.assign(s, { file: t.file, line: e.kind === "function" && !e.callSite && t.def ? t.def : t.live, ...(t.def ? { def: t.def } : {}) }); // a function lights where it starts; the call inside it that failed is its own step
      if (e.kind === "function" && e.callSite && e.source && e.source.file !== e.callSite.file) s.enter = { file: e.source.file, line: e.source.line };
      if (e.kind === "user_action" && s.file) s.weak = "Used here";
      else if (e.source?.precision === "approximate") s.weak = "Roughly here";
      if (s.file && SECRET.test(s.file)) s.secret = true;
    }
    // the call stack: the frames this step sits inside, outermost first
    const k = st.stepIndex;
    const chain: DebugEvent[] = [e];
    for (let j = k - 1, d = steps[k]?.depth ?? 0; j >= 0; j--) if (steps[j]!.depth < d) (d = steps[j]!.depth, chain.unshift(steps[j]!.event));
    s.stack = chain.filter((x) => FRAME_KINDS.has(x.kind) || x === e).map((x) => frameOf(x, trip));
    const prev = out[i - 1];
    if (prev) s.gone = prev.stack.filter((f) => !s.stack.some((g) => g.id === f.id) && f.id !== prev.stack.at(-1)?.id);
    out.push(s);
  });
  return out;
}

/** Where a step's focus is: its place card, else its file card, else wherever the story already was. */
export function focusKey(steps: readonly FStep[], k: number): string | undefined {
  for (let j = Math.min(k, steps.length - 1); j >= 0; j--) {
    const s = steps[j]!;
    if (s.place) return placeKey(s.place);
    if (s.file) return s.file;
  }
  return undefined;
}

export interface Card {
  key: string; // a repo-relative path, or placeKey()
  first: number; // the first step that reaches it
  lane: string;
  place?: Place;
}

/** Cards in the order the trip first reached them (x = story order); a return reuses its card. Places go to the shelf. */
export function cardsOf(steps: readonly FStep[]): { files: Card[]; places: Card[] } {
  const files: Card[] = [];
  const places: Card[] = [];
  const add = (list: Card[], c: Card) => list.some((x) => x.key === c.key) || list.push(c);
  for (const s of steps) {
    if (s.file) add(files, { key: s.file, first: s.i, lane: s.lane });
    if (s.enter) add(files, { key: s.enter.file, first: s.i, lane: s.lane });
    if (s.place) add(places, { key: placeKey(s.place), first: s.i, lane: s.lane, place: s.place });
  }
  return { files, places };
}

export interface Strip {
  x: Record<string, number>; // world x of each card's left edge
  gates: { x: number; label: string; first: number }[];
  placeY: Record<string, number>; // shelf row of each place card
  end: number;
}

/** The FILES plane left to right: cards, a lane gate where the story crosses lanes, the gate to the shelf, the shelf. */
export function layoutStrip(c: { files: Card[]; places: Card[] }, o: { start: number; cw: number; gap: number; gate: number; pw: number }): Strip {
  const x: Record<string, number> = {};
  const gates: Strip["gates"] = [];
  let at = o.start;
  c.files.forEach((card, i) => {
    const prev = c.files[i - 1];
    if (prev && prev.lane !== card.lane) {
      gates.push({ x: at - o.gap + o.gate / 2, label: card.lane, first: card.first });
      at += o.gate - o.gap;
    }
    x[card.key] = at;
    at += o.cw + o.gap;
  });
  const placeY: Record<string, number> = {};
  if (c.places.length) {
    gates.push({ x: at - o.gap + o.gate / 2, label: "OUTSIDE YOUR PROJECT", first: Math.min(...c.places.map((p) => p.first)) });
    at += o.gate - o.gap;
    c.places.forEach((p, i) => ((x[p.key] = at), (placeY[p.key] = i)));
    at += o.pw;
  } else at -= o.gap;
  return { x, gates, placeY, end: at };
}

export interface End {
  key: string;
  line?: number;
}
export interface Link {
  j: number; // drawn from this step on
  from: End;
  to: End;
  ret: boolean; // runs back left, under the strip
  err: boolean;
}

/** The threads between cards: from the line the story left to the line it reached. */
export function links(steps: readonly FStep[], order: readonly string[]): Link[] {
  const out: Link[] = [];
  const idx = (k: string) => order.indexOf(k);
  const add = (j: number, from: End, to: End) => from.key !== to.key && out.push({ j, from, to, ret: idx(to.key) < idx(from.key), err: steps[j]!.err });
  let here: End | undefined;
  for (const s of steps) {
    const at: End | undefined = s.file ? { key: s.file, line: s.line } : s.place ? { key: placeKey(s.place) } : undefined;
    if (here && at) add(s.i, here, at);
    if (s.enter && at) add(s.i, at, { key: s.enter.file, line: s.enter.line });
    if (s.place && s.file) add(s.i, at!, { key: placeKey(s.place) });
    here = s.place ? { key: placeKey(s.place) } : s.enter ? { key: s.enter.file, line: s.enter.line } : (at ?? here);
  }
  return out;
}

export const dirsOf = (file: string): string[] => file.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));

/** What the tree and cards show at step k. A function of k alone, so stepping back is stepping forward undone. */
export function stateAt(steps: readonly FStep[], k: number): { focus?: string; hot?: string; ran: Set<string>; failed: Set<string>; open: Set<string> } {
  const ran = new Set<string>();
  const failed = new Set<string>();
  for (const s of steps.slice(0, k + 1)) {
    if (s.file) ran.add(s.file);
    if (s.enter) ran.add(s.enter.file);
    if (s.err && s.file && (s.kind === "function" || s.kind === "error" || s.snap)) failed.add(s.file);
  }
  const open = new Set<string>([""]);
  for (const f of ran) for (const d of dirsOf(f)) open.add(d);
  return { focus: focusKey(steps, k), hot: steps[k]?.file, ran, failed, open };
}

/** A move between two steps: its direction and how far the camera pans (spec §4: clamp(hop × √slots, 360, 1100)). */
export function moveOf(steps: readonly FStep[], order: readonly string[], from: number, to: number, hop = 520): { dir: 1 | -1; slots: number; pan: number } {
  const a = focusKey(steps, from);
  const b = focusKey(steps, to);
  const slots = a && b && a !== b ? Math.max(1, Math.abs(order.indexOf(b) - order.indexOf(a))) : 0;
  return { dir: to >= from ? 1 : -1, slots, pan: slots ? Math.min(1100, Math.max(360, Math.round(hop * Math.sqrt(slots)))) : 0 };
}

const FN = /\bfunction\b|=>\s*\{\s*$|^\s*(?:export\s+)?(?:async\s+)?[\w$]+\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;

/** The lines of the function around the live line, for the lit band. ponytail: brace counting, not a parser; the upgrade path is a Babel scan in main (spec §9). */
export function section(lines: readonly string[], live: number, def?: number): { start: number; end: number; weak: boolean } {
  const n = Math.max(1, lines.length);
  const l = Math.min(Math.max(1, live), n);
  if (def) {
    const end = blockEnd(lines as string[], def, 200);
    if (l >= def && l <= end) return { start: def, end, weak: false };
  }
  for (let s = l; s >= Math.max(1, l - 120); s--) {
    if (!FN.test(lines[s - 1] ?? "")) continue;
    const end = blockEnd(lines as string[], s, 240);
    if (end >= l) return { start: s, end, weak: false };
  }
  return { start: Math.max(1, l - 3), end: Math.min(n, l + 3), weak: true };
}

export interface Row {
  node: FileNode;
  depth: number;
  anc: string[]; // ancestor folder paths, root ("") first
}

/** The sliced tree as rows, root first. */
export function flatRows(nodes: readonly FileNode[], rootName: string): Row[] {
  const rows: Row[] = [{ node: { name: rootName, path: "", dir: true, children: [...nodes] }, depth: 0, anc: [] }];
  const walk = (list: readonly FileNode[], depth: number, anc: string[]) => {
    for (const n of list) {
      rows.push({ node: n, depth, anc });
      if (n.children) walk(n.children, depth + 1, [...anc, n.path]);
    }
  };
  walk(nodes, 1, [""]);
  return rows;
}

/** Row positions for an open set: a hidden row rides at its nearest shown ancestor, so it slides out of the folder it closes into. */
export function treeLayout(rows: readonly Row[], open: ReadonlySet<string>, rowH: number): { y: number[]; shown: boolean[]; height: number } {
  const y: number[] = [];
  const shown: boolean[] = [];
  const at = new Map<string, number>();
  let h = 0;
  for (const r of rows) {
    const vis = r.anc.every((a) => open.has(a));
    shown.push(vis);
    if (vis) {
      y.push(h);
      if (r.node.dir) at.set(r.node.path, h);
      h += rowH;
    } else y.push([...r.anc].reverse().map((a) => at.get(a)).find((v) => v !== undefined) ?? 0);
  }
  return { y, shown, height: h };
}
