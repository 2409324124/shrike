// Bru lang (Bruno's legacy collection format): parse into blocks, keep every block's raw text, re-render only what changed.
import type { ApiAssertion, ApiAuth, ApiBody, ApiEnvironment, ApiKv, ApiRequest } from "@shrike/schema";

export interface BruPair {
  key: string;
  value: string;
  enabled: boolean;
}
export interface BruBlock {
  name: string;
  raw: string;
  kind: "dict" | "text" | "list";
  pairs: BruPair[];
  text: string;
  items: string[];
}
export type BruDoc = (string | BruBlock)[]; // strings are the gaps between blocks, so serialize(parse(x)) === x

const DICT_BODIES = new Set(["body:form-urlencoded", "body:multipart-form", "body:file"]);
const isText = (name: string) => (name.startsWith("body:") && !DICT_BODIES.has(name)) || name.startsWith("script:") || name === "tests" || name === "docs";
const START = /^([A-Za-z][\w:.-]*)[ \t]*([{[])[ \t]*$/gm;

export function parseBru(src: string): BruDoc {
  const doc: BruDoc = [];
  let pos = 0;
  START.lastIndex = 0;
  for (let m = START.exec(src); m; m = START.exec(src)) {
    const close = m[2] === "{" ? "}" : "]";
    const after = m.index + m[0].length;
    const end = new RegExp(`^\\${close}[ \\t]*$`, "m").exec(src.slice(after));
    if (!end) break;
    const stop = after + end.index + end[0].length;
    doc.push(src.slice(pos, m.index));
    doc.push(block(m[1]!, src.slice(m.index, stop), src.slice(after + 1, after + end.index).replace(/\n$/, ""), m[2] === "[" ? "list" : isText(m[1]!) ? "text" : "dict"));
    pos = stop;
    START.lastIndex = stop;
  }
  doc.push(src.slice(pos));
  return doc;
}

export const serializeBru = (doc: BruDoc) => doc.map((p) => (typeof p === "string" ? p : p.raw)).join("");

function block(name: string, raw: string, inner: string, kind: BruBlock["kind"]): BruBlock {
  const b: BruBlock = { name, raw, kind, pairs: [], text: "", items: [] };
  const lines = inner === "" ? [] : inner.split("\n");
  if (kind === "text") b.text = lines.map((l) => l.replace(/^ {1,2}/, "")).join("\n");
  else if (kind === "list") b.items = lines.map((l) => l.trim().replace(/,$/, "")).filter(Boolean);
  else {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (!t) continue;
      const enabled = !t.startsWith("~");
      const s = enabled ? t : t.slice(1);
      const k = s.indexOf(":");
      if (k < 0) continue;
      let value = s.slice(k + 1).trim();
      if (value === "'''") {
        const body: string[] = [];
        while (++i < lines.length && lines[i]!.trim() !== "'''") body.push(lines[i]!.replace(/^ {1,4}/, ""));
        value = body.join("\n");
      }
      b.pairs.push({ key: s.slice(0, k).trim(), value, enabled });
    }
  }
  return b;
}

const indent = (s: string) => s.split("\n").map((l) => `  ${l}`).join("\n");

export function renderBlock(name: string, content: BruPair[] | string | string[]): BruBlock {
  let inner: string;
  if (typeof content === "string") inner = content === "" ? "" : `${indent(content)}\n`;
  else if (typeof content[0] === "string" || (Array.isArray(content) && name.endsWith(":secret"))) {
    const items = content as string[];
    const raw = `${name} [\n${items.map((x, k) => `  ${x}${k < items.length - 1 ? "," : ""}`).join("\n")}${items.length ? "\n" : ""}]`;
    return block(name, raw, raw.slice(name.length + 3, -2), "list");
  } else {
    inner = (content as BruPair[])
      .map((p) => {
        const head = `  ${p.enabled ? "" : "~"}${p.key}: `;
        return p.value.includes("\n") ? `${head}'''\n${p.value.split("\n").map((l) => `    ${l}`).join("\n")}\n  '''` : head + p.value;
      })
      .join("\n");
    if (inner) inner += "\n";
  }
  const raw = `${name} {\n${inner}}`;
  return block(name, raw, inner.replace(/\n$/, ""), typeof content === "string" ? "text" : "dict");
}

// ---- requests ----

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace", "connect"];
const BODY_MODE: Record<ApiBody["type"], string> = { none: "none", json: "json", text: "text", xml: "xml", "form-urlencoded": "formUrlEncoded", multipart: "multipartForm", graphql: "graphql" };
const kv = (pairs: BruPair[] = []): ApiKv[] => pairs.map((p) => ({ name: p.key, value: p.value, enabled: p.enabled }));
const pairs = (rows: ApiKv[]): BruPair[] => rows.map((r) => ({ key: r.name, value: r.value, enabled: r.enabled }));
const get = (b: BruBlock | undefined, key: string) => b?.pairs.find((p) => p.key === key)?.value;
const blocks = (doc: BruDoc) => doc.filter((p): p is BruBlock => typeof p !== "string");

export function authFrom(mode: string | undefined, find: (name: string) => BruBlock | undefined): ApiAuth {
  if (mode === "none") return { type: "none" };
  if (mode === "bearer") return { type: "bearer", token: get(find("auth:bearer"), "token") ?? "" };
  if (mode === "basic") return { type: "basic", username: get(find("auth:basic"), "username") ?? "", password: get(find("auth:basic"), "password") ?? "" };
  if (mode === "apikey") {
    const b = find("auth:apikey");
    return { type: "apikey", key: get(b, "key") ?? "", value: get(b, "value") ?? "", placement: get(b, "placement") === "queryparams" || get(b, "placement") === "query" ? "query" : "header" };
  }
  return { type: "inherit" }; // inherit, or a mode Shrike doesn't send (oauth2, awsv4, digest...): kept in the file untouched
}

function authBlocks(a: ApiAuth): BruBlock[] {
  if (a.type === "bearer") return [renderBlock("auth:bearer", [{ key: "token", value: a.token, enabled: true }])];
  if (a.type === "basic") return [renderBlock("auth:basic", [{ key: "username", value: a.username, enabled: true }, { key: "password", value: a.password, enabled: true }])];
  if (a.type === "apikey") return [renderBlock("auth:apikey", [{ key: "key", value: a.key, enabled: true }, { key: "value", value: a.value, enabled: true }, { key: "placement", value: a.placement === "query" ? "queryparams" : "header", enabled: true }])];
  return [];
}

export function bruToRequest(doc: BruDoc, path = ""): ApiRequest {
  const bs = blocks(doc);
  const find = (n: string) => bs.find((b) => b.name === n);
  const meta = find("meta");
  const http = bs.find((b) => METHODS.includes(b.name));
  const mode = get(http, "body") ?? "none";
  let body: ApiBody = { type: "none" };
  if (mode === "json" || mode === "text" || mode === "xml") body = { type: mode, data: find(`body:${mode}`)?.text ?? "" };
  else if (mode === "formUrlEncoded") body = { type: "form-urlencoded", fields: kv(find("body:form-urlencoded")?.pairs) };
  else if (mode === "multipartForm")
    body = {
      type: "multipart",
      fields: (find("body:multipart-form")?.pairs ?? []).map((p) => {
        const f = /^@file\((.*)\)$/.exec(p.value);
        return f ? { name: p.key, value: f[1]!, enabled: p.enabled, file: true } : { name: p.key, value: p.value, enabled: p.enabled };
      }),
    };
  else if (mode === "graphql") body = { type: "graphql", query: find("body:graphql")?.text ?? "", variables: find("body:graphql:vars")?.text ?? "" };
  const settings: ApiRequest["settings"] = {};
  for (const p of find("settings")?.pairs ?? []) {
    if (p.key === "encodeUrl") settings.encodeUrl = p.value === "true";
    if (p.key === "followRedirects") settings.followRedirects = p.value === "true";
    if (p.key === "maxRedirects" && Number.isFinite(+p.value)) settings.maxRedirects = +p.value;
    if (p.key === "timeout" && +p.value > 0) settings.timeoutMs = +p.value;
  }
  const scripts: ApiRequest["scripts"] = {};
  if (find("script:pre-request")) scripts.pre = find("script:pre-request")!.text;
  if (find("script:post-response")) scripts.post = find("script:post-response")!.text;
  if (find("tests")) scripts.tests = find("tests")!.text;
  const seq = Number(get(meta, "seq"));
  const req: ApiRequest = {
    path,
    name: get(meta, "name") ?? "Untitled",
    method: (http?.name ?? "get").toUpperCase(),
    url: get(http, "url") ?? "",
    params: kv(find("params:query")?.pairs),
    pathParams: kv(find("params:path")?.pairs),
    headers: kv(find("headers")?.pairs),
    body,
    auth: authFrom(get(http, "auth"), find),
    vars: { pre: kv(find("vars:pre-request")?.pairs), post: kv(find("vars:post-response")?.pairs) },
    assertions: (find("assert")?.pairs ?? []).map((p): ApiAssertion => {
      const k = p.value.indexOf(" ");
      return { expr: p.key, op: k < 0 ? p.value : p.value.slice(0, k), value: k < 0 ? "" : p.value.slice(k + 1), enabled: p.enabled };
    }),
    scripts,
    settings,
  };
  if (Number.isFinite(seq)) req.seq = seq;
  if (find("docs")) req.docs = find("docs")!.text;
  return req;
}

// Groups of blocks that change together. An unchanged group keeps its original bytes.
type Group = { owns: (name: string) => boolean; render: (r: ApiRequest, orig: BruBlock[]) => BruBlock[]; same: (a: ApiRequest, b: ApiRequest) => boolean };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const merge = (orig: BruBlock | undefined, set: Record<string, string | undefined>): BruPair[] => {
  const out = (orig?.pairs ?? []).filter((p) => !(p.key in set) || set[p.key] !== undefined).map((p) => (p.key in set ? { ...p, value: set[p.key]! } : p));
  for (const [key, value] of Object.entries(set)) if (value !== undefined && !out.some((p) => p.key === key)) out.push({ key, value, enabled: true });
  return out;
};
const dict = (name: string, rows: ApiKv[]) => (rows.length ? [renderBlock(name, pairs(rows))] : []);
const text = (name: string, s: string | undefined) => (s === undefined ? [] : [renderBlock(name, s)]);

const GROUPS: Group[] = [
  {
    owns: (n) => n === "meta",
    same: (a, b) => a.name === b.name && a.seq === b.seq,
    render: (r, o) => [renderBlock("meta", merge(o[0], { name: r.name, type: get(o[0], "type") ?? "http", seq: r.seq === undefined ? undefined : String(r.seq) }))],
  },
  {
    owns: (n) => METHODS.includes(n),
    same: (a, b) => a.method === b.method && a.url === b.url && a.body.type === b.body.type && eq(a.auth.type, b.auth.type),
    render: (r, o) => {
      const keepAuth = o[0] && r.auth.type === "inherit" && !["inherit", "none", "bearer", "basic", "apikey"].includes(get(o[0], "auth") ?? "inherit");
      return [renderBlock(r.method.toLowerCase(), merge(o[0], { url: r.url, body: BODY_MODE[r.body.type], auth: keepAuth ? get(o[0], "auth") : r.auth.type }))];
    },
  },
  { owns: (n) => n === "params:query", same: (a, b) => eq(a.params, b.params), render: (r) => dict("params:query", r.params) },
  { owns: (n) => n === "params:path", same: (a, b) => eq(a.pathParams, b.pathParams), render: (r) => dict("params:path", r.pathParams) },
  { owns: (n) => n === "headers", same: (a, b) => eq(a.headers, b.headers), render: (r) => dict("headers", r.headers) },
  { owns: (n) => ["auth:bearer", "auth:basic", "auth:apikey"].includes(n), same: (a, b) => eq(a.auth, b.auth), render: (r) => authBlocks(r.auth) },
  {
    owns: (n) => n.startsWith("body:"),
    same: (a, b) => eq(a.body, b.body),
    render: (r) => {
      const b = r.body;
      if (b.type === "json" || b.type === "text" || b.type === "xml") return [renderBlock(`body:${b.type}`, b.data)];
      if (b.type === "form-urlencoded") return [renderBlock("body:form-urlencoded", pairs(b.fields))];
      if (b.type === "multipart") return [renderBlock("body:multipart-form", b.fields.map((f) => ({ key: f.name, value: f.file ? `@file(${f.value})` : f.value, enabled: f.enabled })))];
      if (b.type === "graphql") return [renderBlock("body:graphql", b.query), ...(b.variables ? [renderBlock("body:graphql:vars", b.variables)] : [])];
      return [];
    },
  },
  { owns: (n) => n === "vars:pre-request", same: (a, b) => eq(a.vars.pre, b.vars.pre), render: (r) => dict("vars:pre-request", r.vars.pre) },
  { owns: (n) => n === "vars:post-response", same: (a, b) => eq(a.vars.post, b.vars.post), render: (r) => dict("vars:post-response", r.vars.post) },
  {
    owns: (n) => n === "assert",
    same: (a, b) => eq(a.assertions, b.assertions),
    render: (r) => (r.assertions.length ? [renderBlock("assert", r.assertions.map((x) => ({ key: x.expr, value: x.value ? `${x.op} ${x.value}` : x.op, enabled: x.enabled })))] : []),
  },
  { owns: (n) => n === "script:pre-request", same: (a, b) => a.scripts.pre === b.scripts.pre, render: (r) => text("script:pre-request", r.scripts.pre) },
  { owns: (n) => n === "script:post-response", same: (a, b) => a.scripts.post === b.scripts.post, render: (r) => text("script:post-response", r.scripts.post) },
  { owns: (n) => n === "tests", same: (a, b) => a.scripts.tests === b.scripts.tests, render: (r) => text("tests", r.scripts.tests) },
  {
    owns: (n) => n === "settings",
    same: (a, b) => eq({ ...a.settings, verifyTls: 0 }, { ...b.settings, verifyTls: 0 }),
    render: (r, o) => {
      const s = r.settings;
      const set = { encodeUrl: s.encodeUrl === undefined ? undefined : String(s.encodeUrl), timeout: s.timeoutMs === undefined ? undefined : String(s.timeoutMs), followRedirects: s.followRedirects === undefined ? undefined : String(s.followRedirects), maxRedirects: s.maxRedirects === undefined ? undefined : String(s.maxRedirects) };
      const p = merge(o[0], set);
      return p.length ? [renderBlock("settings", p)] : [];
    },
  },
  { owns: (n) => n === "docs", same: (a, b) => a.docs === b.docs, render: (r) => text("docs", r.docs) },
];

/** ponytail: settings.verifyTls is send-time only; Bru has no per-request TLS key. */
export function requestToBru(req: ApiRequest, original?: string): string {
  const doc = original ? parseBru(original) : [];
  const before = original ? bruToRequest(doc, req.path) : undefined;
  const out: BruDoc = [];
  const done = new Set<Group>();
  for (const part of doc) {
    const g = typeof part === "string" ? undefined : GROUPS.find((x) => x.owns(part.name));
    if (!g || (before && g.same(before, req))) {
      out.push(part);
      continue;
    }
    if (done.has(g)) {
      if (typeof out[out.length - 1] === "string") out.pop();
      continue;
    }
    done.add(g);
    const fresh = g.render(req, blocks(doc).filter((b) => g.owns(b.name)));
    if (!fresh.length && typeof out[out.length - 1] === "string") out.pop();
    fresh.forEach((b, k) => out.push(...(k ? ["\n\n", b] : [b])));
  }
  for (const g of GROUPS) {
    if (done.has(g) || (before && g.same(before, req))) continue;
    for (const b of g.render(req, [])) {
      const last = out[out.length - 1];
      if (out.length && !(typeof last === "string" && last.endsWith("\n\n"))) out.push(typeof last === "string" && last.endsWith("\n") ? "\n" : "\n\n");
      out.push(b);
    }
  }
  const s = serializeBru(out);
  return s.endsWith("\n") ? s : `${s}\n`;
}

// ---- collection.bru, folder.bru, environments/*.bru ----

export interface BruDefaults {
  name?: string;
  seq?: number;
  headers: ApiKv[];
  auth: ApiAuth;
  vars: ApiKv[];
}

export function bruToDefaults(src: string): BruDefaults {
  const bs = blocks(parseBru(src));
  const find = (n: string) => bs.find((b) => b.name === n);
  const meta = find("meta");
  const out: BruDefaults = { headers: kv(find("headers")?.pairs), auth: authFrom(get(find("auth"), "mode"), find), vars: kv(find("vars:pre-request")?.pairs) };
  if (get(meta, "name")) out.name = get(meta, "name");
  if (Number.isFinite(Number(get(meta, "seq")))) out.seq = Number(get(meta, "seq"));
  return out;
}

export function defaultsToBru(d: BruDefaults, original = ""): string {
  const doc = parseBru(original);
  const before = original ? bruToDefaults(original) : undefined;
  const fresh: [string, BruBlock[], boolean][] = [
    ["meta", d.name === undefined ? [] : [renderBlock("meta", merge(blocks(doc).find((b) => b.name === "meta"), { name: d.name, seq: d.seq === undefined ? undefined : String(d.seq) }))], !!before && before.name === d.name && before.seq === d.seq],
    ["headers", dict("headers", d.headers), !!before && eq(before.headers, d.headers)],
    ["auth", [renderBlock("auth", [{ key: "mode", value: d.auth.type, enabled: true }]), ...authBlocks(d.auth)], !!before && eq(before.auth, d.auth)],
    ["vars:pre-request", dict("vars:pre-request", d.vars), !!before && eq(before.vars, d.vars)],
  ];
  const owns = (n: string) => (n === "auth" || n.startsWith("auth:") ? "auth" : n);
  const out: BruDoc = [];
  const placed = new Set<string>();
  for (const part of doc) {
    const f = typeof part === "string" ? undefined : fresh.find(([n]) => n === owns(part.name));
    if (!f || f[2]) {
      out.push(part);
      continue;
    }
    if (placed.has(f[0])) {
      if (typeof out[out.length - 1] === "string") out.pop();
      continue;
    }
    placed.add(f[0]);
    if (!f[1].length && typeof out[out.length - 1] === "string") out.pop();
    f[1].forEach((b, k) => out.push(...(k ? ["\n\n", b] : [b])));
  }
  for (const [n, bs, same] of fresh) {
    if (placed.has(n) || same) continue;
    for (const b of bs) out.push(...(out.length ? ["\n\n", b] : [b]));
  }
  const s = serializeBru(out);
  return s.endsWith("\n") ? s : `${s}\n`;
}

export function bruToEnv(name: string, src: string): ApiEnvironment {
  const bs = blocks(parseBru(src));
  const secret = bs.find((b) => b.name === "vars:secret")?.items ?? [];
  const vars = kv(bs.find((b) => b.name === "vars")?.pairs);
  for (const s of secret) {
    const off = s.startsWith("~");
    const n = off ? s.slice(1) : s;
    if (!vars.some((v) => v.name === n)) vars.push({ name: n, value: "", enabled: !off, secret: true });
  }
  return { name, vars };
}

/** Secret values are never written: they go in vars:secret by name only. */
export function envToBru(env: ApiEnvironment): string {
  const plain = env.vars.filter((v) => !v.secret);
  const secret = env.vars.filter((v) => v.secret).map((v) => (v.enabled ? v.name : `~${v.name}`));
  const parts = [renderBlock("vars", pairs(plain)).raw];
  if (secret.length) parts.push(renderBlock("vars:secret", secret).raw);
  return `${parts.join("\n\n")}\n`;
}
