import { fuzzyScore } from "../hud/logic.ts";

// What's left of the V2 exact-match grammar: file names by ear, and the words that bias the recognizer.
// Understanding lives in understand/ (tier 0 and tier 1) and the registry (actions/registry.ts). Tested in grammar.test.ts.

// ---------- open <file> ----------

const FILE_NOISE = new Set(["file", "files", "code", "source", "in", "shrike", "open", "show", "dot", "ts", "tsx", "js", "jsx", "py", "my", "that", "this", "one"]);

const tokens = (s: string): string[] =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true; // todo / todos, control / controller
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (i++, j++);
    else if (++edits > 1) return false;
    else if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else (i++, j++);
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The project file a spoken name means ("the todos controller" -> server/todos.controller.ts), or null. */
export function matchFile(query: string, files: readonly string[]): string | null {
  return rankFiles(query, files)[0]?.path ?? null;
}

/** Every file the words could name, best first. */
export function rankFiles(query: string, files: readonly string[]): { path: string; score: number }[] {
  const words = tokens(query).filter((w) => !FILE_NOISE.has(w));
  if (!words.length) return [];
  const compact = words.join("");
  const out: { path: string; score: number }[] = [];
  for (const path of files) {
    const base = path.split("/").pop() ?? path;
    const stem = base.replace(/\.[^.]+$/, "");
    const bt = tokens(stem);
    const pt = tokens(path);
    const inBase = words.filter((w) => bt.some((t) => near(w, t))).length;
    const inPath = words.filter((w) => pt.some((t) => near(w, t))).length;
    const flat = stem.toLowerCase().replace(/[^a-z0-9]/g, "");
    const glued = compact.length >= 4 && flat.includes(compact); // "to dos" -> todos
    if (!glued && inPath < Math.ceil(words.length / 2)) continue;
    const score = (glued ? 30 : 0) + inPath * 10 + inBase * 6 + (inBase === bt.length ? 4 : 0) + (fuzzyScore(compact, base) ?? 0) * 0.1 - path.length * 0.01;
    out.push({ path, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- what the recognizer should expect ----------

/** Words that bias the recognizer: the live names a person may say (docs/16 §2.3), plus the project's file names in words. */
export function contextWords(files: readonly string[], live: readonly string[] = []): string[] {
  const names = files.map((f) => tokens((f.split("/").pop() ?? f).replace(/\.[^.]+$/, "")).join(" ")).filter((s) => s.length > 2);
  return [...new Set(["Shrike", "PR", "pull request", "logs", "terminal", "workspace", "commit", "push", ...live, ...names])].slice(0, 300);
}
