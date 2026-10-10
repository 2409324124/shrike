export interface Span {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const COLORS: Record<number, string> = {
  30: "var(--ink-dim)",
  31: "var(--fail)",
  32: "var(--ok)",
  33: "var(--slow)",
  34: "#7aa7ff",
  35: "#c79bff",
  36: "var(--signal)",
  37: "var(--ink)",
};

/** Minimal SGR colouring (8/16 colours, bold, dim); every other escape sequence is dropped. */
export function parseAnsi(input: string): Span[] {
  // Normalise newlines and let a bare \r overwrite its line, like a terminal does for progress output.
  const text = input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.slice(l.lastIndexOf("\r") + 1))
    .join("\n");
  const out: Span[] = [];
  let cur: Omit<Span, "text"> = {};
  const re = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[ -/]*[@-ln-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), ...cur });
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) cur = {};
      else if (c === 1) cur = { ...cur, bold: true };
      else if (c === 2) cur = { ...cur, dim: true };
      else if (c === 22) cur = { ...cur, bold: false, dim: false };
      else if (c === 39) cur = { ...cur, color: undefined };
      else if (c >= 30 && c <= 37) cur = { ...cur, color: COLORS[c] };
      else if (c >= 90 && c <= 97) cur = { ...cur, color: c === 90 ? "var(--ink-dim)" : COLORS[c - 60] };
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // 256/truecolour: skip its arguments
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), ...cur });
  return out;
}

/** The text without escape sequences: for one-line labels that can't show colour. */
export const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
