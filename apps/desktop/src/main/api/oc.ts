// OpenCollection YAML (Bruno 3.1+ default): <name>.yml requests, folder.yml, opencollection.yml.
// Writes patch only the groups that changed, so unknown keys and untouched values keep their bytes.
import type { ApiAuth, ApiBody, ApiEnvironment, ApiKv, ApiRequest } from "@shrike/schema";
import { parseYaml, stringifyYaml, type Yaml } from "./yaml.ts";
import type { BruDefaults } from "./bru.ts";

type Obj = { [k: string]: Yaml };
const obj = (v: Yaml | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v: Yaml | undefined): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const s = (v: Yaml | undefined) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const kv = (rows: Obj[]): ApiKv[] => rows.map((r) => ({ name: s(r.name), value: varValue(r.value), enabled: r.disabled !== true }));
const varValue = (v: Yaml | undefined) => (v && typeof v === "object" && !Array.isArray(v) ? s(v.data) : s(v));
const rows = (list: ApiKv[], extra: (r: ApiKv) => Obj = () => ({})): Obj[] => list.map((r) => ({ name: r.name, value: r.value, ...extra(r), ...(r.enabled ? {} : { disabled: true }) }));

export function authFromOc(v: Yaml | undefined): ApiAuth {
  if (v === "none") return { type: "none" };
  const a = obj(v);
  if (a.type === "bearer") return { type: "bearer", token: s(a.token) };
  if (a.type === "basic") return { type: "basic", username: s(a.username), password: s(a.password) };
  if (a.type === "apikey") return { type: "apikey", key: s(a.key), value: s(a.value), placement: a.placement === "query" ? "query" : "header" };
  return { type: "inherit" }; // inherit, or oauth2/awsv4/digest...: kept in the file untouched
}
const authToOc = (a: ApiAuth): Yaml => (a.type === "inherit" || a.type === "none" ? a.type : { ...a });

export function ocToRequest(src: string, path = ""): ApiRequest {
  const doc = obj(parseYaml(src));
  const info = obj(doc.info);
  const gql = info.type === "graphql";
  const http = obj(gql ? doc.graphql : doc.http);
  const rt = obj(doc.runtime);
  const params = arr(http.params);
  const b = http.body;
  let body: ApiBody = { type: "none" };
  if (gql) body = { type: "graphql", query: s(obj(b).query), variables: s(obj(b).variables) };
  else if (b && typeof b === "object" && !Array.isArray(b)) {
    const t = b.type;
    if (t === "json" || t === "text" || t === "xml") body = { type: t, data: s(b.data) };
    else if (t === "form-urlencoded") body = { type: "form-urlencoded", fields: kv(arr(b.data)) };
    else if (t === "multipart-form")
      body = { type: "multipart", fields: arr(b.data).map((r) => ({ name: s(r.name), value: Array.isArray(r.value) ? r.value.map(s).join("|") : s(r.value), enabled: r.disabled !== true, ...(r.type === "file" ? { file: true } : {}) })) };
  }
  const set = obj(doc.settings);
  const settings: ApiRequest["settings"] = {};
  if (typeof set.encodeUrl === "boolean") settings.encodeUrl = set.encodeUrl;
  if (typeof set.followRedirects === "boolean") settings.followRedirects = set.followRedirects;
  if (typeof set.maxRedirects === "number") settings.maxRedirects = set.maxRedirects;
  if (typeof set.timeout === "number" && set.timeout > 0) settings.timeoutMs = set.timeout;
  const scripts: ApiRequest["scripts"] = {};
  for (const sc of arr(rt.scripts)) {
    if (sc.type === "before-request") scripts.pre = s(sc.code);
    if (sc.type === "after-response") scripts.post = s(sc.code);
    if (sc.type === "tests") scripts.tests = s(sc.code);
  }
  const req: ApiRequest = {
    path,
    name: s(info.name) || "Untitled",
    method: (s(http.method) || (gql ? "POST" : "GET")).toUpperCase(),
    url: s(http.url),
    params: kv(params.filter((p) => p.type !== "path")),
    pathParams: kv(params.filter((p) => p.type === "path")),
    headers: kv(arr(http.headers)),
    body,
    auth: authFromOc(http.auth),
    vars: {
      pre: kv(arr(rt.variables)),
      post: arr(rt.actions)
        .filter((a) => a.type === "set-variable" && a.phase !== "before-request")
        .map((a) => ({ name: s(a.variable), value: s(obj(a.selector).expression), enabled: a.disabled !== true })),
    },
    assertions: arr(rt.assertions).map((a) => ({ expr: s(a.expression), op: s(a.operator), value: s(a.value), enabled: a.disabled !== true })),
    scripts,
    settings,
  };
  if (typeof info.seq === "number") req.seq = info.seq;
  if (doc.docs !== undefined) req.docs = typeof doc.docs === "string" ? doc.docs : s(obj(doc.docs).content);
  return req;
}

