import type { ScmArea, ScmDiff, ScmDiffLine, ScmFile, ScmState } from "@shrike/schema";

// SC1–SC7 pure helpers: plain words, sections, split-view rows, changed words. Tested in logic.test.ts.

export const SECTIONS: { area: ScmArea; title: string; hint: string }[] = [
  { area: "conflicts", title: "Conflicts", hint: "Both sides changed these. Fix them before you commit." },
  { area: "staged", title: "Staged", hint: "Goes into your next commit." },
  { area: "changes", title: "Changes", hint: "Edited, not staged yet." },
  { area: "untracked", title: "Untracked", hint: "New files git doesn't know yet." },
  { area: "branch", title: "Committed on this branch", hint: "Everything this branch changes, compared with main." },
];

/** Colour token per status letter (U/A new, M edited, D gone, R moved, ! conflict). */
export const LETTER_TONE: Record<ScmFile["letter"], string> = { U: "var(--ok)", A: "var(--ok)", M: "var(--slow)", D: "var(--fail)", R: "var(--signal)", C: "var(--signal)", "!": "var(--fail)" };

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** The one plain line under the branch: what isn't saved, what isn't on GitHub, what's new on main. */
export function statusWords(s: ScmState): { text: string; tone: "ok" | "info" | "warn" }[] {
  const local = s.files.filter((f) => f.area !== "branch");
  const conflicts = local.filter((f) => f.area === "conflicts").length;
  const unsaved = new Set(local.filter((f) => f.area !== "conflicts").map((f) => f.path)).size;
  const unsent = s.upstream ? s.ahead : s.remote ? s.commits.filter((c) => !c.pushed).length : 0;
  const out: ReturnType<typeof statusWords> = [];
  if (conflicts) out.push({ text: `${n(conflicts, "file")} with conflicts`, tone: "warn" });
  if (unsaved) out.push({ text: `${n(unsaved, "change")} not saved to git yet`, tone: "info" });
  if (unsent) out.push({ text: `${n(unsent, "commit")} not on GitHub yet`, tone: "info" });
  if (s.behind) out.push({ text: `GitHub has ${n(s.behind, "new commit")} for this branch`, tone: "info" });
  if (s.base && s.branch !== s.base && s.baseBehind) out.push({ text: `${s.base} moved on by ${n(s.baseBehind, "commit")}`, tone: "info" });
  if (!s.remote && !out.length) out.push({ text: "Everything is saved in git. This project isn't on GitHub yet.", tone: "ok" });
  if (!out.length) out.push({ text: "Everything is saved and on GitHub.", tone: "ok" });
  return out;
}

export const byArea = (files: ScmFile[], area: ScmArea): ScmFile[] => files.filter((f) => f.area === area);

export const splitPath = (p: string): { name: string; dir: string } => {
  const i = p.lastIndexOf("/");
  return i < 0 ? { name: p, dir: "" } : { name: p.slice(i + 1), dir: p.slice(0, i) };
};

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The part of a line that changed against its pair: [start, end) after a common prefix and suffix. */
export function changedRange(text: string, other: string | undefined): [number, number] | undefined {
  if (other === undefined || text === other) return undefined;
  let a = 0;
  while (a < text.length && a < other.length && text[a] === other[a]) a++;
  let b = 0;
  while (b < text.length - a && b < other.length - a && text[text.length - 1 - b] === other[other.length - 1 - b]) b++;
  return a === 0 && b === 0 ? undefined : a < text.length - b ? [a, text.length - b] : undefined; // a fully new line isn't "words changed"
}

export interface Row {
  kind: ScmDiffLine["kind"];
  line: ScmDiffLine;
  pair?: string; // the del/add it replaces, for the changed words
}

/** Inline rows: each del pairs with the add at the same place in its change block. */
export function inlineRows(lines: ScmDiffLine[]): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind === "ctx") {
      out.push({ kind: "ctx", line: lines[i++]! });
      continue;
    }
    const dels: ScmDiffLine[] = [];
    const adds: ScmDiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    dels.forEach((d, k) => out.push({ kind: "del", line: d, ...(adds[k] ? { pair: adds[k]!.text } : {}) }));
    adds.forEach((a, k) => out.push({ kind: "add", line: a, ...(dels[k] ? { pair: dels[k]!.text } : {}) }));
  }
  return out;
}

/** Split rows: old on the left, new on the right, a change block padded so the sides line up. */
export function splitRows(lines: ScmDiffLine[]): { left?: Row; right?: Row }[] {
  const out: { left?: Row; right?: Row }[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!;
    if (l.kind === "ctx") {
      out.push({ left: { kind: "ctx", line: l }, right: { kind: "ctx", line: l } });
      i++;
      continue;
    }
    const dels: ScmDiffLine[] = [];
    const adds: ScmDiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({ ...(d ? { left: { kind: "del", line: d, ...(a ? { pair: a.text } : {}) } } : {}), ...(a ? { right: { kind: "add", line: a, ...(d ? { pair: d.text } : {}) } } : {}) });
    }
  }
  return out;
}

