// AP20 to AP22: the Routes page's data. Finds an OpenAPI spec with no config (repo files, then the app's own
// well-known URLs on its local address), turns it into RouteDocs, merges them with scanned routes and accepted guesses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { ApiRequest, JsonSchema, Route, RouteDoc, RouteGuess, RouteParam, RouteResponse } from "@shrike/schema";
import { redactText } from "@shrike/redact";
import { blankRequest } from "./collections.ts";
import { colonPath, pathParamsOf, skeleton } from "./import.ts";
import { parseYaml } from "./yaml.ts";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const json = (v: unknown) => JSON.stringify(v, null, 2);

// ---- discovery ----

export const SPEC_FILE = /^(?:openapi|swagger)\.(?:json|ya?ml)$|\.openapi\.(?:json|ya?ml)$/i;
const SKIP = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "out", ".next", "__pycache__", ".shrike", ".claude", "coverage", "target", "vendor"]);

/** Spec files in the repo, shallowest first (three folders deep at most). */
export function findSpecFiles(root: string, depth = 3): string[] {
  const out: string[] = [];
  let budget = 4000; // ponytail: a huge monorepo stops early; upgrade: `git ls-files`
  const walk = (dir: string, d: number) => {
    let ents: import("node:fs").Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const e of ents) {
      if (--budget < 0) return;
      if (e.isFile() && SPEC_FILE.test(e.name)) out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
      else if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) dirs.push(e.name);
    }
    if (d < depth) for (const n of dirs.sort()) walk(join(dir, n), d + 1);
  };
  walk(root, 0);
  return out;
}

/** FastAPI, NestJS (two setups), plain swagger, Spring. */
export const SPEC_PATHS = ["/openapi.json", "/api-json", "/docs-json", "/swagger.json", "/v3/api-docs"];
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

/** The first well-known path on the app's own local address that answers with a spec. Never another host. */
export async function fetchSpec(base: string | undefined, f: typeof fetch = fetch, timeoutMs = 1500): Promise<{ from: string; spec: Obj } | undefined> {
  let origin: URL;
  try {
    origin = new URL(base ?? "");
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(origin.protocol) || !LOOPBACK.test(origin.hostname)) return undefined;
  for (const p of SPEC_PATHS) {
    const url = `${origin.origin}${p}`;
    try {
      const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 5 * 1024 * 1024) continue;
      const spec = parseSpec(text);
      if (spec) return { from: url, spec };
    } catch {}
  }
  return undefined;
}