const put = (o: Obj, key: string, v: Yaml | undefined, keepEmpty = key in o) => {
  if (v === undefined || (!keepEmpty && Array.isArray(v) && !v.length)) delete o[key];
  else o[key] = v;
};

/** ponytail: settings.verifyTls is send-time only; OpenCollection has no per-request TLS key. */
export function requestToOc(req: ApiRequest, original?: string): string {
  const before = original ? ocToRequest(original, req.path) : undefined;
  if (before && eq({ ...before, settings: { ...before.settings, verifyTls: 0 } }, { ...req, settings: { ...req.settings, verifyTls: 0 } })) return original!;
  const doc: Obj = original ? obj(parseYaml(original)) : {};
  const changed = (f: (r: ApiRequest) => unknown) => !before || !eq(f(before), f(req));
  const gql = req.body.type === "graphql";
  if (changed((r) => [r.name, r.seq, r.body.type === "graphql"])) {
    const info = obj(doc.info);
    doc.info = { ...info, name: req.name, type: gql ? "graphql" : "http", ...(req.seq === undefined ? {} : { seq: req.seq }) };
    if (req.seq === undefined) delete (doc.info as Obj).seq;
  }
  const key = gql ? "graphql" : "http";
  const other = gql ? "http" : "graphql";
  if (doc[other] && !doc[key]) {
    doc[key] = doc[other]!;
    delete doc[other];
  }
  const http = obj(doc[key]);
  doc[key] = http;
  if (changed((r) => r.method)) http.method = before && before.method === req.method ? http.method! : req.method.toLowerCase();
  if (changed((r) => r.url)) http.url = req.url;
  if (changed((r) => [r.params, r.pathParams])) put(http, "params", [...rows(req.params, () => ({ type: "query" })), ...rows(req.pathParams, () => ({ type: "path" }))]);
  if (changed((r) => r.headers)) put(http, "headers", rows(req.headers));
  if (changed((r) => r.body)) {
    const b = req.body;
    if (b.type === "none") delete http.body;
    else if (b.type === "graphql") http.body = { query: b.query, variables: b.variables };
    else if (b.type === "form-urlencoded") http.body = { type: b.type, data: rows(b.fields) };
    else if (b.type === "multipart") http.body = { type: "multipart-form", data: b.fields.map((f) => ({ name: f.name, type: f.file ? "file" : "text", value: f.value, ...(f.enabled ? {} : { disabled: true }) })) };
    else http.body = { type: b.type, data: b.data };
  }
  if (changed((r) => r.auth)) http.auth = authToOc(req.auth);
  const rt = obj(doc.runtime);
  if (changed((r) => r.vars.pre)) put(rt, "variables", rows(req.vars.pre));
  if (changed((r) => r.vars.post)) {
    const keep = arr(rt.actions).filter((a) => !(a.type === "set-variable" && a.phase !== "before-request"));
    put(rt, "actions", [...keep, ...req.vars.post.map((v) => ({ type: "set-variable", phase: "after-response", selector: { expression: v.value, method: "jsonq" }, variable: v.name, ...(v.enabled ? {} : { disabled: true }) }))]);
  }
  if (changed((r) => r.assertions)) put(rt, "assertions", req.assertions.map((a) => ({ expression: a.expr, operator: a.op, ...(a.value ? { value: a.value } : {}), ...(a.enabled ? {} : { disabled: true }) })));
  if (changed((r) => r.scripts)) {
    const keep = arr(rt.scripts).filter((x) => !["before-request", "after-response", "tests"].includes(s(x.type)));
    const add = ([["before-request", req.scripts.pre], ["after-response", req.scripts.post], ["tests", req.scripts.tests]] as const).filter(([, c]) => c !== undefined).map(([type, code]) => ({ type, code: code! }));
    put(rt, "scripts", [...keep, ...add]);
  }
  if (Object.keys(rt).length) doc.runtime = rt;
  else delete doc.runtime;
  if (changed((r) => ({ ...r.settings, verifyTls: 0 }))) {
    const set = obj(doc.settings);
    const st = req.settings;
    put(set, "encodeUrl", st.encodeUrl);
    put(set, "timeout", st.timeoutMs ?? (set.timeout === undefined ? undefined : 0));
    put(set, "followRedirects", st.followRedirects);
    put(set, "maxRedirects", st.maxRedirects);
    if (Object.keys(set).length) doc.settings = set;
    else delete doc.settings;
  }
  if (changed((r) => r.docs)) put(doc, "docs", req.docs);
  return stringifyYaml(doc);
}

