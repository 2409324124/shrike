// Pure diff helper for the agent's fix card (hud/Agent.tsx), tested in renderer-logic.test.ts.

export interface DiffLine {
  kind: "del" | "add" | "ctx";
  text: string;
  line: number; // 1-based, in "before" for del/ctx, in "after" for add
}

/** The changed hunk between two versions: common prefix/suffix trimmed, with one line of context. */
export function lineDiff(before: string, after: string, context = 1): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  if (p === a.length && p === b.length) return [];
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out: DiffLine[] = [];
  for (let i = Math.max(0, p - context); i < p; i++) out.push({ kind: "ctx", text: a[i]!, line: i + 1 });
  for (let i = p; i < a.length - s; i++) out.push({ kind: "del", text: a[i]!, line: i + 1 });
  for (let i = p; i < b.length - s; i++) out.push({ kind: "add", text: b[i]!, line: i + 1 });
  for (let i = a.length - s; i < Math.min(a.length, a.length - s + context); i++) out.push({ kind: "ctx", text: a[i]!, line: i + 1 });
  return out;
}