export interface Tok {
  content: string;
  color: string;
}

/** Cuts syntax tokens at a range so the changed words can be lit without losing their colours. */
export function paint(tokens: Tok[], range: [number, number] | undefined): (Tok & { lit?: boolean })[] {
  if (!range) return tokens;
  const out: (Tok & { lit?: boolean })[] = [];
  let at = 0;
  for (const t of tokens) {
    const end = at + t.content.length;
    const cuts = [at, Math.min(Math.max(range[0], at), end), Math.min(Math.max(range[1], at), end), end];
    for (let k = 0; k < 3; k++) if (cuts[k + 1]! > cuts[k]!) out.push({ content: t.content.slice(cuts[k]! - at, cuts[k + 1]! - at), color: t.color, ...(k === 1 ? { lit: true } : {}) });
    at = end;
  }
  return out;
}

export const counts = (d: ScmDiff): { added: number; removed: number } =>
  d.hunks.reduce((c, h) => ({ added: c.added + h.lines.filter((l) => l.kind === "add").length, removed: c.removed + h.lines.filter((l) => l.kind === "del").length }), { added: 0, removed: 0 });

/** What "Ask about this change" puts on the Ask composer: the file, where, and the change itself. */
export function askLine(d: ScmDiff, what: string, max = 1600): string {
  const body = d.hunks.map((h) => h.lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`).join("\n")).join("\n…\n");
  const first = d.hunks[0]?.lines.find((l) => l.kind !== "ctx");
  const where = first ? `, around line ${first.new ?? first.old}` : "";
  const clip = body.length > max ? `${body.slice(0, max)}\n…(cut)` : body;
  return `Context: ${what} to ${d.path}${where}:\n${clip}`;
}

export interface BranchMap {
  onBase: boolean; // no fork: just the base line
  base: string;
  behind: number; // dots on the base line past the fork
  mine: boolean[]; // this branch's commits, oldest first: true when on GitHub
  more: number; // commits not drawn
  dirty: boolean; // changes not committed yet, a ring at the tip
  pr: boolean;
}

/** SC2: what the branch map strip draws. At most `max` dots per line. */
export function branchMap(s: ScmState, pr: boolean, max = 7): BranchMap {
  const onBase = !s.branch || s.branch === s.base;
  const n = onBase ? s.ahead : s.baseAhead;
  const listed = s.commits.filter((c) => (onBase ? !c.pushed : c.mine));
  const mine = Array.from({ length: Math.min(n, max) }, (_, i) => listed[Math.min(n, max) - 1 - i]?.pushed ?? true);
  return { onBase, base: s.base ?? "main", behind: Math.min(onBase ? s.behind : s.baseBehind, max), mine, more: Math.max(0, n - max), dirty: s.files.some((f) => f.area !== "branch"), pr: pr && !onBase };
}

/** SC7: the Sync button in plain words. */
export function syncWords(s: ScmState): { label: string; hint: string } {
  const how = s.pull === "rebase" ? "rebasing" : "fast-forward only";
  if (!s.upstream) return { label: "Send to GitHub", hint: `Push ${s.branch ?? "this branch"} to ${s.remote ?? "GitHub"} as a new branch. You'll say yes first.` };
  if (s.ahead && s.behind) return { label: `Sync ↓${s.behind} ↑${s.ahead}`, hint: `Bring in GitHub's ${n(s.behind, "commit")} (${how}), then send yours. You'll say yes before anything is sent.` };
  if (s.ahead) return { label: `Send ${s.ahead} to GitHub`, hint: "Push your commits. You'll say yes first. Never a force-push." };
  if (s.behind) return { label: `Bring in ${s.behind}`, hint: `Pull GitHub's ${n(s.behind, "commit")} (${how}).` };
  return { label: "Sync", hint: "Check GitHub for new commits." };
}

/** The Commit button's words: what goes in. */
export function commitWords(s: ScmState): { label: string; can: boolean } {
  const staged = byArea(s.files, "staged").length;
  const rest = new Set(s.files.filter((f) => f.area === "changes" || f.area === "untracked").map((f) => f.path)).size;
  if (s.files.some((f) => f.area === "conflicts") || s.operation) return { label: "Fix conflicts first", can: false };
  if (staged) return { label: `Commit ${n(staged, "file")}`, can: true };
  if (rest) return { label: `Commit all ${n(rest, "change")}`, can: true };
  return { label: "Nothing to commit", can: false };
}
