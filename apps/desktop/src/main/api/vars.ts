import { randomInt, randomUUID } from "node:crypto";
import type { ApiKv } from "@shrike/schema";

export type Scope = Record<string, string>;

/** Lowest precedence first, like Bruno: collection < environment < folders (outer to inner) < request < runtime. */
export function scopeOf(...layers: (ApiKv[] | Scope | undefined)[]): Scope {
  const out: Scope = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (Array.isArray(layer)) for (const v of layer) v.enabled && v.name && (out[v.name] = interpolate(v.value, out));
    else Object.assign(out, layer);
  }
  return out;
}

const BUILTIN: Record<string, () => string> = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomUUID: () => randomUUID(),
  $guid: () => randomUUID(),
  $randomInt: () => String(randomInt(0, 1000)),
};

/** {{name}} from the scope, {{$builtin}}; unknown names stay as typed so the user sees what's missing. */
export function interpolate(s: string, scope: Scope, depth = 0): string {
  if (!s.includes("{{")) return s;
  const out = s.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, name: string) => (Object.hasOwn(scope, name) ? scope[name]! : BUILTIN[name]?.() ?? m));
  return depth < 3 && out !== s && /\{\{[^{}\s]+\}\}/.test(out) ? interpolate(out, scope, depth + 1) : out;
}

export const unresolved = (s: string) => [...s.matchAll(/\{\{\s*([^{}\s$]+)\s*\}\}/g)].map((m) => m[1]!);

export interface ResLike {
  status: number;
  headers: Record<string, string>;
  body: unknown; // parsed JSON when it parses, else text
  responseTime: number;
}

/** res.status, res.body.items[0].id, res.body["a.b"], res.headers.content-type, res.responseTime. Returns undefined when the path misses. */
export function evalPath(expr: string, res: ResLike): unknown {
  const e = expr.trim();
  const m = /^res(?:\.(status|statusCode|responseTime|headers|body))?(.*)$/.exec(e);
  if (!m) return undefined;
  const root = m[1];
  if (root === "status" || root === "statusCode") return m[2] ? undefined : res.status;
  if (root === "responseTime") return m[2] ? undefined : res.responseTime;
  if (root === "headers") {
    const name = m[2]!.replace(/^\./, "").replace(/^\[["'](.*)["']\]$/, "$1").toLowerCase();
    if (!name) return res.headers;
    return Object.entries(res.headers).find(([k]) => k.toLowerCase() === name)?.[1];
  }
  if (!root) return m[2] ? undefined : res;
  let cur: unknown = res.body;
  for (const seg of segments(m[2]!)) {
    if (cur === null || cur === undefined) return undefined;
    if (seg === "length" && (Array.isArray(cur) || typeof cur === "string")) cur = cur.length;
    else if (typeof cur === "object" && Object.hasOwn(cur as object, seg)) cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function segments(path: string): string[] {
  const out: string[] = [];
  const re = /\.([^.[\]]+)|\[\s*(-?\d+)\s*\]|\[\s*["']([^"']*)["']\s*\]/g;
  let at = 0;
  for (let m = re.exec(path); m; m = re.exec(path)) {
    if (m.index !== at) throw new Error(`Can't read the path "${path}".`);
    out.push(m[1] ?? m[2] ?? m[3]!);
    at = re.lastIndex;
  }
  if (at !== path.length) throw new Error(`Can't read the path "${path}".`);
  return out;
}

export const asText = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
