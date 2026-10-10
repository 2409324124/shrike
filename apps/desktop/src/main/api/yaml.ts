// ponytail: a YAML subset (block maps and lists, plain/quoted scalars, | and > block scalars, one-line flow [] {}).
// Enough for OpenCollection files and most OpenAPI specs; anchors, tags and multi-line quoted strings are not supported.
// Upgrade: the `yaml` package if a real spec needs more.

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };
type Line = { n: number; indent: number; text: string };

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,[\]{}][^#]*?|-[^\s][^#]*?)\s*:(?:\s+|$)(.*)$/;

export function parseYaml(src: string): Yaml {
  const lines: Line[] = [];
  const raws = src.replace(/\r\n?/g, "\n").split("\n");
  raws.forEach((raw, n) => {
    if (/^\s*(#|$)/.test(raw) || raw === "---" || raw === "...") lines.push({ n, indent: -1, text: raw });
    else lines.push({ n, indent: raw.search(/\S/), text: raw.trimStart() });
  });
  let i = 0;
  const skip = () => {
    while (i < lines.length && lines[i]!.indent < 0) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(`YAML line ${(lines[i]?.n ?? lines.length) + 1}: ${msg}`);
  };

  const node = (min: number): Yaml => {
    skip();
    const l = lines[i];
    if (!l || l.indent < min) return null;
    if (l.text === "-" || l.text.startsWith("- ")) return seq(l.indent);
    if (KEY.test(l.text)) return map(l.indent);
    i++;
    return scalar(l.text);
  };

  const seq = (ind: number): Yaml[] => {
    const out: Yaml[] = [];
    for (skip(); i < lines.length && lines[i]!.indent === ind && (lines[i]!.text === "-" || lines[i]!.text.startsWith("- ")); skip()) {
      const l = lines[i]!;
      const rest = l.text.slice(1).trimStart();
      if (!rest) {
        i++;
        out.push(node(ind + 1));
      } else {
        lines[i] = { n: l.n, indent: ind + l.text.indexOf(rest), text: rest };
        out.push(node(ind + 1));
      }
    }
    return out;
  };

  const map = (ind: number): { [k: string]: Yaml } => {
    const out: { [k: string]: Yaml } = {};
    for (skip(); i < lines.length && lines[i]!.indent === ind; skip()) {
      const l = lines[i]!;
      const m = KEY.exec(l.text);
      if (!m) fail(`expected "key: value"`);
      const key = unquote(m![1]!.trim());
      const rest = stripComment(m![2]!);
      i++;
      if (/^[|>][+-]?\d*$/.test(rest)) out[key] = block(rest, ind);
      else if (rest) out[key] = scalar(rest);
      else {
        skip();
        const nx = lines[i];
        out[key] = nx && (nx.indent > ind || (nx.indent === ind && (nx.text === "-" || nx.text.startsWith("- ")))) ? node(nx.indent) : null;
      }
    }
    return out;
  };

  const block = (head: string, ind: number): string => {
    const body: string[] = [];
    let at = -1;
    while (i < lines.length) {
      const l = lines[i]!;
      const raw = raws[l.n]!;
      if (l.indent >= 0 && l.indent <= ind) break;
      if (l.indent < 0 && raw.trim() !== "" && raw.search(/\S/) < (at >= 0 ? at : ind + 1)) break;
      if (at < 0 && raw.trim()) at = raw.search(/\S/);
      body.push(raw);
      i++;
    }
    const lines2 = body.map((r) => r.slice(Math.max(0, at)));
    let text: string;
    if (head[0] === ">") text = lines2.reduce((acc, s, k) => (k === 0 ? s : acc + (s === "" || lines2[k - 1] === "" ? "\n" : " ") + s), "");
    else text = lines2.join("\n");
    const chomp = head.includes("-") ? "strip" : head.includes("+") ? "keep" : "clip";
    if (chomp === "strip") return text.replace(/\n+$/, "");
    if (chomp === "clip") return text.replace(/\n+$/, "") + (lines2.length ? "\n" : "");
    return `${text}\n`;
  };

  const out = node(0);
  skip();
  if (i < lines.length) fail("unexpected indentation");
  return out;
}

function stripComment(s: string): string {
  if (s.startsWith('"') || s.startsWith("'")) return s.trim();
  const k = s.search(/\s#/);
  return (k >= 0 ? s.slice(0, k) : s).trim();
}

function unquote(s: string): string {
  if (s.startsWith('"')) return JSON.parse(s.replace(/\\([^"\\/bfnrtu])/g, "$1")) as string;
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function scalar(raw: string): Yaml {
  const s = stripComment(raw);
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
  if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map(scalar);
  if (s.startsWith("{") && s.endsWith("}") && !s.startsWith("{{")) {
    const o: { [k: string]: Yaml } = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const k = part.indexOf(":");
      if (k > 0) o[unquote(part.slice(0, k).trim())] = scalar(part.slice(k + 1));
    }
    return o;
  }
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true" || s === "false") return s === "true";
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = "";
  let cur = "";
  for (const c of s) {
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PLAIN = /^(?:[^\s\-?:,[\]{}#&*!|>'"%@`]|[?:-][^\s,[\]{}])[^\n]*$/;
function str(s: string): string {
  if (s === "") return '""';
  if (PLAIN.test(s) && !/: |\s#|\s$|:$/.test(s) && scalar(s) === s) return s;
  if (s.includes('"') && !/['\\\x00-\x1f]/.test(s)) return `'${s}'`;
  return JSON.stringify(s);
}

/** Block style, two-space indent, lists of maps start on the "- " line. Top-level sections are split by a blank line. */
export function stringifyYaml(v: Yaml): string {
  const top = v && typeof v === "object" && !Array.isArray(v);
  const lines = emit(v, 0);
  if (!top) return `${lines.join("\n")}\n`;
  const out: string[] = [];
  lines.forEach((l, k) => {
    if (k > 0 && !l.startsWith(" ") && lines[k - 1]!.startsWith(" ")) out.push("");
    out.push(l);
  });
  return `${out.join("\n")}\n`;
}

function emit(v: Yaml, ind: number): string[] {
  const pad = " ".repeat(ind);
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}[]`];
    return v.flatMap((item) => {
      const inner = emit(item, ind + 2);
      if (item && typeof item === "object" && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        return [`${pad}- ${inner[0]!.slice(ind + 2)}`, ...inner.slice(1)];
      }
      return [`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1)];
    });
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return [`${pad}{}`];
    return keys.flatMap((k) => {
      const val = v[k]!;
      const key = `${pad}${str(k)}:`;
      if (val && typeof val === "object" && (Array.isArray(val) ? val.length : Object.keys(val).length)) return [key, ...emit(val, ind + 2)];
      if (typeof val === "string" && val.includes("\n")) {
        const body = val.replace(/\n$/, "");
        const head = val.endsWith("\n") && !val.endsWith("\n\n") ? "|" : val.endsWith("\n") ? "|+" : "|-";
        return [`${key} ${head}`, ...body.split("\n").map((l) => (l ? `${pad}  ${l}` : ""))];
      }
      return [`${key} ${emit(val, 0)[0]}`];
    });
  }
  if (typeof v === "string") return [`${pad}${str(v)}`];
  return [`${pad}${v === null ? "null" : String(v)}`];
}