/** JSON or YAML that is an OpenAPI or Swagger document, else undefined. */
export function parseSpec(text: string): Obj | undefined {
  try {
    const t = text.trim();
    const v = o(t.startsWith("{") ? JSON.parse(t) : parseYaml(t));
    return v.openapi || v.swagger ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The first readable spec file in the repo. */
export function specFromFiles(root: string): { from: string; spec: Obj } | undefined {
  for (const rel of findSpecFiles(root)) {
    try {
      const abs = join(root, rel);
      if (statSync(abs).size > 5 * 1024 * 1024) continue;
      const spec = parseSpec(readFileSync(abs, "utf8"));
      if (spec) return { from: rel, spec };
    } catch {}
  }
  return undefined;
}

// ---- OpenAPI 3 to RouteDocs ----

function resolveRef(ref: string, root: Obj): Obj {
  return o(ref.slice(2).split("/").reduce<unknown>((cur, k) => o(cur)[k.replace(/~1/g, "/").replace(/~0/g, "~")], root));
}

/** $refs inlined and allOf merged, so the page and the body check need nothing else. Cycles stop at their name. */
export function deref(schema: unknown, root: Obj, seen: string[] = []): JsonSchema {
  const s = o(schema);
  const ref = str(s.$ref);
  if (ref.startsWith("#/")) {
    const name = ref.split("/").pop()!;
    if (seen.includes(ref) || seen.length > 8) return { type: "object", title: name };
    return { title: name, ...deref(resolveRef(ref, root), root, [...seen, ref]) };
  }
  const out: JsonSchema = { ...s };
  if (Array.isArray(s.allOf)) {
    delete out.allOf;
    for (const part of s.allOf.map((p) => deref(p, root, seen))) {
      out.properties = { ...o(out.properties), ...o(part.properties) };
      out.required = [...new Set([...a(out.required), ...a(part.required)])];
      if (part.type && !out.type) out.type = part.type;
    }
  }
  if (out.properties) out.properties = Object.fromEntries(Object.entries(o(out.properties)).map(([k, v]) => [k, deref(v, root, seen)]));
  if (s.items) out.items = deref(s.items, root, seen);
  for (const k of ["oneOf", "anyOf"] as const) if (Array.isArray(s[k])) out[k] = s[k].map((p) => deref(p, root, seen));
  if (s.additionalProperties && typeof s.additionalProperties === "object") out.additionalProperties = deref(s.additionalProperties, root, seen);
  return out;
}

const typeOf = (s: Obj): string | undefined => {
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null").join(" or ") : str(s.type);
  if (!t) return Array.isArray(s.anyOf) ? s.anyOf.map((x) => typeOf(o(x))).filter(Boolean).join(" or ") || undefined : undefined;
  return t === "array" ? `${typeOf(o(s.items)) ?? "any"}[]` : s.format ? `${t} (${str(s.format)})` : t;
};

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const firstSegment = (path: string) => path.split("/").filter((x) => x && x !== "api" && !x.startsWith(":") && !/^v\d+$/.test(x))[0] ?? "other";

function contentExample(c: Obj, root: Obj): string | undefined {
  const ex = c.example ?? o(Object.values(o(c.examples))[0]).value;
  const v = ex !== undefined ? ex : c.schema ? skeleton(deref(c.schema, root), root) : undefined;
  return v === undefined ? undefined : typeof v === "string" ? v : json(v);
}

export function specDocs(spec: Obj): { routes: RouteDoc[]; title?: string; version?: string } {
  if (!/^3\./.test(str(spec.openapi))) throw new Error(spec.swagger ? "it's Swagger 2, and Shrike reads OpenAPI 3" : "it isn't an OpenAPI 3 document");
  const info = o(spec.info);
  let prefix = "";
  try {
    prefix = new URL(str(o(a(spec.servers)[0]).url) || "/", "http://x").pathname.replace(/\/$/, "");
  } catch {}
  const routes: RouteDoc[] = [];
  for (const [rawPath, itemRaw] of Object.entries(o(spec.paths))) {
    const item = o(itemRaw);
    const shared = a(item.parameters);
    for (const m of METHODS) {
      const op = o(item[m]);
      if (!Object.keys(op).length) continue;
      const path = colonPath(prefix + rawPath);
      const params: RouteParam[] = [];
      for (const raw of [...shared, ...a(op.parameters)]) {
        const p = o(raw).$ref ? resolveRef(str(o(raw).$ref), spec) : o(raw);
        if (!["path", "query", "header"].includes(str(p.in))) continue;
        const sch = deref(p.schema, spec);
        const ex = p.example ?? sch.example ?? sch.default;
        const at = params.findIndex((x) => x.name === str(p.name) && x.in === p.in);
        const param: RouteParam = {
          name: str(p.name),
          in: p.in as RouteParam["in"],
          required: p.in === "path" || p.required === true,
          ...(typeOf(sch) ? { type: typeOf(sch) } : {}),
          ...(Array.isArray(sch.enum) ? { enum: sch.enum.map(str) } : {}),
          ...(p.description ? { description: str(p.description) } : {}),
          ...(ex !== undefined ? { example: str(ex) } : {}),
        };
        if (at >= 0) params[at] = param; // the operation's own wins over the path's shared one
        else params.push(param);
      }
      const content = o(o(op.requestBody).content);
      const ct = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
      const body = ct
        ? {
            contentType: ct,
            required: o(op.requestBody).required === true,
            ...(o(content[ct]).schema ? { schema: deref(o(content[ct]).schema, spec) } : {}),
            ...(contentExample(o(content[ct]), spec) !== undefined ? { example: contentExample(o(content[ct]), spec)! } : {}),
          }
        : undefined;
      const responses: RouteResponse[] = Object.entries(o(op.responses)).map(([status, r0]) => {
        const r = o(r0).$ref ? resolveRef(str(o(r0).$ref), spec) : o(r0);
        const rc = o(r.content);
        const rct = Object.keys(rc).find((k) => /json/.test(k)) ?? Object.keys(rc)[0];
        const c = rct ? o(rc[rct]) : {};
        return { status, ...(r.description ? { description: str(r.description) } : {}), ...(c.schema ? { schema: deref(c.schema, spec) } : {}), ...(rct && contentExample(c, spec) !== undefined ? { example: contentExample(c, spec)! } : {}) };
      });
      routes.push({
        method: m.toUpperCase(),
        path,
        tag: Array.isArray(op.tags) && op.tags.length ? str(op.tags[0]) : firstSegment(path),
        sources: ["spec"],
        ...(op.summary ? { summary: str(op.summary) } : {}),
        ...(op.description ? { description: str(op.description) } : {}),
        ...(op.deprecated === true ? { deprecated: true } : {}),
        params,
        ...(body ? { body } : {}),
        responses,
      });
    }
  }
  return { routes, ...(info.title ? { title: str(info.title) } : {}), ...(info.version ? { version: str(info.version) } : {}) };
}

// ---- merge ----

/** "GET /orders/{id}" and "get /orders/:order_id/" are the same route. */
export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${colonPath(path).replace(/\/:[^/]+/g, "/:").replace(/(.)\/$/, "$1")}`;
const pathParams = (path: string): RouteParam[] => [...path.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => ({ name: m[1]!, in: "path", required: true }));

/** Spec first, then the code scan's handler, then the user's accepted guesses for what the spec doesn't cover. */
export function mergeRoutes(spec: RouteDoc[], scanned: Route[], guesses: RouteGuess[]): RouteDoc[] {
  const byKey = new Map<string, RouteDoc>();
  for (const d of spec) byKey.set(routeKey(d.method, d.path), { ...d, sources: [...d.sources] });
  for (const r of scanned) {
    const method = r.method.toUpperCase() === "ALL" || r.method === "*" ? "GET" : r.method.toUpperCase();
    const path = colonPath(r.path);
    const k = routeKey(method, path);
    const hit = byKey.get(k);
    if (hit) {
      if (!hit.sources.includes("code")) hit.sources.push("code");
      if (r.handler && !hit.handler) hit.handler = r.handler;
    } else byKey.set(k, { method, path, tag: firstSegment(path), sources: ["code"], params: pathParams(path), responses: [], ...(r.handler ? { handler: r.handler } : {}) });
  }
  for (const g of guesses) {
    const k = routeKey(g.method, g.path);
    const hit = byKey.get(k);
    if (hit?.sources.includes("spec")) continue; // the spec is exact; a guess never overrides it
    const base = hit ?? { method: g.method.toUpperCase(), path: colonPath(g.path), tag: firstSegment(colonPath(g.path)), sources: [], params: [], responses: [] };
    byKey.set(k, {
      ...base,
      sources: [...base.sources.filter((s) => s !== "guess"), "guess"],
      ...(g.summary ? { summary: g.summary } : {}),
      params: [...base.params.filter((p) => !g.params.some((x) => x.name === p.name && x.in === p.in)), ...g.params],
      ...(g.body ? { body: { contentType: "application/json", required: true, schema: g.body.schema, example: g.body.example } } : {}),
      responses: g.responses,
    });
  }
  return [...byKey.values()].sort((x, y) => x.tag.localeCompare(y.tag) || x.path.localeCompare(y.path) || METHODS.indexOf(x.method.toLowerCase()) - METHODS.indexOf(y.method.toLowerCase()));
}

/** Examples and words from a spec or the agent pass through redaction before the page shows them. */
export function redactDoc<T extends RouteDoc | RouteGuess>(d: T): T {
  const r = (s: string | undefined) => (s === undefined ? s : redactText(s));
  const out = { ...d, params: d.params.map((p) => ({ ...p, ...(p.example !== undefined ? { example: r(p.example) } : {}) })), responses: d.responses.map((x) => ({ ...x, ...(x.example !== undefined ? { example: r(x.example) } : {}) })) } as T;
  if (d.body?.example !== undefined) (out as { body: { example?: string } }).body = { ...d.body, example: r(d.body.example) };
  return out;
}

// ---- AP22: guesses from the handler code ----

/** A JSON schema a body check can use, from an example the agent wrote: types from the values, required from its list. */
export function schemaFromExample(v: unknown, required?: string[]): JsonSchema {
  if (Array.isArray(v)) return { type: "array", ...(v.length ? { items: schemaFromExample(v[0]) } : {}) };
  if (v === null) return {};
  if (typeof v === "object") {
    const props = Object.fromEntries(Object.entries(v as Obj).map(([k, x]) => [k, schemaFromExample(x)]));
    return { type: "object", properties: props, ...(required?.length ? { required: required.filter((k) => k in props) } : {}) };
  }
  return { type: typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "boolean" ? "boolean" : "string" };
}

const short = (n: number) => z.string().trim().max(n);
const paramZ = z.object({
  name: short(200).min(1),
  in: z.enum(["path", "query", "header"]),
  required: z.boolean().optional(),
  type: short(60).optional(),
  enum: z.array(short(200)).max(50).optional(),
  description: short(500).optional(),
  example: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
});
/** What the agent must answer with. Anything else is dropped, never shown. */
export const guessReplyZ = z.object({
  routes: z
    .array(
      z.object({
        method: z.string().regex(/^[A-Za-z]{3,7}$/),
        path: short(500).regex(/^\//),
        summary: short(300).optional(),
        params: z.array(paramZ).max(40).default([]),
        body: z.object({ example: z.unknown(), required: z.array(short(200)).max(100).optional() }).nullish(),
        responses: z.array(z.object({ status: z.union([z.string().regex(/^([1-5]\d\d|[1-5]XX|default)$/), z.number().int().min(100).max(599)]), description: short(500).optional(), example: z.unknown().optional() })).max(20).default([]),
      }),
    )
    .max(100),
});

export function guessPrompt(routes: { method: string; path: string; handler?: { file: string; line: number } }[]): string {
  return [
    "Fill in examples for these API routes from their handler code. Only read: use read_file and search_code. Don't send requests, don't save requests, don't change any file and don't propose patches.",
    "Routes:",
    ...routes.map((r) => `- ${r.method} ${r.path}${r.handler ? ` (handler at ${r.handler.file}:${r.handler.line})` : ""}`),
    "For each route, read the handler and work out: the path, query and header params it reads; the JSON body it expects, with field names exactly as the code reads them and realistic values; which body fields it needs; and the responses it can send (status, a short description, an example body).",
    "Only include what the code shows. Leave out a route you can't find.",
    'End your answer with one ```json block and nothing after it, shaped like: {"routes":[{"method":"POST","path":"/v1/users","summary":"Creates a user","params":[{"name":"id","in":"path","required":true,"type":"string","example":"1"}],"body":{"example":{"email":"sam@example.com"},"required":["email"]},"responses":[{"status":"201","description":"Created","example":{"id":1}}]}]}',
  ].join("\n");
}