// ---- opencollection.yml and folder.yml ----

export function ocToDefaults(src: string): BruDefaults & { environments: ApiEnvironment[] } {
  const doc = obj(parseYaml(src));
  const r = obj(doc.request);
  const out: BruDefaults & { environments: ApiEnvironment[] } = {
    headers: kv(arr(r.headers)),
    auth: authFromOc(r.auth),
    vars: kv(arr(r.variables)),
    environments: arr(obj(doc.config).environments).map((e) => ({
      name: s(e.name),
      vars: arr(e.variables).map((v) => ({ name: s(v.name), value: v.secret === true ? "" : varValue(v.value), enabled: v.disabled !== true, ...(v.secret === true ? { secret: true } : {}) })),
    })),
  };
  const info = obj(doc.info);
  if (info.name !== undefined) out.name = s(info.name);
  if (typeof info.seq === "number") out.seq = info.seq;
  return out;
}

export function defaultsToOc(d: BruDefaults, original = ""): string {
  const before = original ? ocToDefaults(original) : undefined;
  const doc: Obj = original ? obj(parseYaml(original)) : {};
  let dirty = !before;
  if (d.name !== undefined && (!before || before.name !== d.name || before.seq !== d.seq)) {
    doc.info = { ...obj(doc.info), name: d.name, ...(d.seq === undefined ? {} : { seq: d.seq }) };
    dirty = true;
  }
  const r = obj(doc.request);
  if (!before || !eq(before.headers, d.headers)) (put(r, "headers", rows(d.headers)), (dirty = true));
  if (!before || !eq(before.auth, d.auth)) ((r.auth = authToOc(d.auth)), (dirty = true));
  if (!before || !eq(before.vars, d.vars)) (put(r, "variables", rows(d.vars)), (dirty = true));
  if (!dirty) return original;
  if (Object.keys(r).length) doc.request = r;
  return stringifyYaml(doc);
}

/** Secret values never reach the file: { name, secret: true }, Bruno's own convention. */
export function setOcEnvironment(original: string, env: ApiEnvironment, remove = false): string {
  const doc = obj(parseYaml(original));
  const config = obj(doc.config);
  const envs = arr(config.environments);
  const k = envs.findIndex((e) => e.name === env.name);
  const prev = k >= 0 ? envs[k]! : {};
  const next: Obj = { ...prev, name: env.name, variables: env.vars.map((v) => (v.secret ? { name: v.name, secret: true, ...(v.enabled ? {} : { disabled: true }) } : { name: v.name, value: v.value, ...(v.enabled ? {} : { disabled: true }) })) };
  if (remove) envs.splice(k, k >= 0 ? 1 : 0);
  else if (k >= 0) envs[k] = next;
  else envs.push(next);
  doc.config = { ...config, environments: envs };
  return stringifyYaml(doc);
}
