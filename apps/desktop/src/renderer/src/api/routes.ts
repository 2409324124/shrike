import type { JsonSchema, RouteDoc } from "@shrike/schema";
import { blankReq, fromRoute, hasBody, routePattern, row, splitUrl, tryJson, uid, urlWithParams, type Captured, type Req } from "./model.ts";

// AP20 to AP23: the Routes page's pure helpers. Main finds and merges the routes (main/api/routes.ts).

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const pathOnly = (url: string) => splitUrl(url).base.replace(/^\{\{[^}]+\}\}/, "").replace(/^[a-z]+:\/\/[^/]*/i, "") || "/";

/** The route a request goes to, by method and path: "/orders/5" finds "/orders/:order_id". */
export function docFor(routes: RouteDoc[] | undefined, method: string, url: string): RouteDoc | undefined {
  const p = pathOnly(url);
  return routes?.find((r) => r.method === method.toUpperCase() && routePattern(r.path).test(p));
}

/** Shrike captured a call to this route. */
export const seenIn = (r: RouteDoc, calls: Captured[]): boolean => calls.some((c) => c.method.toUpperCase() === r.method && routePattern(r.path).test(pathOnly(c.url)));

export function groupRoutes(routes: RouteDoc[], needle: string): { tag: string; routes: RouteDoc[] }[] {
  const q = needle.trim().toLowerCase();
  const hit = (r: RouteDoc) => !q || `${r.method} ${r.path} ${r.summary ?? ""} ${r.tag}`.toLowerCase().includes(q);
  const out: { tag: string; routes: RouteDoc[] }[] = [];
  for (const r of routes.filter(hit)) {
    const g = out.find((x) => x.tag === r.tag);
    if (g) g.routes.push(r);
    else out.push({ tag: r.tag, routes: [r] });
  }
  return out;
}

export interface SchemaRow {
  name: string;
  depth: number;
  type?: string;
  required: boolean;
  enum?: string[];
  description?: string;
}

export function typeWord(s: Obj): string | undefined {
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join(" or ") : typeof s.type === "string" ? s.type : "";
  if (t === "array") return `${typeWord(o(s.items)) ?? "any"}[]`;
  if (t) return `${t}${s.format ? ` (${String(s.format)})` : ""}`;
  const alts = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (Array.isArray(alts)) return alts.map((x) => typeWord(o(x)) ?? "any").join(" or ");
  return s.properties ? "object" : typeof s.title === "string" ? s.title : undefined;
}

/** One row per field, nested fields indented, for AP-schema. */
export function schemaRows(schema: JsonSchema | undefined, max = 200): SchemaRow[] {
  const out: SchemaRow[] = [];
  const walk = (s: Obj, d: number) => {
    const t = s.items ? o(s.items) : s; // a list of objects shows the object's fields
    const req = new Set(Array.isArray(t.required) ? (t.required as string[]) : []);
    for (const [name, raw] of Object.entries(o(t.properties))) {
      if (out.length >= max || d > 6) return;
      const p = o(raw);
      const type = typeWord(p);
      out.push({ name, depth: d, ...(type ? { type } : {}), required: req.has(name), ...(Array.isArray(p.enum) ? { enum: p.enum.map(String) } : {}), ...(typeof p.description === "string" ? { description: p.description } : {}) });
      walk(p, d + 1);
    }
  };
  walk(o(schema), 0);
  return out;
}

const WORD: Record<string, string> = { string: "text", integer: "a whole number", number: "a number", boolean: "true or false", object: "an object", array: "a list", null: "empty (null)" };
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const edits = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
};
const near = (name: string, options: string[]) => {
  const n = name.toLowerCase();
  return options.find((k) => k.toLowerCase() === n) ?? options.find((k) => k.toLowerCase().startsWith(n) || n.startsWith(k.toLowerCase())) ?? options.find((k) => edits(n, k.toLowerCase()) <= 2);
};

/** AP23: plain-words differences between a JSON body and the route's schema. Advice only: sending is never blocked. */
export function checkBody(schema: JsonSchema | undefined, value: unknown): string[] {
  const out: string[] = [];
  const walk = (s: Obj, v: unknown, at: string) => {
    if (out.length >= 20 || s.oneOf || s.anyOf) return; // ponytail: unions aren't checked; upgrade: try each branch
    const types = (Array.isArray(s.type) ? s.type : typeof s.type === "string" ? [s.type] : s.properties ? ["object"] : []) as string[];
    const k = kind(v);
    if (v === null && (s.nullable === true || types.includes("null"))) return;
    if (types.length && !types.includes(k) && !(k === "integer" && types.includes("number"))) {
      const want = types.filter((t) => t !== "null").map((t) => WORD[t] ?? t).join(" or ");
      out.push(`${at || "The body"} should be ${want}, not ${k === "integer" ? "a number" : (WORD[k] ?? k)}.`);
      return;
    }
    if (Array.isArray(s.enum) && s.enum.length && !s.enum.some((e) => e === v)) out.push(`${at || "The body"} should be one of ${s.enum.map(String).join(", ")}.`);
    if (k === "array" && s.items) (v as unknown[]).slice(0, 50).forEach((x, i) => walk(o(s.items), x, `${at}[${i}]`));
    if (k !== "object") return;
    const props = o(s.properties);
    const obj = v as Obj;
    const names = Object.keys(props);
    const pre = at ? `${at}.` : "";
    for (const r of Array.isArray(s.required) ? (s.required as string[]) : []) if (!(r in obj)) out.push(`${pre}${r} is missing. The API needs it.`);
    for (const [name, x] of Object.entries(obj)) {
      if (name in props) walk(o(props[name]), x, `${pre}${name}`);
      else if (names.length && s.additionalProperties !== true && typeof s.additionalProperties !== "object") {
        const guess = near(name, names.filter((n) => !(n in obj)));
        out.push(`${pre}${name} isn't a field the API knows${guess ? `. Did you mean ${guess}?` : "."}`);
      }
    }
  };
  if (schema) walk(o(schema), value, "");
  return out;
}

const firstOk = (r: RouteDoc) => r.responses.find((x) => /^2\d\d$/.test(x.status))?.status ?? "200";

/** "Try it": the spec's or the guess's examples first, else the last real call (AP2), else an empty object. */
export function reqFromDoc(r: RouteDoc, calls: Captured[] = []): Req {
  const base = fromRoute({ method: r.method, path: r.path }, calls);
  const example = (name: string) => r.params.find((p) => p.name === name && p.in === "path")?.example ?? "";
  const pathVals = Object.fromEntries(Object.entries(base.pathVals).map(([k, v]) => [k, v || example(k)]));
  const params = r.params.filter((p) => p.in === "query").map((p) => row(p.name, p.example ?? "", p.required));
  const headers = r.params.filter((p) => p.in === "header").map((p) => row(p.name, p.example ?? "", p.required));
  const text = r.body?.example;
  const json = tryJson(text);
  const body = !hasBody(r.method) || text === undefined ? base.body : { ...base.body, mode: json !== undefined ? ("json" as const) : ("text" as const), text: json !== undefined ? JSON.stringify(json, null, 2) : text };
  const docs = [r.summary, r.description].filter(Boolean).join("\n\n");
  return blankReq({ ...base, url: urlWithParams(r.path, params), params, pathVals, headers, body, docs });
}

/** "Save as test": Try it's request plus res.status eq the first 2xx the route documents. */
export const testFromDoc = (r: RouteDoc, calls: Captured[] = []): Req => ({ ...reqFromDoc(r, calls), asserts: [{ id: uid(), expr: "res.status", op: "eq", value: firstOk(r), on: true }] });