/** The agent's last JSON block, validated, cut to the routes that were asked about, redacted. */
export function parseGuesses(text: string, asked: { method: string; path: string }[]): RouteGuess[] {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const raw = blocks.at(-1) ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Your agent's answer had no examples Shrike could read. Try again.");
  }
  const parsed = guessReplyZ.safeParse(value);
  if (!parsed.success) throw new Error("Your agent's answer wasn't in the shape Shrike asked for. Try again.");
  const want = new Map(asked.map((r) => [routeKey(r.method, r.path), r]));
  const out: RouteGuess[] = [];
  for (const g of parsed.data.routes) {
    const ask = want.get(routeKey(g.method, g.path));
    if (!ask || out.some((x) => routeKey(x.method, x.path) === routeKey(g.method, g.path))) continue;
    const ex = (v: unknown) => (v === undefined ? undefined : typeof v === "string" ? v : json(v));
    const bodyText = g.body && g.body.example !== undefined ? ex(g.body.example)! : undefined;
    if (bodyText !== undefined && bodyText.length > 64 * 1024) continue;
    out.push(
      redactDoc({
        method: ask.method.toUpperCase(),
        path: colonPath(ask.path),
        ...(g.summary ? { summary: g.summary } : {}),
        params: g.params.map((p) => ({ name: p.name, in: p.in, required: p.in === "path" || p.required === true, ...(p.type ? { type: p.type } : {}), ...(p.enum ? { enum: p.enum } : {}), ...(p.description ? { description: p.description } : {}), ...(p.example !== undefined ? { example: String(p.example) } : {}) })),
        ...(bodyText !== undefined ? { body: { example: bodyText, schema: schemaFromExample(g.body!.example, g.body!.required) } } : {}),
        responses: g.responses.map((r) => ({ status: String(r.status), ...(r.description ? { description: r.description } : {}), ...(r.example !== undefined ? { example: ex(r.example)!.slice(0, 64 * 1024) } : {}) })),
      }),
    );
  }
  return out;
}

/** An accepted guess as a request in the project's collection: relative URL, example values, a docs note saying where it came from. */
export function guessRequest(g: RouteGuess): ApiRequest {
  const val = (p: RouteParam) => p.example ?? "";
  const lines = [`Guessed from code by your agent. Check it against the handler before you rely on it.`, g.summary ?? "", ...g.responses.map((r) => `- ${r.status}${r.description ? `: ${r.description}` : ""}`)].filter(Boolean);
  return blankRequest({
    name: `${g.method} ${g.path}`,
    method: g.method,
    url: g.path,
    params: g.params.filter((p) => p.in === "query").map((p) => ({ name: p.name, value: val(p), enabled: p.required })),
    pathParams: pathParamsOf(g.path, g.params.filter((p) => p.in === "path").map((p) => ({ name: p.name, value: val(p), enabled: true }))),
    headers: g.params.filter((p) => p.in === "header").map((p) => ({ name: p.name, value: val(p), enabled: p.required })),
    body: g.body ? { type: "json", data: g.body.example } : { type: "none" },
    docs: lines.join("\n"),
  });
}
