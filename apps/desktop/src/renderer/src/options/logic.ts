import type { OptionCard, OptionInput, OptionsAnswer, OptionsRound, OptionsSession } from "@shrike/schema";

// M: the option tree, shared by main/options.ts and the cards. Pure, tested in logic.test.ts.

export const MAX_OPTIONS = 4;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Card names for a new round: letters for fresh options, B1 B2 under B (B2.1 under B2), "B2+C" for a merge. */
export function cardNames(taken: Iterable<string>, kind: OptionsRound["kind"], from: string[], count: number): string[] {
  const used = new Set(taken);
  const out: string[] = [];
  const free = (name: string) => !used.has(name) && !out.includes(name);
  if ((kind === "vary" || kind === "tweak") && from[0]) {
    const sep = /\d$/.test(from[0]) ? "." : "";
    for (let i = 1; out.length < count; i++) if (free(`${from[0]}${sep}${i}`)) out.push(`${from[0]}${sep}${i}`);
  } else if (kind === "combine" && from.length) {
    const base = from.join("+");
    if (count === 1 && free(base)) out.push(base);
    for (let i = 2; out.length < count; i++) if (free(`${base}.${i}`)) out.push(`${base}.${i}`);
  } else {
    for (const l of LETTERS) if (out.length < count && free(l)) out.push(l);
    for (let i = 1; out.length < count; i++) if (free(`Z${i}`)) out.push(`Z${i}`);
  }
  return out;
}

/** What the next options answer: the user's last ask decides where they hang in the tree. */
export function roundFor(last: OptionsAnswer | undefined): Pick<OptionsRound, "kind" | "from" | "note"> {
  switch (last?.action) {
    case "vary": return { kind: "vary", from: [last.card] };
    case "tweak": return { kind: "tweak", from: [last.card], note: last.text };
    case "combine": return { kind: "combine", from: last.cards, ...(last.text ? { note: last.text } : {}) };
    case "other": return { kind: "more", from: [], note: last.text };
    default: return { kind: "more", from: [] };
  }
}

export function roundTitle(kind: OptionsRound["kind"], from: string[], n: number): string {
  if (kind === "vary") return `More like ${from[0]}`;
  if (kind === "tweak") return `${from[0]}, changed`;
  if (kind === "combine") return from.join(" + ");
  return `Round ${n}`;
}

/** The session with one more round of cards. */
export function addRound(s: OptionsSession, at: Pick<OptionsRound, "kind" | "from" | "note">, inputs: OptionInput[]): OptionsSession {
  const n = s.rounds.length + 1;
  const from = n === 1 ? [] : at.from.filter((c) => s.cards[c]);
  const kind = n === 1 ? "start" : from.length ? at.kind : "more";
  const names = cardNames(Object.keys(s.cards), kind, from, inputs.length);
  const cards = { ...s.cards };
  inputs.forEach((o, i) => (cards[names[i]!] = { ...o, card: names[i]!, parents: from, round: n }));
  const round: OptionsRound = { n, kind, title: roundTitle(kind, from, n), from, cards: names, ...(at.note ? { note: at.note } : {}) };
  return { ...s, cards, rounds: [...s.rounds, round] };
}

/** Why an answer can't be sent, or null. */
export function answerProblem(s: Pick<OptionsSession, "cards" | "multi">, a: OptionsAnswer): string | null {
  const has = (c: string) => !!s.cards[c];
  switch (a.action) {
    case "vary":
      return has(a.card) ? null : "That card isn't here.";
    case "tweak":
      return !has(a.card) ? "That card isn't here." : a.text.trim() ? null : "Say what should change.";
    case "combine":
      return new Set(a.cards).size < 2 ? "Pick two or more cards to combine." : a.cards.every(has) ? null : "One of those cards isn't here.";
    case "approve":
      if (!a.cards.length || !a.cards.every(has)) return "Pick a card to approve.";
      return !s.multi && a.cards.length > 1 ? "Approve one card." : null;
    case "other":
      return a.text.trim() ? null : "Say what you want instead.";
  }
}

/** The path to a round: its first parent's round, back to round 1 (Round 1 → More like B → B2 + C). */
export function trail(s: Pick<OptionsSession, "cards" | "rounds">, n: number): OptionsRound[] {
  const out: OptionsRound[] = [];
  let r = s.rounds[n - 1];
  while (r && !out.includes(r) && out.length < 50) {
    out.unshift(r);
    const p = r.from[0] ? s.cards[r.from[0]] : undefined;
    r = p && p.round < r.n ? s.rounds[p.round - 1] : undefined;
  }
  return out;
}

/** Combine picks: a click adds or removes a card, in the order picked. */
export const toggleCard = (sel: string[], card: string): string[] => (sel.includes(card) ? sel.filter((c) => c !== card) : [...sel, card]);

/** "B2 + C" for the combine bar. */
export const joinCards = (cards: string[]): string => cards.join(" + ");

/** Plain words for what the user just asked, while the agent works on it. */
export function workingLine(a: OptionsAnswer | undefined): string {
  switch (a?.action) {
    case "vary": return `Your agent is making ${a.count ?? 3} more like ${a.card}`;
    case "tweak": return `Your agent is changing ${a.card}: ${a.text}`;
    case "combine": return `Your agent is combining ${joinCards(a.cards)}`;
    case "approve": return `Your agent is building ${joinCards(a.cards)}`;
    case "other": return "Your agent is reading what you said";
    default: return "Your agent is working";
  }
}

/** The newest approved session (the mockup the patch card compares against). */
export const approvedOf = (list: OptionsSession[], runId?: string): OptionsSession | undefined =>
  list.findLast((s) => s.state === "approved" && !!s.approved?.length && (!runId || !s.runId || s.runId === runId)) ?? list.findLast((s) => s.state === "approved" && !!s.approved?.length);

/** The approved cards with their mockups. */
export const approvedCards = (s: OptionsSession): OptionCard[] => (s.approved ?? []).map((c) => s.cards[c]).filter((c): c is OptionCard => !!c);

// ---- the sandbox: mockup HTML is untrusted and only ever lives in an iframe built here ----

/** No scripts, no forms, no popups, no same-origin: an opaque origin that can only draw. */
export const MOCKUP_SANDBOX = "";
export const MOCKUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The srcdoc: the CSP meta goes first so it covers everything the mockup says; meta refresh and base are dropped. */
export function mockupDoc(html: string): string {
  const body = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${MOCKUP_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`;
}

/** Phone or desktop: the width the mockup is drawn at, scaled into the card. */
export const VIEW_WIDTH = { phone: 390, desktop: 1280 } as const;
export const fitScale = (box: number, view: keyof typeof VIEW_WIDTH): number => Math.min(1, Math.max(0.1, box / VIEW_WIDTH[view]));

/** Arrow keys walk the row; it wraps. */
export const stepIndex = (i: number, by: number, n: number): number => (n ? (((i + by) % n) + n) % n : 0);

/** M6: the line the Ask pill's "Show me options" adds to the goal (goalWithOptions keeps 400 chars). */
export const OPTIONS_ASK =
  "Show me options: answer with ask_options (load mockup-options and design-taste first): 2 to 4 real plain-HTML mockups as cards, loop on my answers until I approve, then build the approved one with propose_patch.";
