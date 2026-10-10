// Function extraction from source text, shared by the clip painter (capture/paint.ts).

export const MAX_LINES = 24;

const DEF_RE = /\bfunction\b|=>|^\s*(?:(?:export|async|static|public|private|protected|get|set|default)\s+)*[A-Za-z_$][\w$]*\s*\(/;
const NOT_DEF_RE = /^\s*(?:if|for|while|switch|catch|else|return|do|try)\b|^\s*\}/;
const NAME_RES = [/function\s*\*?\s*([A-Za-z_$][\w$]*)/, /([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/, /^\s*(?:(?:export|async|static|public|private|protected|get|set|default)\s+)*([A-Za-z_$][\w$]*)\s*\(/];

/** 0-based index of the line closing the block that the definition on `def` opens, or undefined. */
export function blockEnd(lines: string[], def: number): number | undefined {
  let depth = 0;
  let parens = 0;
  let opened = false;
  let prev = "";
  let mode: "code" | "sq" | "dq" | "tpl" | "block" = "code";
  const tpl: number[] = []; // depth at which each open `${` started
  for (let i = def; i < lines.length && i < def + 400; i++) {
    const s = lines[i] ?? "";
    if (mode === "sq" || mode === "dq") mode = "code"; // ponytail: strings never span lines, so a stray JSX apostrophe only costs one line
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      const nx = s[j + 1];
      if (mode === "block") {
        if (ch === "*" && nx === "/") (mode = "code"), j++;
        continue;
      }
      if (mode === "sq" || mode === "dq") {
        if (ch === "\\") j++;
        else if (ch === (mode === "sq" ? "'" : '"')) mode = "code";
        continue;
      }
      if (mode === "tpl") {
        if (ch === "\\") j++;
        else if (ch === "`") mode = "code";
        else if (opened && ch === "$" && nx === "{") tpl.push(depth++), j++, (mode = "code");
        continue;
      }
      if (ch === "/" && nx === "/") break;
      if (ch === "/" && nx === "*") {
        mode = "block";
        j++;
        continue;
      }
      if (ch === "'") mode = "sq";
      else if (ch === '"') mode = "dq";
      else if (ch === "`") mode = "tpl";
      else if (!opened) {
        if (ch === "(") parens++;
        else if (ch === ")") parens--;
        else if (ch === ";") return undefined;
        else if (ch === "{" && !"(,=:?[|&<".includes(prev)) (opened = true), (depth = 1);
      } else if (ch === "{") depth++;
      else if (ch === "}") {
        if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
          tpl.pop();
          depth--;
          mode = "tpl";
          continue;
        }
        if (--depth === 0) return i;
      }
      if (ch !== " " && ch !== "\t") prev = ch ?? "";
    }
    if (!opened && parens <= 0) return undefined; // a body must open on the definition line or where its params close
  }
  return undefined;
}

function fnName(line: string): string | undefined {
  for (const re of NAME_RES) {
    const m = re.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** The smallest function (≤ MAX_LINES) around `line` (1-based), as 1-based [start, end]. */
export function enclosingFunction(lines: string[], line: number): { start: number; end: number; name?: string } | undefined {
  for (let d = line - 1; d >= 0 && d > line - 1 - MAX_LINES; d--) {
    const s = lines[d] ?? "";
    if (!DEF_RE.test(s) || NOT_DEF_RE.test(s)) continue;
    const e = blockEnd(lines, d);
    if (e === undefined || e < line - 1) continue;
    if (e - d + 1 > MAX_LINES) return undefined; // nearest enclosing function is too long
    return { start: d + 1, end: e + 1, name: fnName(s) };
  }
  return undefined;
}
