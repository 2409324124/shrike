import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { AgentOptions, AgentRunInfo, CiFailureKind, CiJob, CiLessonsState, CiPipeline, CiStep, PreflightLeg, PreflightRun, PrCheck, ScmState } from "@shrike/schema";
import { frontMatter } from "@shrike/mcp-server";
import { ghStatus, type Exec, type Gh } from "./github.ts";
import { killTree, spawnShell } from "./platform.ts";
import { judge } from "./start/policy.ts";
import { loadSkills, pendingDraft, proposeUpdate, rescanNow, settleNow, noteSkillUse, slug, type SkillDirs } from "./skills.ts";

// CI1–CI8: what CI runs (config + gh run history, reads only), a per-project lessons skill Claude writes, and pre-flight:
// the legs a change touches, run here like CI. A lesson is kept (S4 outcome "preflight") only when pre-flight matched hosted CI.
// Electron-free so it tests with node:test; ipc.ts wires it.

// ---------------- a small YAML reader (block maps and lists, scalars, | and >, flow [] {}, anchors) ----------------

export type Yaml = string | null | Yaml[] | { [k: string]: Yaml };
type YMap = { [k: string]: Yaml };

const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#"'[\]{},&*!|>%@`][^#]*?|<<))\s*:(?:\s+(.*))?$/;
const isMap = (v: Yaml | undefined): v is YMap => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: Yaml | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const strs = (v: Yaml | undefined): string[] => list(v).filter((x): x is string => typeof x === "string");

function unquote(s: string): string {
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
const plainEnd = (s: string) => s.replace(/(^|\s)#.*$/, "").trim();

export function parseYaml(src: string): Yaml {
  const L = src.replace(/\r\n?/g, "\n").split("\n");
  const anchors = new Map<string, Yaml>();
  let i = 0;
  const ind = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => !l.trim() || l.trimStart().startsWith("#") || /^(---|\.\.\.)\s*$/.test(l);
  const skip = () => {
    while (i < L.length && blank(L[i]!)) i++;
  };
  const isItem = (t: string) => t === "-" || t.startsWith("- ");

  function block(min: number): Yaml {
    skip();
    if (i >= L.length || ind(L[i]!) < min) return null;
    const n = ind(L[i]!);
    const t = L[i]!.slice(n);
    if (isItem(t)) return seq(n);
    if (KEY.test(t)) return map(n);
    return value(t, n - 1, false);
  }

  function map(n: number): YMap {
    const out: YMap = {};
    for (;;) {
      skip();
      if (i >= L.length || ind(L[i]!) !== n) break;
      const m = KEY.exec(L[i]!.slice(n));
      if (!m) break;
      i++;
      const key = m[1] !== undefined ? unquote(`"${m[1]}"`) : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]!.trim();
      const v = value(m[4] ?? "", n, true);
      if (key === "<<") for (const src of Array.isArray(v) ? v : [v]) isMap(src) && Object.assign(out, { ...src, ...out });
      else out[key] = v;
    }
    return out;
  }

  function seq(n: number): Yaml[] {
    const out: Yaml[] = [];
    for (;;) {
      skip();
      if (i >= L.length || ind(L[i]!) !== n || !isItem(L[i]!.slice(n))) break;
      const rest = L[i]!.slice(n + 1);
      const content = rest.trimStart();
      if (content && KEY.test(content) && !/^[|>]/.test(content)) {
        const col = n + 1 + (rest.length - content.length);
        L[i] = " ".repeat(col) + content; // the item is a map starting on this line
        out.push(map(col));
      } else {
        i++;
        out.push(value(content, n, false));
      }
    }
    return out;
  }

  function value(raw: string, n: number, inMap: boolean): Yaml {
    let r = raw.trim();
    let anchor: string | undefined;
    const a = /^&([\w.-]+)\s*/.exec(r);
    if (a) (anchor = a[1]), (r = r.slice(a[0].length));
    r = r.replace(/^!!?[\w/]+\s+/, ""); // tags
    let v: Yaml;
    if (r.startsWith("*")) v = anchors.get(plainEnd(r.slice(1))) ?? null;
    else if (/^[|>][-+0-9]*\s*(#.*)?$/.test(r)) v = blockScalar(r, n);
    else if (!r || r.startsWith("#")) {
      skip();
      const next = i < L.length ? L[i]! : "";
      if (i < L.length && ind(next) > n) v = block(n + 1);
      else if (i < L.length && inMap && ind(next) === n && isItem(next.slice(n))) v = seq(n);
      else v = null;
    } else if (r.startsWith("[") || r.startsWith("{")) {
      let text = r;
      while (!balanced(text) && i < L.length) text += ` ${L[i++]!.trim()}`;
      v = flow(text);
    } else if ((r.startsWith('"') && !/^"(?:[^"\\]|\\.)*"/.test(r)) || (r.startsWith("'") && !/^'(?:[^']|'')*'/.test(r))) {
      let text = r;
      while (i < L.length && !(text.startsWith('"') ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/).test(text)) text += ` ${L[i++]!.trim()}`;
      v = unquote(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(text)?.[1] ?? text);
    } else if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.test(r)) v = unquote(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/.exec(r)![1]!);
    else {
      let text = plainEnd(r);
      while (i < L.length && !blank(L[i]!) && ind(L[i]!) > n && !KEY.test(L[i]!.trim()) && !isItem(L[i]!.trim())) text += ` ${plainEnd(L[i++]!.trim())}`;
      v = text === "~" || text === "null" ? null : text;
    }
    if (anchor) anchors.set(anchor, v);
    return v;
  }

  function blockScalar(header: string, n: number): string {
    const keep = header.includes("+");
    const strip = header.includes("-");
    const explicit = /[1-9]/.exec(header)?.[0];
    const body: string[] = [];
    let at = -1;
    while (i < L.length) {
      const l = L[i]!;
      if (!l.trim()) {
        body.push("");
        i++;
        continue;
      }
      const m = ind(l);
      if (m <= n) break;
      if (at < 0) at = explicit ? n + Number(explicit) : m;
      if (m < at) break;
      body.push(l.slice(at));
      i++;
    }
    let tail = 0;
    while (body.length && body.at(-1) === "") (body.pop(), tail++);
    const text = header.startsWith(">") ? body.reduce((acc, l, k) => (k === 0 ? l : l === "" ? `${acc}\n` : acc.endsWith("\n") || /^\s/.test(l) ? `${acc}${l}` : `${acc} ${l}`), "") : body.join("\n");
    return strip ? text : `${text}\n${keep ? "\n".repeat(tail) : ""}`;
  }

  const out = block(0);
  return out;
}

function balanced(s: string): boolean {
  let d = 0;
  let q: string | null = null;
  for (const c of s) {
    if (q) q = c === q ? null : q;
    else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return d <= 0;
}

function flow(s: string): Yaml {
  let p = 0;
  const ws = () => {
    while (p < s.length && /\s/.test(s[p]!)) p++;
  };
  const scalar = (key: boolean): string | null => {
    ws();
    const q = s[p];
    if (q === '"' || q === "'") {
      const m = (q === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/).exec(s.slice(p));
      const t = m?.[0] ?? s.slice(p);
      p += t.length;
      return unquote(t);
    }
    let t = "";
    while (p < s.length && !/[,\]}]/.test(s[p]!) && !(key && s[p] === ":" && /[\s,\]}]|$/.test(s[p + 1] ?? ""))) t += s[p++];
    t = t.trim();
    return t === "~" || t === "null" ? null : t;
  };
  const val = (): Yaml => {
    ws();
    if (s[p] === "[") {
      p++;
      const arr: Yaml[] = [];
      for (;;) {
        ws();
        if (s[p] === "]" || p >= s.length) break;
        arr.push(val());
        ws();
        if (s[p] === ",") p++;
      }
      p++;
      return arr;
    }
    if (s[p] === "{") {
      p++;
      const o: YMap = {};
      for (;;) {
        ws();
        if (s[p] === "}" || p >= s.length) break;
        const k = scalar(true) ?? "";
        ws();
        let v: Yaml = null;
        if (s[p] === ":") (p++, (v = val()));
        o[k] = v;
        ws();
        if (s[p] === ",") p++;
      }
      p++;
      return o;
    }
    return scalar(false);
  };
  return val();
}

// ---------------- ${{ }} expressions (GitHub's small language, with "unknown" for what only CI knows) ----------------

type EV = string | number | boolean | null | undefined | EV[] | { [k: string]: EV }; // undefined: unknown here
export type ExprCtx = Record<string, unknown>;

const TOKEN = /\s*(?:(\|\||&&|==|!=|<=|>=|[<>!(),[\]])|('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.(?:[\w-]+|\*))*)|(\S))/y;

export function evalExpr(src: string, ctx: ExprCtx, secrets?: Set<string>): EV {
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) toks.push(m[0].trim());
  let p = 0;
  const peek = () => toks[p];
  const truthy = (v: EV) => v !== false && v !== 0 && v !== "" && v !== null;
  const look = (path: string): EV => {
    const [root, ...rest] = path.split(".");
    if (root === "true") return true;
    if (root === "false") return false;
    if (root === "null") return null;
    if (root === "secrets") return (rest[0] && secrets?.add(rest[0]), undefined);
    let v: unknown = ctx[root!];
    for (const k of rest) {
      if (v === undefined || v === null || typeof v !== "object") return undefined;
      v = (v as Record<string, unknown>)[k];
    }
    return v as EV;
  };
  const eq = (a: EV, b: EV): EV => (a === undefined || b === undefined ? undefined : typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a == b); // eslint-disable-line eqeqeq
  const fn = (name: string, args: EV[]): EV => {
    const s = (v: EV) => (v === undefined ? undefined : typeof v === "string" ? v.toLowerCase() : JSON.stringify(v));
    switch (name.toLowerCase()) {
      case "always":
      case "success":
        return true;
      case "failure":
      case "cancelled":
        return false;
      case "startswith":
        return args[0] === undefined || args[1] === undefined ? undefined : s(args[0])!.startsWith(s(args[1])!);
      case "endswith":
        return args[0] === undefined || args[1] === undefined ? undefined : s(args[0])!.endsWith(s(args[1])!);
      case "contains":
        return args[0] === undefined || args[1] === undefined ? undefined : Array.isArray(args[0]) ? args[0].some((x) => eq(x, args[1]!) === true) : s(args[0])!.includes(s(args[1])!);
      case "format":
        return args.some((a) => a === undefined) ? undefined : String(args[0]).replace(/\{(\d+)\}/g, (_x, k: string) => String(args[Number(k) + 1] ?? ""));
      case "tojson":
        return args[0] === undefined ? undefined : JSON.stringify(args[0]);
      default:
        return undefined;
    }
  };
  const primary = (): EV => {
    const t = toks[p++];
    if (t === undefined) return undefined;
    if (t === "(") {
      const v = or();
      p++;
      return v;
    }
    if (t === "!") {
      const v = primary();
      return v === undefined ? undefined : !truthy(v);
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        p++;
        const args: EV[] = [];
        while (p < toks.length && peek() !== ")") {
          args.push(or());
          if (peek() === ",") p++;
        }
        p++;
        return fn(t, args);
      }
      let v = look(t);
      while (peek() === "[") {
        p++;
        const k = or();
        p++;
        v = v && typeof v === "object" && k !== undefined && k !== null ? (v as Record<string, EV>)[String(k)] : undefined;
      }
      return v;
    }
    return undefined;
  };
  const cmp = (): EV => {
    const a = primary();
    const op = peek();
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      p++;
      const b = primary();
      if (op === "==") return eq(a, b);
      if (op === "!=") return eq(a, b) === undefined ? undefined : !eq(a, b);
      if (a === undefined || b === undefined) return undefined;
      const [x, y] = [Number(a), Number(b)];
      return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
    }
    return a;
  };
  const and = (): EV => {
    let a = cmp();
    while (peek() === "&&") {
      p++;
      const b = cmp();
      a = a !== undefined && !truthy(a) ? a : a === undefined ? (b !== undefined && !truthy(b) ? b : undefined) : b;
    }
    return a;
  };
  function or(): EV {
    let a = and();
    while (peek() === "||") {
      p++;
      const b = and();
      a = a !== undefined && truthy(a) ? a : a === undefined ? (b !== undefined && truthy(b) ? b : undefined) : b;
    }
    return a;
  }
  try {
    return or();
  } catch {
    return undefined;
  }
}

const EXPR = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
/** ${{ … }} filled in; what only CI knows stays as written. */
export function fill(text: string, ctx: ExprCtx, secrets?: Set<string>): string {
  return text.replace(EXPR, (all, e: string) => {
    const v = evalExpr(e, ctx, secrets);
    return v === undefined || (typeof v === "object" && v !== null) ? all : String(v ?? "");
  });
}
/** An `if:` for a pull request: true, false, or undefined when it depends on what only CI knows (then it counts as running). */
export function decideIf(cond: Yaml | undefined, ctx: ExprCtx): boolean | undefined {
  if (cond === undefined || cond === null) return true;
  const s = String(cond).trim();
  const e = /^\$\{\{([\s\S]*)\}\}$/.exec(s)?.[1] ?? s;
  const v = evalExpr(e, ctx);
  return v === undefined ? undefined : v !== false && v !== 0 && v !== "" && v !== null;
}

// ---------------- workflows → jobs ----------------

interface Where {
  top: string; // repo root
  branch?: string;
  base: string; // "main"
  repo?: string; // "owner/name"
}

const ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", ".nvmrc", ".node-version", "tsconfig.json", "tsconfig.base.json"];
const SETUP = /^(actions\/setup-(node|python|go|java|dotnet)|pnpm\/action-setup|oven-sh\/setup-bun|denoland\/setup-deno|astral-sh\/setup-uv)\b/i;
const CI_ONLY = /^(actions\/(cache|upload-artifact|download-artifact|github-script|labeler|stale)|codecov\/|docker\/|github\/codeql-action)\b/i;
const GIT_STATE = /\bgit\s+(reset|checkout|switch|fetch|pull|push|commit|stash|clean|rebase|merge|tag|config\s+--global)\b/;
const DOWNLOAD = /\b(curl|wget)\b[^\n]*https?:\/\/|\bsudo\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b|\bnix-env\b/;
const INSTALL = /^\s*(pnpm|npm|yarn|bun)\s+(install|i|ci)\b(?![\w-])/;
const GH_ONLY = /\$\{?GITHUB_(ENV|PATH|OUTPUT|STEP_SUMMARY)\b|^::/m;

export function matrixLegs(matrix: Yaml | undefined): Record<string, string>[] {
  if (!isMap(matrix)) return [{}];
  const base = Object.entries(matrix).filter(([k, v]) => k !== "include" && k !== "exclude" && Array.isArray(v));
  let legs: Record<string, string>[] = [{}];
  for (const [k, vals] of base) legs = legs.flatMap((l) => (vals as Yaml[]).map((v) => ({ ...l, [k]: typeof v === "string" ? v : JSON.stringify(v) })));
  const asRec = (o: Yaml): Record<string, string> => (isMap(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) : {});
  for (const ex of list(matrix.exclude).map(asRec)) legs = legs.filter((l) => !Object.entries(ex).every(([k, v]) => l[k] === v));
  for (const inc of list(matrix.include).map(asRec)) {
    const keys = base.map(([k]) => k).filter((k) => k in inc);
    const hits = legs.filter((l) => keys.length && keys.every((k) => l[k] === inc[k]));
    if (hits.length) hits.forEach((l) => Object.assign(l, inc));
    else legs.push(inc);
  }
  return legs.length ? legs : [{}];
}

const firstLine = (s: string) => s.trim().split("\n")[0]!.trim();
const words = (s: string) => s.replace(/\s+/g, " ").trim();

/** A step as pre-flight sees it: run here, run only when needed (installs, tool downloads), or CI-only (with why). */
export function classifyStep(step: { name?: string; uses?: string; run?: string; cwd?: string; env?: Record<string, string> }, secrets: string[], ciOnly: string[] = []): CiStep {
  const name = step.name || (step.run ? firstLine(step.run).slice(0, 80) : step.uses ?? "step");
  const base = { name, ...(step.run ? { run: step.run.trim() } : {}), ...(step.cwd ? { cwd: step.cwd } : {}), ...(step.env && Object.keys(step.env).length ? { env: step.env } : {}) };
  if (step.uses) {
    const u = step.uses.replace(/@.*$/, "");
    if (/^actions\/checkout$/i.test(u)) return { ...base, local: "skip", why: "CI checks out the code; it's already here" };
    if (SETUP.test(u)) return { ...base, local: "skip", why: `CI sets up ${u.split("/").pop()!.replace(/^setup-|-setup$|^action-setup$/, "") || "the tools"}; here it uses the ones on this computer` };
    if (CI_ONLY.test(u)) return { ...base, local: "skip", why: "Only matters on GitHub (caches, uploads, CI services)" };
    return { ...base, local: "skip", why: `Uses the ${u} action, which only runs on GitHub` };
  }
  const run = step.run ?? "";
  if (/\$\{\{\s*secrets\./.test(run) || secrets.some((s) => new RegExp(`\\$\\{?${s}\\b`).test(run))) return { ...base, local: "skip", why: "Needs a secret only CI has" };
  if (ciOnly.some((s) => new RegExp(`\\$\\{?${s}\\b`).test(run))) return { ...base, local: "skip", why: "Needs a value only CI has (about the pull request or the CI machine)" };
  if (/\$\{\{/.test(run)) return { ...base, local: "skip", why: `Uses a value only CI has (${/\$\{\{\s*([^}]*?)\s*\}\}/.exec(run)?.[1] ?? "a CI value"})` };
  if (GIT_STATE.test(run)) return { ...base, local: "skip", why: "Changes git state, which CI does on a throwaway copy" };
  if (DOWNLOAD.test(run)) return { ...base, local: "prep", why: "Downloads a tool for CI; here Shrike uses yours when it's installed" };
  if (GH_ONLY.test(run) && !/\n/.test(run.trim())) return { ...base, local: "skip", why: "Only passes settings between CI steps" };
  if (INSTALL.test(run)) return { ...base, local: "prep", why: "Installs packages; runs here only when they aren't installed yet" };
  return { ...base, local: "run" };
}

const MAX_FILE = 512 * 1024;
async function readText(file: string): Promise<string | undefined> {
  try {
    const t = await readFile(file, "utf8");
    return t.length > MAX_FILE ? undefined : t;
  } catch {
    return undefined;
  }
}

const isPr = (on: YMap) => "pull_request" in on || "pull_request_target" in on;

function triggers(doc: YMap): YMap {
  const on = doc.on ?? doc.true ?? null;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(strs(on).map((e) => [e, null]));
  return isMap(on) ? on : {};
}

/** A branch filter glob (`release**`, `feature/*`). */
export function globMatch(glob: string, path: string): boolean {
  const neg = glob.startsWith("!");
  const g = (neg ? glob.slice(1) : glob).replace(/^\.\//, "");
  const re = new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
  return re.test(path);
}
const anyGlob = (globs: string[], p: string) => {
  let hit = false;
  for (const g of globs) if (globMatch(g, p)) hit = !g.startsWith("!");
  return hit;
};

interface RawJob {
  id: string;
  doc: YMap;
}

/** GitHub Actions: workflows that run on a pull request (or on a push this branch makes), reusable ones followed into this repo. */
export async function githubJobs(w: Where): Promise<{ jobs: CiJob[]; files: string[] }> {
  const dir = join(w.top, ".github", "workflows");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/.test(f)).sort();
  const docs = new Map<string, YMap>();
  for (const f of names) {
    const t = await readText(join(dir, f));
    let d: Yaml = null;
    try {
      d = t ? parseYaml(t) : null;
    } catch {}
    if (isMap(d)) docs.set(`.github/workflows/${f}`, d);
  }
  const jobs: CiJob[] = [];
  const files: string[] = [];
  for (const [file, doc] of docs) {
    const on = triggers(doc);
    const push = on.push;
    const pushHere = "push" in on && (!isMap(push) || (!push.branches && !push.tags) || (!!w.branch && anyGlob(strs(push.branches), w.branch)));
    if (!isPr(on) && !pushHere) continue;
    files.push(file);
    const pr = (on.pull_request ?? on.pull_request_target ?? (pushHere ? push : null)) as Yaml;
    const paths = isMap(pr) ? strs(pr.paths) : [];
    const ignore = isMap(pr) ? strs(pr["paths-ignore"]) : [];
    const wf = str(doc.name) ?? basename(file).replace(/\.ya?ml$/, "");
    const out = await expandWorkflow(w, docs, file, doc, { wf, inputs: {}, prefix: "", stage: 0, idPrefix: `${file}#`, depth: 0 });
    for (const j of out) jobs.push({ ...j, ...(paths.length ? { paths } : {}), ...(ignore.length ? { pathsIgnore: ignore } : {}) });
  }
  return { jobs, files };
}

interface Expand {
  wf: string;
  inputs: Record<string, unknown>;
  prefix: string; // "ci / "
  stage: number;
  idPrefix: string;
  depth: number;
  off?: string;
  extraFiles?: string[];
}

const envOf = (v: Yaml | undefined, ctx: ExprCtx, secrets: Set<string>): { env: Record<string, string>; secret: string[]; ciOnly: string[] } => {
  const env: Record<string, string> = {};
  const secret: string[] = [];
  const ciOnly: string[] = [];
  if (!isMap(v)) return { env, secret, ciOnly };
  for (const [k, raw] of Object.entries(v)) {
    const text = typeof raw === "string" ? raw : raw === null ? "" : JSON.stringify(raw);
    if (/\$\{\{\s*secrets\./.test(text)) {
      secret.push(k);
      fill(text, ctx, secrets);
      continue;
    }
    const val = fill(text, ctx, secrets);
    if (/\$\{\{/.test(val)) ciOnly.push(k);
    else env[k] = val;
  }
  return { env, secret, ciOnly };
};

async function expandWorkflow(w: Where, docs: Map<string, YMap>, file: string, doc: YMap, x: Expand): Promise<CiJob[]> {
  const raw: RawJob[] = isMap(doc.jobs) ? Object.entries(doc.jobs).flatMap(([id, d]) => (isMap(d) ? [{ id, doc: d }] : [])) : [];
  const github = { event_name: "pull_request", base_ref: w.base, head_ref: w.branch ?? "", ref_name: w.branch ?? "", ref: `refs/heads/${w.branch ?? ""}`, repository: w.repo ?? "", workflow: x.wf, actor: "you" };
  const secrets = new Set<string>();
  const wfEnv = envOf(doc.env, { github, inputs: x.inputs, env: {}, vars: undefined }, secrets);
  const depth = new Map<string, number>();
  const stageOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    const j = raw.find((r) => r.id === id);
    if (!j || seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...strs(j.doc.needs).map((n) => stageOf(n, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const out: CiJob[] = [];
  for (const j of raw) {
    const name = str(j.doc.name);
    const stage = x.stage + stageOf(j.id);
    const needs = strs(j.doc.needs).map((n) => `${x.idPrefix}${n}`);
    const legs = matrixLegs(isMap(j.doc.strategy) ? j.doc.strategy.matrix : undefined);
    for (const matrix of legs) {
      const ctx: ExprCtx = { github, inputs: x.inputs, matrix, env: { ...wfEnv.env }, vars: undefined, runner: undefined, needs: undefined, steps: undefined, job: undefined, strategy: undefined };
      const jobEnv = envOf(j.doc.env, ctx, secrets);
      const env = { ...wfEnv.env, ...jobEnv.env };
      ctx.env = env;
      const leg = Object.values(matrix).join(", ");
      const shown = name ? fill(name, ctx) : j.id;
      const label = `${x.prefix}${shown}${leg && !(name && /\$\{\{/.test(name)) ? ` (${leg})` : ""}`;
      const id = `${x.idPrefix}${j.id}${leg ? `:${leg}` : ""}`;
      const runs = decideIf(j.doc.if, ctx);
      const off = x.off ?? (runs === false ? `Doesn't run on pull requests (it runs only when ${words(String(j.doc.if)).replace(/^\$\{\{\s*|\s*\}\}$/g, "")})` : undefined);
      if (typeof j.doc.uses === "string") {
        const ref = j.doc.uses.trim();
        const local = ref.startsWith("./") ? ref.slice(2).replace(/@.*$/, "") : w.repo && ref.toLowerCase().startsWith(`${w.repo.toLowerCase()}/`) ? ref.slice(w.repo.length + 1).replace(/@.*$/, "") : undefined;
        const inner = local ? docs.get(local) : undefined;
        if (!inner || x.depth > 3) {
          out.push(blankJob({ id, name: label, workflow: x.wf, file, stage, needs, off: off ?? (local ? `Calls ${local}, which Shrike couldn't read` : `Calls a workflow from another repository (${ref.replace(/@.*$/, "")}), which Shrike can't read here`) }));
          continue;
        }
        const call = isMap(inner.on) && isMap(inner.on.workflow_call) ? inner.on.workflow_call : {};
        const defaults = isMap(call.inputs) ? Object.fromEntries(Object.entries(call.inputs).map(([k, v]) => [k, isMap(v) ? (v.default ?? "") : ""])) : {};
        const given = isMap(j.doc.with) ? Object.fromEntries(Object.entries(j.doc.with).map(([k, v]) => [k, typeof v === "string" ? fill(v, ctx) : v])) : {};
        const sub = await expandWorkflow(w, docs, local!, inner, { wf: x.wf, inputs: { ...defaults, ...given }, prefix: `${label} / `, stage, idPrefix: `${id}/`, depth: x.depth + 1, ...(off ? { off } : {}), extraFiles: [...(x.extraFiles ?? []), file] });
        out.push(...sub.map((s) => ({ ...s, needs: [...new Set([...s.needs, ...needs])] })));
        continue;
      }
      const secretEnv = new Set([...wfEnv.secret, ...jobEnv.secret]);
      const all = new Set([...secrets, ...secretEnv]);
      const ciOnly = new Set([...wfEnv.ciOnly, ...jobEnv.ciOnly]);
      const runDir = isMap(j.doc.defaults) && isMap(j.doc.defaults.run) ? str(j.doc.defaults.run["working-directory"]) : undefined;
      let node: string | undefined;
      const steps: CiStep[] = [];
      for (const s of list(j.doc.steps)) {
        if (!isMap(s)) continue;
        if (decideIf(s.if, ctx) === false) continue;
        const stepEnv = envOf(s.env, ctx, all);
        stepEnv.secret.forEach((k) => (all.add(k), secretEnv.add(k)));
        stepEnv.ciOnly.forEach((k) => ciOnly.add(k));
        const uses = str(s.uses);
        if (uses && /^actions\/setup-node\b/i.test(uses) && isMap(s.with)) {
          const v = s.with["node-version"];
          const f = str(s.with["node-version-file"]);
          node = v !== undefined && v !== null ? fill(String(v), ctx) : f ? (await readText(join(w.top, f)))?.trim().replace(/^v/, "") : node;
        }
        const run = typeof s.run === "string" ? fill(s.run, ctx, all) : undefined;
        const cwd = str(s["working-directory"]) ?? runDir;
        steps.push(classifyStep({ ...(str(s.name) ? { name: fill(str(s.name)!, ctx) } : {}), ...(uses ? { uses } : {}), ...(run !== undefined ? { run } : {}), ...(cwd ? { cwd: fill(cwd, ctx) } : {}), env: stepEnv.env }, [...all], [...ciOnly]));
      }
      const image = isMap(j.doc.container) ? str(j.doc.container.image) : str(j.doc.container);
      if (!node && image) node = /^node:(\d+(?:\.\d+)*)/.exec(image)?.[1];
      const services = isMap(j.doc.services)
        ? Object.entries(j.doc.services).map(([sname, sv]) => {
            const img = isMap(sv) ? str(sv.image) : str(sv);
            const port = isMap(sv) ? strs(sv.ports).map((p) => Number(/^(\d+)(?::\d+)?$/.exec(p.trim())?.[1])).find((n) => n > 0) : undefined;
            return { name: sname, ...(img ? { image: fill(img, ctx) } : {}), ...(port ? { port } : {}) };
          })
        : [];
      out.push({
        ...blankJob({ id, name: label, workflow: x.wf, file, stage, needs, ...(off ? { off } : {}) }),
        ...(node ? { node: node.replace(/\.x$/, "") } : {}),
        services,
        env,
        secrets: [...secretEnv],
        steps,
        scope: [file, ...(x.extraFiles ?? []), ...[...JSON.stringify(j.doc.steps ?? []).matchAll(/hashFiles\(([^)]*)\)/g)].flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!))],
      });
    }
  }
  return out;
}

const blankJob = (o: Pick<CiJob, "id" | "name" | "workflow" | "file" | "stage" | "needs"> & { off?: string; system?: CiJob["system"]; stageName?: string }): CiJob => ({ system: "github", services: [], env: {}, secrets: [], steps: [], scope: [], ...o });

/** .gitlab-ci.yml: stages, jobs (hidden `.templates` and `extends` merged), script, image, services, variables, needs, changes. */
export function gitlabJobs(text: string, file = ".gitlab-ci.yml"): CiJob[] {
  const doc = parseYaml(text);
  if (!isMap(doc)) return [];
  const RESERVED = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "types", "pages"]);
  const stages = strs(doc.stages).length ? strs(doc.stages) : ["build", "test", "deploy"];
  const def = isMap(doc.default) ? doc.default : {};
  const vars = (v: Yaml | undefined) => (isMap(v) ? Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (typeof x === "string" ? [[k, x]] : isMap(x) && typeof x.value === "string" ? [[k, x.value]] : []))) : {});
  const resolveJob = (d: YMap, seen = new Set<YMap>()): YMap => {
    if (seen.has(d)) return d;
    seen.add(d);
    const parents = strs(d.extends).map((n) => doc[n]).filter(isMap);
    return Object.assign({}, ...parents.map((p) => resolveJob(p, seen)), d) as YMap;
  };
  const scriptOf = (v: Yaml | undefined) => list(v).flatMap((x) => (typeof x === "string" ? [x] : Array.isArray(x) ? strs(x) : []));
  const out: CiJob[] = [];
  for (const [id, raw] of Object.entries(doc)) {
    if (RESERVED.has(id) || id.startsWith(".") || !isMap(raw)) continue;
    const d = resolveJob(raw);
    if (!("script" in d) && !("trigger" in d)) continue;
    const stage = str(d.stage) ?? "test";
    const image = str(isMap(d.image) ? d.image.name : d.image) ?? str(isMap(doc.image) ? doc.image.name : doc.image) ?? str(def.image);
    const env = { ...vars(doc.variables), ...vars(d.variables) };
    const before = scriptOf(d.before_script ?? def.before_script ?? doc.before_script);
    const changes = [...list(d.rules).flatMap((r) => (isMap(r) ? strs(r.changes) : [])), ...(isMap(d.only) ? strs(d.only.changes) : [])];
    const manual = d.when === "manual" || list(d.rules).some((r) => isMap(r) && r.when === "manual" && !r.if);
    out.push({
      ...blankJob({ id: `${file}#${id}`, name: id, workflow: "GitLab CI", file, stage: Math.max(0, stages.indexOf(stage)), needs: list(d.needs).flatMap((n) => (typeof n === "string" ? [`${file}#${n}`] : isMap(n) && typeof n.job === "string" ? [`${file}#${n.job}`] : [])), system: "gitlab", stageName: stage, ...(manual ? { off: "Runs only when someone starts it by hand" } : "trigger" in d ? { off: "Starts another pipeline" } : {}) }),
      ...(image && /^node:(\d+)/.test(image) ? { node: /^node:(\d+(?:\.\d+)*)/.exec(image)![1]! } : {}),
      services: list(d.services ?? def.services).flatMap((s) => {
        const n = typeof s === "string" ? s : isMap(s) ? str(s.name) : undefined;
        return n ? [{ name: n.split(":")[0]!.split("/").pop()!, image: n }] : [];
      }),
      env,
      steps: [...before, ...scriptOf(d.script)].map((cmd) => classifyStep({ run: cmd }, [])),
      scope: changes.length ? [] : [file],
      ...(changes.length ? { paths: changes } : {}),
    });
  }
  return out;
}

/** Jenkinsfile (declarative or scripted): each stage and the `sh` commands in it, in order. */
export function jenkinsJobs(text: string, file = "Jenkinsfile"): CiJob[] {
  const marks = [...text.matchAll(/\bstage\s*\(\s*(['"])(.+?)\1\s*\)/g)];
  return marks.map((m, k) => {
    const body = text.slice(m.index! + m[0].length, marks[k + 1]?.index ?? text.length);
    const cmds = [...body.matchAll(/\bsh\s*\(?\s*(?:script:\s*)?('''([\s\S]*?)'''|"""([\s\S]*?)"""|'([^'\n]*)'|"([^"\n]*)")/g)].map((x) => (x[2] ?? x[3] ?? x[4] ?? x[5] ?? "").trim()).filter(Boolean);
    return { ...blankJob({ id: `${file}#${k}`, name: m[2]!, workflow: "Jenkins", file, stage: k, needs: k ? [`${file}#${k - 1}`] : [], system: "jenkins", stageName: m[2]! }), steps: cmds.map((c) => classifyStep({ run: c }, [])), scope: [] };
  });
}

/** .circleci/config.yml: jobs, their `run` steps and docker image, and `requires` from the workflows. */
export function circleJobs(text: string, file = ".circleci/config.yml"): CiJob[] {
  const doc = parseYaml(text);
  if (!isMap(doc) || !isMap(doc.jobs)) return [];
  const requires = new Map<string, string[]>();
  for (const wf of isMap(doc.workflows) ? Object.values(doc.workflows) : []) for (const j of isMap(wf) ? list(wf.jobs) : []) if (isMap(j)) for (const [n, o] of Object.entries(j)) requires.set(n, isMap(o) ? strs(o.requires) : []);
  const depthOf = (n: string, seen = new Set<string>()): number => (seen.has(n) ? 0 : (seen.add(n), Math.max(-1, ...(requires.get(n) ?? []).map((r) => depthOf(r, seen))) + 1));
  return Object.entries(doc.jobs).flatMap(([id, d]) => {
    if (!isMap(d)) return [];
    const image = list(d.docker).map((x) => (isMap(x) ? str(x.image) : undefined)).find(Boolean);
    const steps = list(d.steps).flatMap((s): CiStep[] => {
      if (s === "checkout") return [{ name: "checkout", local: "skip", why: "CI checks out the code; it's already here" }];
      if (!isMap(s) || !("run" in s)) return [];
      const r = s.run;
      return [classifyStep(typeof r === "string" ? { run: r } : isMap(r) ? { ...(str(r.name) ? { name: str(r.name)! } : {}), run: str(r.command) ?? "" } : {}, [])];
    });
    return [{ ...blankJob({ id: `${file}#${id}`, name: id, workflow: "CircleCI", file, stage: depthOf(id), needs: (requires.get(id) ?? []).map((r) => `${file}#${r}`), system: "circleci" }), ...(image && /node:(\d+)/.test(image) ? { node: /node:(\d+(?:\.\d+)*)/.exec(image)![1]! } : {}), steps, scope: [] }];
  });
}

// ---------------- which files make a job matter ----------------

interface Pkg {
  dir: string;
  deps: string[];
}

/** Workspace packages by name: their folder and their workspace dependencies. */
export async function workspacePackages(top: string): Promise<Map<string, Pkg>> {
  const pj = await readText(join(top, "package.json"));
  let patterns: string[] = [];
  try {
    const p = JSON.parse(pj ?? "{}") as { workspaces?: unknown };
    patterns = Array.isArray(p.workspaces) ? (p.workspaces as string[]) : Array.isArray((p.workspaces as { packages?: unknown })?.packages) ? (p.workspaces as { packages: string[] }).packages : [];
  } catch {}
  if (!patterns.length) {
    const y = await readText(join(top, "pnpm-workspace.yaml"));
    const d = y ? parseYaml(y) : null;
    patterns = isMap(d) ? strs(d.packages) : [];
  }
  const dirs: string[] = [];
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.startsWith("!")) continue;
    const pat = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const star = /^(.*?)\/\*{1,2}$/.exec(pat);
    if (!star) dirs.push(pat);
    else for (const e of await readdir(join(top, star[1]!), { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) dirs.push(`${star[1]}/${e.name}`);
  }
  const out = new Map<string, Pkg>();
  for (const dir of dirs) {
    try {
      const p = JSON.parse((await readText(join(top, dir, "package.json"))) ?? "") as Record<string, unknown>;
      if (typeof p.name !== "string") continue;
      const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys((p[k] as Record<string, string> | undefined) ?? {}));
      out.set(p.name, { dir, deps });
    } catch {}
  }
  for (const p of out.values()) p.deps = p.deps.filter((d) => out.has(d));
  return out;
}

/** The folders a job's commands name (pnpm/npm/yarn filters and workspaces, -C, --prefix, cd, working-directory). Empty: every change. */
export function scopeOf(job: CiJob, pkgs: Map<string, Pkg>): string[] {
  const dirs = new Set<string>();
  const withDeps = (name: string, seen = new Set<string>()) => {
    const p = pkgs.get(name);
    if (!p || seen.has(name)) return;
    seen.add(name);
    dirs.add(p.dir);
    p.deps.forEach((d) => withDeps(d, seen));
  };
  const pick = (sel: string) => {
    const s = sel.replace(/^["']|["']$/g, "");
    if (/^\.?\.?\//.test(s) || s.startsWith("{")) return void dirs.add(s.replace(/^\{|\}$/g, "").replace(/^\.\//, "").replace(/\/\.\.\.$/, "").replace(/\/+$/, ""));
    const deps = s.endsWith("...");
    const name = s.replace(/^\.\.\./, "").replace(/\^?\.\.\.$/, "");
    if (deps) withDeps(name);
    else if (pkgs.get(name)) dirs.add(pkgs.get(name)!.dir);
    else for (const [n, p] of pkgs) if (globMatch(name, n)) dirs.add(p.dir);
  };
  for (const st of job.steps) {
    if (st.cwd) dirs.add(st.cwd.replace(/^\.\//, "").replace(/\/+$/, ""));
    const run = st.run ?? "";
    for (const m of run.matchAll(/(?:--filter[= ]|-F |--workspace[= ]|-w )\s*("[^"]+"|'[^']+'|\S+)/g)) pick(m[1]!);
    for (const m of run.matchAll(/(?:^|[\s;&|(])(?:pnpm|npm|yarn)\s+(?:-C|--dir|--prefix|--cwd)[= ]\s*(\S+)/g)) dirs.add(m[1]!.replace(/^\.\//, "").replace(/\/+$/, ""));
    for (const m of run.matchAll(/(?:^|[\s;&|(])cd\s+([^\s;&|)]+)/g)) if (!/^[~$/]/.test(m[1]!) && m[1] !== "..") dirs.add(m[1]!.replace(/^\.\//, "").replace(/\/+$/, ""));
    for (const m of run.matchAll(/(?:^|[\s;&|(])yarn\s+workspace\s+(\S+)/g)) pick(m[1]!);
  }
  dirs.delete("");
  dirs.delete(".");
  return [...dirs].sort();
}

const under = (dir: string, f: string) => f === dir || f.startsWith(`${dir}/`);

const isConfig = (job: CiJob, s: string) => s === job.file || s.startsWith(".github/workflows/");

/** Does this change (repo-relative files) make the job run and matter? `extra`: folders a lesson added. */
export function touches(job: CiJob, files: string[], extra: string[] = []): boolean {
  if (job.off || !files.length) return false;
  if (job.paths?.length && !files.some((f) => anyGlob(job.paths!, f))) return false;
  if (job.pathsIgnore?.length && files.every((f) => anyGlob(job.pathsIgnore!, f))) return false;
  const inputs = [...job.scope.filter((s) => !isConfig(job, s)), ...extra];
  if (!inputs.length) return true; // names no package or input: every change
  const pm = job.steps.some((st) => /\b(pnpm|npm|npx|yarn|bun)\b/.test(st.run ?? ""));
  return files.some((f) => (pm && ROOT_FILES.includes(f)) || job.scope.some((s) => isConfig(job, s) && s === f) || inputs.some((d) => (/[*?]/.test(d) ? globMatch(d, f) : under(d.replace(/\/+$/, ""), f))));
}

// ---------------- run history (gh, reads only) ----------------

export interface RawRun {
  databaseId: number;
  workflowName?: string;
  headSha: string;
  conclusion?: string | null;
  status?: string;
  attempt?: number;
  event?: string;
  createdAt?: string;
}
export interface RawJobRun {
  databaseId?: number;
  name: string;
  conclusion?: string | null;
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}
export interface RunJobs {
  run: RawRun;
  jobs: RawJobRun[];
  before?: RawJobRun[]; // the previous attempt's jobs, for a re-run
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const secsOf = (j: RawJobRun) => (j.startedAt && j.completedAt ? Math.max(0, Math.round((Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 1000)) : undefined);

/** Per job name: runs, fails, flaky (failed then passed on the same commit), median seconds, and the newest failure to read. */
export function historyStats(list: RunJobs[]): Map<string, { runs: number; fails: number; flaky: number; seconds?: number; lastFail?: { run: number; job?: number; at?: string } }> {
  const out = new Map<string, { runs: number; fails: number; flaky: number; secs: number[]; lastFail?: { run: number; job?: number; at?: string } }>();
  const bySha = new Map<string, Map<string, Set<boolean>>>();
  for (const r of [...list].sort((a, b) => Date.parse(b.run.createdAt ?? "0") - Date.parse(a.run.createdAt ?? "0"))) {
    for (const j of r.jobs) {
      if (j.conclusion === "skipped" || j.conclusion === "cancelled" || !j.conclusion) continue;
      const s = out.get(j.name) ?? { runs: 0, fails: 0, flaky: 0, secs: [] };
      out.set(j.name, s);
      s.runs++;
      const failed = FAILED.has(j.conclusion);
      if (failed) {
        s.fails++;
        s.lastFail ??= { run: r.run.databaseId, ...(j.databaseId ? { job: j.databaseId } : {}), ...(r.run.createdAt ? { at: r.run.createdAt } : {}) };
      }
      const t = secsOf(j);
      if (t !== undefined && !failed) s.secs.push(t);
      const prev = r.before?.find((b) => b.name === j.name);
      if (prev && FAILED.has(prev.conclusion ?? "") && j.conclusion === "success") s.flaky++;
      const sha = bySha.get(r.run.headSha) ?? new Map<string, Set<boolean>>();
      bySha.set(r.run.headSha, sha);
      const seen = sha.get(j.name) ?? new Set<boolean>();
      sha.set(j.name, seen);
      if (!seen.has(failed) && seen.size === 1) s.flaky++;
      seen.add(failed);
    }
  }
  return new Map([...out].map(([k, s]) => [k, { runs: s.runs, fails: s.fails, flaky: s.flaky, ...(s.secs.length ? { seconds: s.secs.sort((a, b) => a - b)[Math.floor(s.secs.length / 2)]! } : {}), ...(s.lastFail ? { lastFail: s.lastFail } : {}) }]));
}

const json = <T>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) {
      const i = k++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

export const HISTORY = { list: 20, perWorkflow: 4, failures: 2, view: 20, logs: 6 };

/** Which runs to open: the newest few of each workflow, plus its newest failures, so a busy repo's small workflows don't crowd out CI. */
export function sample(runs: RawRun[]): RawRun[] {
  const by = new Map<string, RawRun[]>();
  for (const r of runs) by.set(r.workflowName ?? "", [...(by.get(r.workflowName ?? "") ?? []), r]);
  const pick = [...by.values()].flatMap((rs) => [...new Set([...rs.slice(0, HISTORY.perWorkflow), ...rs.filter((r) => FAILED.has(r.conclusion ?? "")).slice(0, HISTORY.failures)])]);
  return pick.sort((a, b) => Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0")).slice(0, HISTORY.view);
}

/** Fills job.stats from gh run history. Reads only: run list, run view --json jobs, --log-failed. */
export async function readHistory(gh: Gh, cwd: string, jobs: CiJob[]): Promise<{ runs: number; problem?: string }> {
  const st = await ghStatus(gh, cwd);
  if (!st.ready) return { runs: 0, problem: st.problem === "signed-out" ? "Sign in to GitHub (gh auth login) to read CI history." : "Install GitHub's gh tool to read CI history." };
  const asks = [...new Set(jobs.map((j) => j.workflow))].flatMap((wf) => [[wf, "completed", HISTORY.list], [wf, "failure", 5]] as const); // the newest failures too, so a green streak still teaches
  const lists = await pool(asks, 4, ([wf, status, n]) => gh.run(["run", "list", "--workflow", wf, "--limit", String(n), "--status", status, "--json", "databaseId,workflowName,headSha,conclusion,attempt,event,createdAt"], { cwd }));
  if (lists.length && lists.every((r) => r.code !== 0)) return { runs: 0, problem: "GitHub didn't list this repo's CI runs." };
  const runs = [...new Map(lists.flatMap((r) => json<RawRun[]>(r.stdout) ?? []).map((x) => [x.databaseId, x])).values()].filter((x) => x.conclusion !== "cancelled" && x.conclusion !== "skipped" && (!x.event || /^(pull_request|pull_request_target|push|merge_group)$/.test(x.event)));
  const views = await pool(sample(runs), 4, async (run): Promise<RunJobs> => {
    const v = await gh.run(["run", "view", String(run.databaseId), "--json", "jobs"], { cwd });
    const now = json<{ jobs: RawJobRun[] }>(v.stdout)?.jobs ?? [];
    let before: RawJobRun[] | undefined;
    if ((run.attempt ?? 1) > 1) before = json<{ jobs: RawJobRun[] }>((await gh.run(["run", "view", String(run.databaseId), "--attempt", String(run.attempt! - 1), "--json", "jobs"], { cwd })).stdout)?.jobs;
    return { run, jobs: now, ...(before ? { before } : {}) };
  });
  const stats = historyStats(views);
  const reads: { job: CiJob; at?: string; run: number; id?: number }[] = [];
  for (const j of jobs) {
    const s = stats.get(j.name);
    if (!s) continue;
    j.stats = { runs: s.runs, fails: s.fails, flaky: s.flaky, ...(s.seconds !== undefined ? { seconds: s.seconds } : {}) };
    if (s.lastFail && reads.length < HISTORY.logs) reads.push({ job: j, run: s.lastFail.run, ...(s.lastFail.job ? { id: s.lastFail.job } : {}), ...(s.lastFail.at ? { at: s.lastFail.at } : {}) });
  }
  await pool(reads, 3, async (x) => {
    const log = await gh.run(["run", "view", String(x.run), ...(x.id ? ["--job", String(x.id)] : []), "--log-failed"], { cwd });
    if (log.code !== 0) return;
    const c = classify(cleanLog(log.stdout).lines);
    x.job.stats!.last = { kind: c.kind, line: c.line, ...(x.at ? { at: x.at } : {}) };
  });
  return { runs: runs.length };
}

// ---------------- what kind of failure ----------------

const PREFIX = /^[^\t]*\t[^\t]*\t(?:\S+Z ?)?/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\^\[\[[0-9;]*m/g;

/** A gh --log-failed (or any) log: plain lines, and the command that was running when it failed (`##[group]Run …`). */
export function cleanLog(log: string): { lines: string[]; command?: string } {
  const lines: string[] = [];
  let command: string | undefined;
  let failedAt: string | undefined;
  let echo = false; // inside ##[group]…##[endgroup]: the command and its env, echoed
  for (const raw of log.split(/\r?\n/)) {
    const t = raw.replace(PREFIX, "").replace(ANSI, "").trimEnd();
    const run = /^##\[group\](?:Run )?(.+)$/.exec(t.trim());
    if (run) {
      if (/^##\[group\]Run /.test(t.trim())) command = run[1]!.trim();
      echo = true;
      continue;
    }
    if (/^##\[endgroup\]/.test(t.trim())) {
      echo = false;
      continue;
    }
    if (echo) continue;
    if (!failedAt && /##\[error\]/.test(t) && command) failedAt = command;
    const clean = t.replace(/^\s*##\[(error|warning|group|endgroup)\]/, "").trimEnd();
    if (clean.trim()) lines.push(clean);
  }
  return { lines: lines.slice(-400), ...((failedAt ?? command) ? { command: failedAt ?? command } : {}) };
}

const KINDS: [CiFailureKind, RegExp][] = [
  ["memory", /heap out of memory|JavaScript heap|Reached heap limit|\bSIGABRT\b|\bENOMEM\b|exit code 137|\bKilled\b/i],
  ["install", /ERR_PNPM_(?!RECURSIVE_RUN_FIRST_FAIL|RECURSIVE_EXEC_FIRST_FAIL)[A-Z_]+|npm (ERR!|error) code E(RESOLVE|LOCK|INTEGRITY|NOTFOUND)|Cannot proceed with the frozen installation|lockfile (is )?(out of date|needs to be updated)|Your lockfile needs|yarn.*integrity check failed/i],
  ["secrets", /\bleaks? found\b|gitleaks|secret(s)? (detected|found)|trufflehog/i],
  ["format", /Code style issues|prettier --check|Run Prettier|format:check|not (properly )?formatted|would reformat|gofmt|biome format|dprint check/i],
  ["types", /error TS\d{4}|\bTS\d{4}:|has no exported member|is not assignable to|Cannot find name '|Property '.+' does not exist on type|Type error:/],
  ["lint", /^\s*\d+:\d+\s+(error|✖)\s|✖ \d+ problems?|\beslint\b.*(error|failed)|stylelint|\bruff\b.*error|biome lint|lint(ing)? (errors?|failed)/im],
  ["tests", /^not ok \d+|AssertionError|Tests?:\s+\d+ failed|\d+ (tests? )?fail(ed|ing)\b|^\s*(FAIL|✗|✕|×)\s|expect\(.+\)\.to|vitest|\bjest\b.*fail|pytest|\d+ failed,/im],
  ["schema", /migration|schema\.prisma|prisma (migrate|validate)|drizzle-kit|enum guard|raw sql|schema (drift|mismatch)/i],
  ["env", /environment variable|missing (required )?env|env(ironment)? var\w* (is )?(not set|missing|required)|must be (set|defined)|process\.env\.\w+ is undefined/i],
  ["network", /ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|503 Service|rate limit|getaddrinfo|network (error|timeout)/i],
  ["build", /Build failed|error during build|Rollup failed|webpack.*error|Failed to compile|vite.*error|esbuild.*error/i],
];

export const FIX: Record<CiFailureKind, string> = {
  format: "Run the formatter on the files it names (for example prettier --write), then run the check again.",
  lint: "Fix the rule it names at that line, then run the lint command again until it clears.",
  types: "A type doesn't match. Open the file and line it names. If it says \"has no exported member\" right after bringing in main, rebuild the shared packages first.",
  tests: "A test failed. Run that test here and read the first value that differs from what it expected.",
  build: "The build broke. The first error above the summary names the file.",
  install: "Installing packages the way CI does (frozen lockfile) failed. Run the install command, then commit the updated lockfile.",
  memory: "It ran out of memory, which isn't your code. Give Node more room the way CI does (NODE_OPTIONS=--max-old-space-size=8192).",
  env: "A setting CI has isn't set here, or the other way round. Compare the job's env with yours.",
  schema: "The database schema changed without what CI expects with it, usually a migration. Make the migration and commit it.",
  secrets: "Something in the code looks like a secret. Move it into an env var, and change it if it was real.",
  network: "A download or a service timed out. That's usually flaky: run it again.",
  unknown: "Read the failing lines; the first one usually says why.",
};

export const KIND_WORD: Record<CiFailureKind, string> = { format: "formatting", lint: "a lint rule", types: "a type error", tests: "a failing test", build: "the build", install: "installing packages", memory: "out of memory", env: "a missing setting", schema: "the database schema", secrets: "a secret in the code", network: "the network", unknown: "an error" };

const NOISE = /^(> |npm (ERR|error)! (A complete log|Log files)|Error: Process completed with exit code|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|\s*at .+\(.+:\d+:\d+\)$|.*DeprecationWarning|\(Use `node --trace)/i;

/** The first line that says why, and what kind of failure it is. */
export function classify(lines: string[]): { kind: CiFailureKind; line: string; fix: string } {
  const useful = lines.map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  for (const [kind, re] of KINDS) {
    const line = useful.find((l) => re.test(l));
    if (line) return { kind, line: line.length > 300 ? `${line.slice(0, 299)}…` : line, fix: FIX[kind] };
  }
  const line = useful.find((l) => /\berror\b|\bfail(ed|ure)?\b|✗|✕/i.test(l)) ?? useful.at(-1) ?? "";
  return { kind: "unknown", line: line.slice(0, 300), fix: FIX.unknown };
}

// ---------------- the lessons skill ----------------

export const SKILL_ID = "ci-lessons";
const DRAFT_RUN = "ci-lessons"; // Shrike's own lesson drafts share one run id: one pending at a time, settled by id so an untried draft is never kept

const LegsBlock = z.object({
  legs: z
    .array(
      z.object({
        job: z.string().min(1).max(300),
        run: z.array(z.string().min(1).max(4000)).max(40),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).optional(),
        cwd: z.string().max(500).optional(),
        paths: z.array(z.string().min(1).max(500)).max(50).optional(), // folders a lesson found also matter
      }),
    )
    .max(200),
});
export type Legs = z.infer<typeof LegsBlock>["legs"];

/** The `## Legs` JSON block of a lessons body (validated), or undefined. */
export function legsOf(body: string): Legs | undefined {
  const m = /^## Legs[ \t]*\n[\s\S]*?```(?:json)?\n([\s\S]*?)\n```/m.exec(body);
  if (!m) return undefined;
  const r = LegsBlock.safeParse(json<unknown>(m[1]!));
  return r.success ? r.data.legs : undefined;
}

/** What pre-flight runs for a job, from the CI config. */
export function mapLeg(j: CiJob): Legs[number] {
  return { job: j.name, run: j.steps.filter((s) => s.local === "run" && s.run).map((s) => (s.cwd ? `cd ${s.cwd} && ${s.run}` : s.run!)), ...(Object.keys(j.env).length ? { env: j.env } : {}) };
}

const mins = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

/** The deterministic lessons file body: what Claude starts from, and what's kept when no brain answers. */
export function lessonsBody(project: string, p: CiPipeline, lessons: string[] = []): string {
  const live = p.jobs.filter((j) => !j.off);
  const out = [`# CI lessons for ${project}`, "", `Shrike read ${p.files.join(", ") || "the CI config"}${p.history.runs ? ` and the last ${p.history.runs} CI runs` : ""}. Before you push, run only the jobs your change touches, the way CI runs them. Green here should mean green in CI.`, "", "## Run each job like CI", ""];
  for (const j of live) {
    out.push(`### ${j.name}`, "");
    const dirs = j.scope.filter((s) => !s.startsWith(".github/"));
    out.push(`- In ${j.file} (${j.workflow}). Runs for: ${j.paths?.length ? j.paths.join(", ") : dirs.length ? dirs.join(", ") : "every change"}.`);
    const facts = [j.node ? `Node ${j.node}` : "", Object.keys(j.env).length ? `env ${Object.entries(j.env).map(([k, v]) => `${k}=${v}`).join(" ")}` : "", j.services.length ? `needs ${j.services.map((s) => `${s.image ?? s.name}${s.port ? ` on ${s.port}` : ""}`).join(", ")}` : "", j.secrets.length ? `CI secrets ${j.secrets.join(", ")} (not here)` : ""].filter(Boolean);
    if (facts.length) out.push(`- ${facts.join(". ")}.`);
    const run = j.steps.filter((s) => s.local === "run" && s.run);
    run.forEach((s, k) => out.push(`${k + 1}. \`${firstLine(s.run!)}${s.run!.includes("\n") ? " …" : ""}\`${s.cwd ? ` (in ${s.cwd})` : ""}`));
    const skipped = j.steps.filter((s) => s.local !== "run" && !/checks out the code/.test(s.why ?? ""));
    if (skipped.length) out.push(`- Not run here: ${skipped.map((s) => `${s.name} (${(s.why ?? "").replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())})`).join("; ")}.`);
    if (j.stats?.runs) out.push(`- History: failed ${j.stats.fails} of ${j.stats.runs} runs${j.stats.seconds ? `, about ${mins(j.stats.seconds)}` : ""}${j.stats.flaky ? `. Flaky ${j.stats.flaky} time${j.stats.flaky === 1 ? "" : "s"} (failed, then passed on the same commit)` : ""}.`);
    out.push("");
  }
  const seen = new Map<CiFailureKind, CiJob>();
  for (const j of p.jobs) if (j.stats?.last && !seen.has(j.stats.last.kind)) seen.set(j.stats.last.kind, j);
  out.push("## When CI fails", "");
  if (!seen.size) out.push("- No failures in the runs Shrike read yet.");
  for (const [kind, j] of seen) out.push(`- **${kind}** (seen in ${j.name}: "${j.stats!.last!.line.replace(/"/g, "'").slice(0, 160)}"). ${FIX[kind]}`);
  out.push("", "## Watch out", "");
  const notes = [
    ...p.jobs.filter((j) => j.stats?.flaky).map((j) => `- ${j.name} is flaky: it failed and then passed on the same commit ${j.stats!.flaky} time${j.stats!.flaky === 1 ? "" : "s"}. A red run there may just need a re-run.`),
    ...p.jobs.filter((j) => j.off).map((j) => `- ${j.name}: ${j.off}.`),
    ...live.filter((j) => (j.stats?.seconds ?? 0) >= 300).map((j) => `- ${j.name} is slow (about ${mins(j.stats!.seconds!)}). Run it last.`),
  ];
  out.push(...(notes.length ? notes : ["- Nothing yet."]), "", "## Lessons", "", ...(lessons.length ? lessons.map((l) => `- ${l}`) : ["- None yet. Each time CI disagrees with pre-flight, the difference lands here."]), "", "## Legs", "", "```json", JSON.stringify({ legs: live.map(mapLeg).filter((l) => l.run.length) }, null, 1), "```");
  return out.join("\n");
}

/** Lines under `## Lessons` (bullets, without the placeholder). */
export const lessonsIn = (body: string): string[] =>
  (/^## Lessons[ \t]*\n([\s\S]*?)(?=^## )/m.exec(`${body}\n## `)?.[1] ?? "")
    .split("\n")
    .map((l) => /^- (.+)$/.exec(l.trim())?.[1] ?? "")
    .filter((l) => l && !/^None yet\b/.test(l));

/** What the brain answered, if it's a usable lessons body: no front matter, no wrapping fence, and a valid Legs block. */
export function brainBody(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  let t = text.trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  const fm = frontMatter(t);
  if (fm) t = fm.body.trim();
  t = t.slice(Math.max(0, t.search(/^# /m)));
  return /^# /.test(t) && legsOf(t) && /^## Run each job like CI/m.test(t) ? t.replace(/\s*## Changelog[\s\S]*$/, "").trim() : undefined;
}

// ---------------- running a leg ----------------

export type Runner = (cmd: string, o: { cwd: string; env: Record<string, string>; signal: AbortSignal; onLine(l: string): void; timeoutMs: number }) => Promise<{ code: number | null; output: string; timedOut: boolean }>;

/** A login shell (the user's PATH), its own process group, killed on abort or timeout. */
export const shellRunner: Runner = (cmd, o) =>
  new Promise((done) => {
    const child = spawnShell(cmd, { cwd: o.cwd, env: { ...process.env, ...o.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let part = "";
    let timedOut = false;
    const add = (c: Buffer) => {
      const s = c.toString("utf8");
      output += s;
      if (output.length > 400_000) output = output.slice(-200_000);
      const lines = (part + s).split(/\r?\n/);
      part = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) o.onLine(l);
    };
    const kill = () => killTree(child.pid, "SIGKILL");
    const timer = setTimeout(() => ((timedOut = true), kill()), o.timeoutMs);
    o.signal.addEventListener("abort", kill, { once: true });
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => (clearTimeout(timer), done({ code: 127, output: e.message, timedOut })));
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      done({ code, output, timedOut });
    });
  });

const portOpen = (port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (v: boolean) => (s.destroy(), done(v));
    s.setTimeout(400, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });

const BUILTIN = new Set("cd echo export set unset test true false if then elif else fi for do done while until case esac exit return source . printf mkdir rm cp mv cat ls grep sed awk find xargs env node npm npx pnpm yarn bun bash sh zsh git local read shift wait sleep tee head tail sort uniq cut tr wc tar which trap eval exec time command type pwd touch chmod ln basename dirname date jq".split(" "));
const programs = (cmd: string) => [...new Set(cmd.split(/&&|\|\||[;|\n]/).map((seg) => seg.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/)[0] ?? "").filter((p) => /^[A-Za-z_][\w.-]*$/.test(p) && !BUILTIN.has(p)))];

// ---------------- the service ----------------

export interface CiDeps {
  root(): string | undefined; // the open project
  name(): string | undefined;
  gh: Gh;
  exec: Exec;
  state: string; // userData
  dirs(): SkillDirs;
  emit(s: CiLessonsState): void;
  mastered(e: { job: string; learned: string }): void;
  approve(title: string, reason: string): Promise<boolean>;
  brain?(prompt: string): Promise<string | null>; // one read-only, one-shot call; null when no brain answers
  startAgent(goal: string, opts: AgentOptions): Promise<AgentRunInfo>;
  redact(t: string): string;
  xp(key: string, xp: number, root: string): Promise<void>;
  run?: Runner;
  now?(): number;
  pollMs?: number;
}

interface Saved {
  runs: PreflightRun[];
  files: Record<string, string[]>; // run id → the changed files it looked at
  pushes: { sha: string; result: "clean" | "surprise" | "caught" | "waiting"; at: number }[];
  allowed: string[]; // sha1 of commands the user allowed after an ask
  surprised: Record<string, string>; // job name → the lesson its surprise taught (CI7)
  tried: Record<string, string>; // run id → sha1 of the lessons draft that pre-flight ran
  pipeline?: CiPipeline;
}

const LEG_MS = 20 * 60_000;
const WATCH_MS = 45 * 60_000;
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const legWord = (n: string) => n.replace(/^[^/]+ \/ /, "");
const quote = (s: string, n = 200) => `"${s.replace(/"/g, "'").slice(0, n)}"`;

export function verdictOf(legs: PreflightLeg[]): { safe: boolean; verdict: string } {
  const red = legs.filter((l) => l.state === "fail").length;
  if (red) return { safe: false, verdict: `Fix ${red === 1 ? "1 thing" : `${red} things`} before you push` };
  if (!legs.length) return { safe: true, verdict: "No CI job looks at these files. Safe to push" };
  if (legs.every((l) => l.state === "skipped")) return { safe: false, verdict: "Nothing could run here, so CI is the only check" };
  return { safe: true, verdict: "Safe to push" };
}

/** CI5: local legs vs the hosted jobs of the same commit. Legs that ran and jobs that finished are compared. */
export function compare(legs: PreflightLeg[], hosted: { name: string; state: PrCheck["state"] }[]): { matched: boolean; first?: string; surprises: string[]; caught: string[] } {
  const surprises: string[] = [];
  const caught: string[] = [];
  let first: string | undefined;
  let any = false;
  for (const l of legs) {
    if (l.state !== "pass" && l.state !== "fail") continue;
    const h = hosted.find((x) => x.name === l.name);
    if (!h || (h.state !== "pass" && h.state !== "fail")) continue;
    any = true;
    if (l.state === h.state) {
      if (l.state === "fail") caught.push(l.name);
      continue;
    }
    first ??= l.name;
    if (l.state === "pass") surprises.push(l.name);
  }
  return { matched: any && !first, ...(first ? { first } : {}), surprises, caught };
}

/** Folders of the changed files, for a lesson that a job also matters for them. */
const foldersOf = (files: string[]) => [...new Set(files.map((f) => f.split("/").slice(0, f.split("/").length > 2 ? 2 : 1).join("/")))].slice(0, 12);

/** The lessons body with a job's extra folders in its legs (kept when Claude's rewrite dropped them). */
export function withPaths(body: string, job: string, paths: string[]): string {
  const legs = legsOf(body);
  if (!legs || !paths.length) return body;
  const leg = legs.find((l) => l.job === job);
  if (!leg) return body;
  leg.paths = [...new Set([...(leg.paths ?? []), ...paths])];
  return body.replace(/(^## Legs[ \t]*\n[\s\S]*?```(?:json)?\n)[\s\S]*?(\n```)/m, (_m, a: string, b: string) => `${a}${JSON.stringify({ legs }, null, 1)}${b}`);
}

export function createCiLessons(deps: CiDeps) {
  const now = deps.now ?? Date.now;
  const runner = deps.run ?? shellRunner;
  let busy: CiLessonsState["busy"];
  let note: string | undefined;
  let live: { run: PreflightRun; abort: AbortController; root: string } | undefined;
  let touchCache: { root: string; files: string[]; at: number } | undefined;
  const watching = new Set<string>(); // shas being polled
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const need = () => {
    const r = deps.root();
    if (!r) throw new Error("Open a project first.");
    return r;
  };
  const file = (root: string) => join(deps.state, "ci-lessons", `${sha1(root).slice(0, 16)}.json`);
  async function load(root: string): Promise<Saved> {
    const v = json<Partial<Saved>>((await readText(file(root))) ?? "") ?? {};
    const rec = <T>(x: unknown): Record<string, T> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, T>) : {});
    return {
      runs: Array.isArray(v.runs) ? v.runs.filter((r) => r && typeof r.id === "string" && Array.isArray(r.legs)).slice(-10) : [],
      files: rec<string[]>(v.files),
      pushes: Array.isArray(v.pushes) ? v.pushes.filter((p) => p && typeof p.sha === "string").slice(-20) : [],
      allowed: Array.isArray(v.allowed) ? v.allowed.filter((x) => typeof x === "string").slice(-500) : [],
      surprised: rec<string>(v.surprised),
      tried: rec<string>(v.tried),
      ...(v.pipeline && Array.isArray(v.pipeline.jobs) ? { pipeline: v.pipeline } : {}),
    };
  }
  let saving: Promise<unknown> = Promise.resolve();
  const save = (root: string, fn: (s: Saved) => void): Promise<Saved> => {
    const next = saving.then(async () => {
      const s = await load(root);
      fn(s);
      s.runs = s.runs.slice(-10);
      s.files = Object.fromEntries(Object.entries(s.files).filter(([id]) => s.runs.some((r) => r.id === id)));
      s.tried = Object.fromEntries(Object.entries(s.tried).filter(([id]) => s.runs.some((r) => r.id === id)));
      s.pushes = s.pushes.slice(-20);
      await mkdir(dirname(file(root)), { recursive: true });
      const tmp = `${file(root)}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(s));
      await rename(tmp, file(root));
      return s;
    });
    saving = next.catch(() => {});
    return next;
  };

  const git = async (cwd: string, args: string[]) => {
    const r = await deps.exec("git", args, { cwd });
    return r.code === 0 ? r.stdout.trim() : undefined;
  };
  const topOf = async (root: string) => (await git(root, ["rev-parse", "--show-toplevel"])) ?? root;

  async function where(root: string): Promise<Where> {
    const top = await topOf(root);
    const branch = await git(top, ["branch", "--show-current"]);
    const head = (await git(top, ["rev-parse", "--abbrev-ref", "origin/HEAD"]))?.replace(/^origin\//, "");
    const url = (await git(top, ["remote", "get-url", "origin"])) ?? "";
    const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
    return { top, ...(branch ? { branch } : {}), base: head && head !== "HEAD" ? head : "main", ...(repo ? { repo } : {}) };
  }

  /** CI1: the pipeline from the config, and gh history when asked. */
  async function readPipeline(root: string, history: boolean): Promise<CiPipeline> {
    const w = await where(root);
    const gh = await githubJobs(w);
    const jobs = [...gh.jobs];
    const files = [...gh.files];
    const systems: CiJob["system"][] = gh.jobs.length ? ["github"] : [];
    const others: [string, CiJob["system"], (t: string) => CiJob[]][] = [[".gitlab-ci.yml", "gitlab", gitlabJobs], ["Jenkinsfile", "jenkins", jenkinsJobs], [".circleci/config.yml", "circleci", circleJobs]];
    for (const [f, sys, parse] of others) {
      const t = await readText(join(w.top, f));
      if (!t) continue;
      jobs.push(...parse(t));
      files.push(f);
      systems.push(sys);
    }
    const pkgs = await workspacePackages(w.top);
    for (const j of jobs) j.scope = [...new Set([...j.scope, ...scopeOf(j, pkgs)])];
    const hist = history && systems.includes("github") ? await readHistory(deps.gh, w.top, jobs.filter((j) => j.system === "github")).catch(() => ({ runs: 0, problem: "Couldn't read CI history." })) : { runs: 0 };
    return { systems, files, jobs, history: hist, at: now() };
  }

  async function changed(top: string): Promise<string[]> {
    const w = await where(top);
    const mb = (await git(top, ["merge-base", "HEAD", `origin/${w.base}`])) ?? (await git(top, ["merge-base", "HEAD", w.base]));
    const diff = (await git(top, ["diff", "--name-only", mb ?? "HEAD"])) ?? "";
    const untracked = (await git(top, ["ls-files", "--others", "--exclude-standard"])) ?? "";
    return [...new Set([...diff.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter((f) => f && !f.startsWith(".shrike/")))]; // Shrike's own files aren't the change
  }

  async function skillNow(d: SkillDirs) {
    const skill = (await loadSkills(d).catch(() => [])).find((x) => x.id === SKILL_ID && x.source === "project");
    const draft = skill ? await pendingDraft(d, SKILL_ID, DRAFT_RUN).catch(() => undefined) : undefined;
    return { skill, draft };
  }

  /** The legs to run: the pending draft's (being tried), else the skill's, else the CI config's. */
  async function plan(p: CiPipeline): Promise<{ from: PreflightRun["from"]; legs: Map<string, Legs[number]>; draft?: string }> {
    const { skill, draft } = await skillNow(deps.dirs());
    const fromDraft = draft ? legsOf(draft.after) : undefined;
    const fromSkill = skill ? legsOf(skill.body) : undefined;
    const use = fromDraft ?? fromSkill;
    return { from: fromDraft ? "draft" : fromSkill ? "skill" : "map", legs: new Map(p.jobs.map((j) => [j.id, use?.find((l) => l.job === j.name) ?? mapLeg(j)])), ...(fromDraft ? { draft: sha1(draft!.after) } : {}) };
  }

  async function view(root: string, saved?: Saved): Promise<CiLessonsState> {
    const s = saved ?? (await load(root));
    const p = s.pipeline ?? null;
    let files = touchCache?.root === root && now() - touchCache.at < 3000 ? touchCache.files : undefined;
    if (!files) {
      files = await changed(await topOf(root)).catch(() => [] as string[]);
      touchCache = { root, files, at: now() };
    }
    const { skill, draft } = await skillNow(deps.dirs());
    const legs = p ? (await plan(p)).legs : new Map<string, Legs[number]>();
    const pushes = s.pushes.slice(-8);
    let streak = 0;
    for (const x of [...s.pushes].reverse()) {
      if (x.result === "waiting") continue;
      if (x.result !== "clean") break;
      streak++;
    }
    return {
      ready: !!p?.jobs.length,
      ...(p && !p.jobs.length ? { problem: "Shrike found no CI config it can read here (.github/workflows, .gitlab-ci.yml, Jenkinsfile or .circleci)." } : {}),
      pipeline: p,
      touched: p ? p.jobs.filter((j) => touches(j, files, legs.get(j.id)?.paths)).map((j) => j.id) : [],
      files: files.length,
      run: live?.root === root ? live.run : (s.runs.at(-1) ?? null),
      record: { pushes: pushes.map((x) => x.result), surprises: pushes.filter((x) => x.result === "surprise").length, streak },
      ...(skill ? { skill: { version: skill.version ?? 1, pending: !!draft, lessons: lessonsIn(draft?.after ?? skill.body).length } } : {}),
      ...(busy ? { busy } : {}),
      ...(note ? { note } : {}),
    };
  }

  const push = async (root: string) => {
    if (deps.root() === root) deps.emit(await view(root));
  };

  async function state(o: { refresh?: boolean } = {}): Promise<CiLessonsState> {
    const root = need();
    let s = await load(root);
    if (!s.pipeline || o.refresh) {
      busy = "reading";
      if (s.pipeline) void push(root).catch(() => {});
      try {
        const p = await readPipeline(root, true);
        s = await save(root, (x) => void (x.pipeline = p));
      } finally {
        busy = undefined;
      }
    } else if (now() - s.pipeline.at > 10 * 60_000) void readPipeline(root, true).then((p) => save(root, (x) => void (x.pipeline = p))).then(() => push(root), () => {});
    void resume(root, s).catch(() => {});
    return view(root, s);
  }

  // ---- CI2 / CI8: Claude writes the lessons ----

  async function learn(from: { check?: { name: string; url?: string }; lesson?: string; scope?: { job: string; paths: string[] } } = {}): Promise<CiLessonsState> {
    const root = need();
    if (busy === "learning") throw new Error("Shrike is already writing the CI lessons.");
    busy = "learning";
    note = undefined;
    void push(root).catch(() => {});
    try {
      let s = await load(root);
      if (!s.pipeline) {
        const p = await readPipeline(root, true);
        s = await save(root, (x) => void (x.pipeline = p));
      }
      const p = s.pipeline!;
      const d = deps.dirs();
      const lesson = from.check ? await checkLesson(root, p, from.check) : from.lesson;
      const { skill, draft } = await skillNow(d);
      const current = draft?.after ?? skill?.body;
      const project = deps.name() ?? basename(root);
      let base = lessonsBody(project, p, [...(current ? lessonsIn(current) : []), ...(lesson ? [lesson] : [])]);
      for (const l of (current && legsOf(current)) || []) if (l.paths?.length) base = withPaths(base, l.job, l.paths); // folders earlier lessons added
      if (from.scope) base = withPaths(base, from.scope.job, from.scope.paths);
      const recipe = (await readText(join(d.builtin, `${SKILL_ID}.md`)))?.replace(/^---[\s\S]*?\n---\n/, "").trim() ?? "";
      const runSkill = (await loadSkills(d).catch(() => [])).find((x) => x.kind === "run" && x.source === "project");
      const prompt = deps.redact(
        [
          "You write Shrike's CI lessons for this project. Read only: don't change files and don't propose patches. Answer with the whole file body in markdown and nothing else.",
          recipe,
          `<pipeline-draft>\n${base}\n</pipeline-draft>`,
          runSkill ? `<run-skill name="${runSkill.name}">\n${runSkill.body.slice(0, 6000)}\n</run-skill>` : "",
          current ? `<current-lessons>\n${current.slice(0, 12_000)}\n</current-lessons>` : "",
          lesson ? `<new-lesson>\n${lesson}\n</new-lesson>` : "",
        ].filter(Boolean).join("\n\n"),
      );
      let body = brainBody(await deps.brain?.(prompt).catch(() => null)) ?? base;
      if (from.scope) body = withPaths(body, from.scope.job, from.scope.paths);
      if (!skill) {
        await rescanNow().catch(() => {}); // the project's first look is quiet; the new file after it is news
        const target = join(root, ".shrike", "skills", `${SKILL_ID}.md`);
        await mkdir(dirname(target), { recursive: true });
        const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, `---\nname: CI lessons for ${project}\nwhen: Before you push ${project}, run the CI jobs your change touches here, the way CI runs them\nversion: 1\n---\n\n${body}\n`);
        await rename(tmp, target);
        await rescanNow().catch(() => {}); // [Skill Acquired]
        note = "Wrote the CI lessons. Pre-flight follows them now.";
      } else if (lesson || normal(body) !== normal(current ?? "")) {
        await proposeUpdate(d, { skillId: SKILL_ID, reason: lesson ? lesson.split(/(?<=\.)\s/)[0]! : "re-read the CI config and its latest runs", after: body, runId: DRAFT_RUN });
        note = "Saved as a lesson. The next pre-flight tries it, and Shrike keeps it once CI agrees.";
      } else note = "The CI lessons already say this.";
    } finally {
      busy = undefined;
    }
    await push(root);
    return view(root);
  }
  const normal = (b: string) => b.replace(/\s+/g, " ").trim();

  /** CI8: a failing check's log tail in plain words, tied to its job. */
  async function checkLesson(root: string, p: CiPipeline, check: { name: string; url?: string }): Promise<string> {
    const top = await topOf(root);
    const job = p.jobs.find((j) => j.name === check.name) ?? p.jobs.find((j) => legWord(j.name) === legWord(check.name));
    const m = check.url ? /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(check.url) : null;
    let c: ReturnType<typeof classify> | undefined;
    let command: string | undefined;
    if (m) {
      const r = await deps.gh.run(["run", "view", m[1]!, ...(m[2] ? ["--job", m[2]] : []), "--log-failed"], { cwd: top });
      if (r.code === 0) {
        const log = cleanLog(r.stdout);
        c = classify(log.lines);
        command = log.command;
      }
    }
    return deps.redact(`CI's "${check.name}" check failed on ${KIND_WORD[c?.kind ?? "unknown"]}${c?.line ? ` (${quote(c.line)})` : ""}${command ? ` while running \`${command.slice(0, 160)}\`` : ""}. ${job ? `Pre-flight runs it as the "${legWord(job.name)}" leg.` : "Shrike didn't find this job in the CI config."} ${FIX[c?.kind ?? "unknown"]}`);
  }

  // ---- CI3: pre-flight ----

  async function preflight(): Promise<PreflightRun> {
    const root = need();
    if (live) throw new Error("A pre-flight is already running.");
    let s = await load(root);
    if (!s.pipeline) {
      const p = await readPipeline(root, false);
      s = await save(root, (x) => void (x.pipeline = p));
    }
    const p = s.pipeline!;
    const top = await topOf(root);
    const files = await changed(top).catch(() => [] as string[]);
    touchCache = { root, files, at: now() };
    const { from, legs, draft } = await plan(p);
    const jobs = p.jobs.filter((j) => touches(j, files, legs.get(j.id)?.paths) && legs.get(j.id)!.run.length).sort((a, b) => a.stage - b.stage); // a job with nothing to run here is CI's alone

    const stash = await git(top, ["stash", "create"]); // a commit object of the working tree; no ref, nothing changes
    const tree = await git(top, ["rev-parse", `${stash || "HEAD"}^{tree}`]);
    const sha = await git(top, ["rev-parse", "HEAD"]);
    const branch = await git(top, ["branch", "--show-current"]);
    const run: PreflightRun = { id: randomBytes(6).toString("hex"), at: now(), ...(sha ? { sha } : {}), ...(tree ? { tree } : {}), ...(branch ? { branch } : {}), state: "running", files: files.length, legs: jobs.map((j) => ({ job: j.id, name: j.name, state: "waiting" })), warnings: [], from };
    const abort = new AbortController();
    live = { run, abort, root };
    let last = 0;
    const tick = (force = false) => {
      if (!force && now() - last < 250) return;
      last = now();
      void push(root).catch(() => {});
    };
    tick(true);
    try {
      run.warnings = await warnings(top, jobs);
      const missing = await missingPrograms(top, jobs.flatMap((j) => legs.get(j.id)!.run));
      const fromConfig = new Set(p.jobs.flatMap((j) => [...mapLeg(j).run, ...j.steps.flatMap((st) => (st.run ? [st.run] : []))]));
      const installed = existsSync(join(top, "node_modules"));
      for (let k = 0; k < jobs.length && !abort.signal.aborted; k++) {
        const j = jobs[k]!;
        const leg = run.legs[k]!;
        const l = legs.get(j.id)!;
        const skip = (why: string) => (Object.assign(leg, { state: "skipped", why }), tick(true));
        const cmds = [...(installed ? [] : j.steps.filter((x) => x.local === "prep" && x.run && INSTALL.test(x.run)).map((x) => x.run!)), ...l.run];
        const lacking = cmds.flatMap(programs).find((x) => missing.has(x));
        if (lacking) {
          skip(`Needs ${lacking}, which this computer doesn't have`);
          continue;
        }
        const cwd = resolve(top, l.cwd ?? ".");
        const rel = relative(top, cwd);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          skip("The CI lessons point it outside the project");
          continue;
        }
        const extraEnv = Object.entries(l.env ?? {}).filter(([k, v]) => j.env[k] !== v).map(([k, v]) => `${k}=${v}`);
        const judged = cmds.map((c) => ({ c, j: judge(c, { root: top, cwd }), ours: fromConfig.has(c) }));
        const never = judged.find((x) => x.j.verdict === "never");
        if (never) {
          skip(`Shrike won't run \`${firstLine(never.c).slice(0, 80)}\`: ${never.j.why}`);
          continue;
        }
        const LESSON = "Written in the CI lessons, not in your CI config";
        const asks = [...judged.filter((x) => x.j.verdict === "ask" || !x.ours).map((x) => ({ c: x.c, why: x.ours ? x.j.why : LESSON })), ...(extraEnv.length ? [{ c: `env ${extraEnv.join(" ")}`, why: LESSON }] : [])].filter((x) => !s.allowed.includes(sha1(x.c))); // settings a lesson adds change what a command does, so they ask too
        if (asks.length) {
          Object.assign(leg, { state: "running", why: "Waiting for you to allow it" });
          tick(true);
          const ok = await deps.approve(
            `Run the "${legWord(j.name)}" check here, like CI?`,
            `Pre-flight runs ${asks.length === 1 ? "this command" : "these commands"} in ${relative(top, cwd) || "the project"}:\n\n${asks.map((x) => `${x.c}\n  (${x.why})`).join("\n\n")}`,
          );
          delete leg.why;
          if (!ok) {
            skip("You said not now");
            continue;
          }
          s = await save(root, (x) => void x.allowed.push(...asks.map((a) => sha1(a.c))));
        }
        await runLeg(cwd, j, l, cmds, leg, abort.signal, tick);
        tick(true);
      }
      run.state = abort.signal.aborted ? "stopped" : "done";
      for (const l of run.legs) if (l.state === "waiting" || l.state === "running") Object.assign(l, { state: "skipped", why: "Stopped" });
      Object.assign(run, verdictOf(run.legs));
    } finally {
      live = undefined;
      await save(root, (x) => {
        x.runs.push(run);
        x.files[run.id] = files.slice(0, 500);
        if (draft) x.tried[run.id] = draft;
      }).catch(() => {});
      await push(root).catch(() => {});
    }
    if (run.state === "done") void watchHead(root).catch(() => {});
    return run;
  }

  async function runLeg(cwd: string, j: CiJob, l: Legs[number], cmds: string[], leg: PreflightLeg, signal: AbortSignal, tick: (f?: boolean) => void): Promise<void> {
    const started = now();
    const env: Record<string, string> = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...j.env, ...(l.env ?? {}) };
    Object.assign(leg, { state: "running", tail: [] });
    for (const cmd of cmds) {
      leg.command = firstLine(cmd).slice(0, 200);
      tick(true);
      const r = await runner(cmd, {
        cwd,
        env: { ...env, ...(j.steps.find((x) => x.run === cmd)?.env ?? {}) },
        signal,
        timeoutMs: LEG_MS,
        onLine: (line) => {
          leg.tail = [...(leg.tail ?? []), deps.redact(line.replace(ANSI, "").slice(0, 300))].slice(-3);
          tick();
        },
      });
      if (signal.aborted) return;
      if (r.code === 0 && !r.timedOut) continue;
      const log = cleanLog(r.output);
      const c = classify(log.lines);
      Object.assign(leg, {
        state: "fail",
        kind: c.kind,
        why: r.timedOut ? "taking too long" : KIND_WORD[c.kind],
        line: deps.redact(r.timedOut ? `Still running after ${LEG_MS / 60_000} minutes, so Shrike stopped it` : c.line),
        fix: r.timedOut ? "Run it yourself to see where it hangs." : c.fix,
        tail: log.lines.filter((x) => !NOISE.test(x)).slice(-12).map((x) => deps.redact(x.slice(0, 300))),
        seconds: Math.round((now() - started) / 1000),
      });
      return;
    }
    Object.assign(leg, { state: "pass", seconds: Math.round((now() - started) / 1000) });
    delete leg.tail;
    delete leg.command;
  }

  const quick = (cmd: string, cwd: string) => runner(cmd, { cwd, env: {}, signal: new AbortController().signal, onLine: () => {}, timeoutMs: 15_000 }).catch(() => null);

  async function warnings(top: string, jobs: CiJob[]): Promise<string[]> {
    const out: string[] = [];
    const want = [...new Set(jobs.map((j) => j.node).filter((n): n is string => !!n && /^\d/.test(n)))];
    const have = want.length ? /v?(\d+)\./.exec((await quick("node --version", top))?.output ?? "")?.[1] : undefined;
    for (const w of want) if (have && w.split(".")[0] !== have) out.push(`CI uses Node ${w}, this computer has Node ${have}. Results can differ.`);
    const ports = new Map<number, string>();
    for (const j of jobs) for (const sv of j.services) if (sv.port) ports.set(sv.port, sv.image ?? sv.name);
    for (const [port, what] of ports) if (!(await portOpen(port))) out.push(`CI starts ${what} on port ${port}; nothing answers there here.`);
    const secrets = [...new Set(jobs.flatMap((j) => j.secrets))];
    if (secrets.length) out.push(`CI fills ${secrets.slice(0, 4).join(", ")}${secrets.length > 4 ? " and more" : ""} from its secrets; steps that need them don't run here.`);
    return out;
  }

  async function missingPrograms(top: string, cmds: string[]): Promise<Set<string>> {
    const names = [...new Set(cmds.flatMap(programs))];
    if (!names.length) return new Set();
    const r = await quick(names.map((n) => `command -v ${n} >/dev/null 2>&1 || echo "missing:${n}"`).join("; "), top);
    return new Set([...(r?.output ?? "").matchAll(/missing:([\w.-]+)/g)].map((m) => m[1]!));
  }

  const stop = (): void => live?.abort.abort();

  // ---- CI5: the hosted run of the pushed commit ----

  /** The Changes dock's state: once HEAD is on GitHub, watch CI for it (when pre-flight ran on its tree). */
  function observe(channel: string, payload: unknown): void {
    if (channel !== "scm:update" || !payload || typeof payload !== "object") return;
    const head = (payload as ScmState).commits?.[0];
    const root = deps.root();
    if (root && head?.pushed && !watching.has(head.sha)) void watchHead(root, head.sha).catch(() => {});
  }

  async function watchHead(root: string, pushed?: string): Promise<void> {
    const top = await topOf(root);
    const sha = pushed ?? (await git(top, ["rev-parse", "HEAD"]));
    if (!sha || watching.has(sha) || (!pushed && !(await git(top, ["branch", "-r", "--contains", sha])))) return; // not on GitHub yet: the scm event says when
    const tree = await git(top, ["rev-parse", `${sha}^{tree}`]);
    const run = [...(await load(root)).runs].reverse().find((r) => r.state === "done" && r.tree === tree && !r.hosted);
    if (!run || !tree) return;
    watching.add(sha);
    await save(root, (x) => {
      const r = x.runs.find((y) => y.id === run.id);
      if (r) r.hosted = { sha, state: "waiting", jobs: [] };
      if (!x.pushes.some((q) => q.sha === sha)) x.pushes.push({ sha, result: "waiting", at: now() });
    });
    void push(root).catch(() => {});
    poll(root, top, run.id, sha, now(), 0);
  }

  function poll(root: string, top: string, runId: string, sha: string, since: number, wait = deps.pollMs ?? 60_000): void {
    const t = setTimeout(async () => {
      timers.delete(t);
      try {
        if (await hosted(root, top, runId, sha)) return void watching.delete(sha);
        if (now() - since > WATCH_MS) {
          watching.delete(sha);
          await save(root, (x) => {
            const r = x.runs.find((y) => y.id === runId);
            if (r?.hosted) r.hosted.state = "gave-up";
            x.pushes = x.pushes.filter((q) => q.sha !== sha);
          });
          return void (await push(root).catch(() => {}));
        }
      } catch {}
      poll(root, top, runId, sha, since);
    }, wait);
    t.unref?.();
    timers.add(t);
  }

  /** One look at CI for the commit; true once every run of it finished and the comparison is recorded (and the gate settled). */
  async function hosted(root: string, top: string, runId: string, sha: string): Promise<boolean> {
    const r = await deps.gh.run(["run", "list", "--commit", sha, "--limit", "40", "--json", "databaseId,workflowName,status,conclusion,event"], { cwd: top });
    const runs = (json<RawRun[]>(r.stdout) ?? []).filter((x) => !x.event || /^(pull_request|pull_request_target|push)$/.test(x.event));
    if (!runs.length || runs.some((x) => x.status !== "completed")) return false;
    const views = await pool(runs, 4, async (x) => ({ run: x.databaseId, jobs: json<{ jobs: RawJobRun[] }>((await deps.gh.run(["run", "view", String(x.databaseId), "--json", "jobs"], { cwd: top })).stdout)?.jobs ?? [] }));
    const jobs = views.flatMap((v) => v.jobs.map((j) => ({ ...j, run: v.run })));
    const states = jobs.map((j) => ({ name: j.name, state: (j.conclusion === "success" ? "pass" : FAILED.has(j.conclusion ?? "") ? "fail" : "skipped") as PrCheck["state"] }));
    const saved = await load(root);
    const run = saved.runs.find((x) => x.id === runId);
    if (!run) return true;
    const c = compare(run.legs, states);
    const ran = new Set(run.legs.map((l) => l.name));
    const missed = states.filter((h) => h.state === "fail" && !ran.has(h.name) && saved.pipeline?.jobs.some((j) => j.name === h.name && !j.off && !j.stats?.flaky)).map((h) => h.name); // CI ran it red; pre-flight thought the change didn't touch it
    const agreed = c.matched && !missed.length;
    const first = c.first ?? missed[0];
    const result = c.surprises.length || missed.length ? "surprise" : states.some((h) => h.state === "fail") ? "caught" : "clean";
    run.hosted = { sha, state: "done", jobs: states, matched: agreed, ...(first ? { first } : {}) };
    await save(root, (x) => {
      const y = x.runs.find((z) => z.id === runId);
      if (y) y.hosted = run.hosted;
      const q = x.pushes.find((z) => z.sha === sha);
      if (q) q.result = result;
    });
    await push(root).catch(() => {});
    if (deps.root() !== root) return true; // a gate settles only in its own project
    const d = deps.dirs();
    const cur = (await skillNow(d)).draft;
    const tried = !!cur && saved.tried[runId] === sha1(cur.after); // the gate judges only the draft this pre-flight ran
    if (agreed) {
      if (tried) await settleNow({ expect: "preflight", ok: true, runIds: [DRAFT_RUN] }, d).catch(() => []);
      if ((await skillNow(d)).skill) await noteSkillUse(SKILL_ID).catch(() => {});
      for (const l of run.legs) {
        const learned = saved.surprised[l.name];
        if (!learned || (l.state !== "pass" && l.state !== "fail")) continue;
        deps.mastered({ job: legWord(l.name), learned });
        await save(root, (x) => void delete x.surprised[l.name]);
      }
      if (result === "clean") {
        await deps.xp(`ci-clean:${root}:${sha}`, 15, root).catch(() => {});
        const streak = (await view(root)).record.streak;
        if ([3, 5, 10].includes(streak)) await deps.xp(`ci-streak:${root}:${streak}`, 30, root).catch(() => {});
      }
      return true;
    }
    if (!first) return true; // nothing ran here to compare
    const leg = run.legs.find((l) => l.name === first);
    const why = !leg ? `CI went red on ${legWord(first)}, which pre-flight thought this change doesn't touch` : leg.state === "pass" ? `CI went red on ${legWord(first)} after the pre-flight said green` : `CI passed ${legWord(first)} where the pre-flight failed`;
    if (tried) await settleNow({ expect: "preflight", ok: false, why, runIds: [DRAFT_RUN] }, d).catch(() => []);
    let failLine = "";
    let kind: CiFailureKind | undefined;
    const hj = jobs.find((j) => j.name === first);
    if (hj?.databaseId && (!leg || leg.state === "pass")) {
      const log = await deps.gh.run(["run", "view", String(hj.run), "--job", String(hj.databaseId), "--log-failed"], { cwd: top });
      if (log.code === 0) {
        const cl = classify(cleanLog(log.stdout).lines);
        kind = cl.kind;
        failLine = `${KIND_WORD[cl.kind]}: ${quote(cl.line)}`;
      }
    }
    const job = saved.pipeline?.jobs.find((j) => j.name === first);
    const diffs = [
      ...run.warnings.filter((w) => /Node|port|secrets/.test(w)).map((w) => w.split(/(?<=\.) /)[0]!.replace(/\.$/, "")),
      ...(job ? job.steps.filter((x) => x.local !== "run" && !/checks out|sets up/.test(x.why ?? "")).map((x) => `pre-flight skipped "${x.name}" (${(x.why ?? "").replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())})`) : []),
    ];
    const files = saved.files[runId] ?? [];
    const lesson = deps.redact(
      `${why}${failLine ? ` (${failLine})` : ""}. ${!leg && files.length ? `It also matters for ${foldersOf(files).join(", ")}, so pre-flight runs it for those now.` : diffs.length ? `What differs here: ${diffs.slice(0, 4).join("; ")}.` : "Nothing in the config explains it, so it may be flaky or depend on the CI machine."}`,
    );
    const learned = !leg && files.length ? `it matters for ${foldersOf(files).slice(0, 3).join(", ")} too` : kind && kind !== "unknown" ? `pre-flight catches ${KIND_WORD[kind]} here now, before CI does` : "pre-flight and CI see the same thing now";
    if (!leg || leg.state === "pass") await save(root, (x) => void (x.surprised[first] = learned)); // CI7 says it once they agree
    await learn({ lesson, ...(!leg && files.length ? { scope: { job: first, paths: foldersOf(files) } } : {}) }).catch(() => {});
    return true;
  }

  async function resume(root: string, s: Saved): Promise<void> {
    const top = await topOf(root);
    for (const r of s.runs) if (r.hosted?.state === "waiting" && !watching.has(r.hosted.sha)) (watching.add(r.hosted.sha), poll(root, top, r.id, r.hosted.sha, r.at, 0));
  }

  // ---- CI4: Fix it ----

  async function fix(jobId: string): Promise<AgentRunInfo> {
    const root = need();
    const run = live?.run ?? (await load(root)).runs.at(-1);
    const leg = run?.legs.find((l) => l.job === jobId);
    if (!leg || leg.state !== "fail") throw new Error("That check isn't red in the last pre-flight.");
    const goal = [
      `Pre-flight ran the CI job "${leg.name}" on this computer, the way CI runs it, and it failed on ${KIND_WORD[leg.kind ?? "unknown"]}.`,
      leg.command ? `The command: ${leg.command}` : "",
      leg.line ? `The first problem it printed: ${leg.line}` : "",
      leg.tail?.length ? `Its last lines:\n${leg.tail.join("\n")}` : "",
      `What usually fixes it: ${leg.fix ?? FIX.unknown}`,
      "Find the cause in the code and propose the smallest fix with propose_patch. Pre-flight runs the job again after.",
    ].filter(Boolean).join("\n\n");
    return deps.startAgent(deps.redact(goal), (await skillNow(deps.dirs())).skill ? { skillId: SKILL_ID } : {});
  }

  /** The MCP tool: run pre-flight and say what happened. */
  async function hostText(): Promise<string> {
    const r = await preflight();
    if (!r.legs.length) return `${r.verdict}. ${r.files} changed files; no CI job looks at them.`;
    const say = (l: PreflightLeg) =>
      l.state === "pass" ? `✓ ${l.name}: passed${l.seconds !== undefined ? ` in ${l.seconds}s` : ""}`
      : l.state === "fail" ? [`✗ ${l.name}: failed on ${l.why}. ${l.line ?? ""}`, l.command ? `  command: ${l.command}` : "", l.tail?.length ? `  last lines:\n  ${l.tail.slice(-8).join("\n  ")}` : "", `  fix: ${l.fix}`].filter(Boolean).join("\n")
      : `– ${l.name}: skipped (${l.why})`;
    return [`Pre-flight on ${r.files} changed files${r.from === "map" ? "" : ` (legs from the CI lessons${r.from === "draft" ? " draft being tried" : ""})`}:`, ...r.legs.map(say), ...r.warnings.map((w) => `Note: ${w}`), `${r.verdict}.`].join("\n");
  }

  const dispose = () => {
    stop();
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  return { state, learn: (from?: { check: string; url?: string }) => learn(from ? { check: { name: from.check, ...(from.url ? { url: from.url } : {}) } } : {}), preflight, stop, fix, observe, hostText, dispose, hosted, learnLesson: learn };
}

export type CiLessons = ReturnType<typeof createCiLessons>;
