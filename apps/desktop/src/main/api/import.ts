// cURL, Postman v2.1, OpenAPI 3 and scanned routes into ApiRequests. Pure: no files, no network.
import type { ApiAuth, ApiBody, ApiEnvironment, ApiKv, ApiRequest, Route } from "@shrike/schema";
import { blankRequest } from "./collections.ts";
import { parseYaml, type Yaml } from "./yaml.ts";
import { skeleton } from "../../renderer/src/api/routes.ts";

export interface ImportDraft {
  name: string;
  requests: { folder: string; req: ApiRequest }[];
  folders: string[];
  vars: ApiKv[];
  auth: ApiAuth;
  headers: ApiKv[];
  environments: ApiEnvironment[];
  notes: string[];
}
const kvOn = (name: string, value: string): ApiKv => ({ name, value, enabled: true });

/** Splits "?a=1&b=2" off into params, keeping {{vars}} as typed. */
export function splitQuery(url: string): { url: string; params: ApiKv[] } {
  const q = url.indexOf("?");
  if (q < 0) return { url, params: [] };
  const params = url
    .slice(q + 1)
    .split("#")[0]!
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const k = p.indexOf("=");
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch {
          return s;
        }
      };
      return kvOn(dec(k < 0 ? p : p.slice(0, k)), k < 0 ? "" : dec(p.slice(k + 1)));
    });
  return { url, params };
}
export const pathParamsOf = (url: string, seen: ApiKv[] = []): ApiKv[] =>
  [...url.split("?")[0]!.matchAll(/\/:([A-Za-z_]\w*)/g)].map((m) => m[1]!).filter((n, k, a) => a.indexOf(n) === k).map((n) => seen.find((s) => s.name === n) ?? kvOn(n, ""));

// ---- cURL ----

function shellWords(src: string): string[] {
  const s = src.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const out: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end;
      has = true;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      for (; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i]!;
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
          if (n === "x") (cur += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16))), (i += 2);
          else if (n === "u") (cur += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16))), (i += 4);
          else cur += map[n] ?? `\\${n}`;
        } else cur += s[i];
      }
      has = true;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) cur += s[i] === "\\" && /["\\$`]/.test(s[i + 1] ?? "") ? s[++i] : s[i];
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function parseCurl(src: string): ApiRequest {
  const words = shellWords(src.trim());
  if (!words.length || !/^curl(\.exe)?$/.test(words[0]!.split("/").pop()!)) throw new Error("That doesn't look like a curl command.");
  let method: string | undefined;
  let url = "";
  let get = false;
  const headers: ApiKv[] = [];
  const data: string[] = [];
  const form: (ApiKv & { file?: boolean })[] = [];
  let auth: ApiAuth = { type: "inherit" };
  const settings: ApiRequest["settings"] = {};
  let json = false;
  for (let i = 1; i < words.length; i++) {
    let w = words[i]!;
    let val: string | undefined;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    if (eq > 0) (val = w.slice(eq + 1)), (w = w.slice(0, eq));
    const attached = /^-([XHdFubAemo])(.+)$/.exec(w);
    if (attached) (val = attached[2]), (w = `-${attached[1]}`);
    const next = () => val ?? words[++i] ?? "";
    if (/^-[A-Za-z]{2,}$/.test(w) && !["-X", "-H", "-d", "-F", "-u", "-b", "-A", "-e"].includes(w)) {
      for (const f of w.slice(1)) if (f === "G") get = true;
      else if (f === "I") method = "HEAD";
      else if (f === "k") settings.verifyTls = false;
      else if (f === "L") settings.followRedirects = true;
      continue;
    }
    switch (w) {
      case "-X":
      case "--request":
        method = next().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = next();
        const k = h.indexOf(":");
        if (k > 0) headers.push(kvOn(h.slice(0, k).trim(), h.slice(k + 1).trim()));
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
        data.push(next());
        break;
      case "--data-urlencode": {
        const d = next();
        const k = d.indexOf("=");
        data.push(k < 0 ? encodeURIComponent(d) : `${d.slice(0, k)}=${encodeURIComponent(d.slice(k + 1))}`);
        break;
      }
      case "--json":
        data.push(next());
        json = true;
        break;
      case "-F":
      case "--form":
      case "--form-string": {
        const f = next();
        const k = f.indexOf("=");
        const v = f.slice(k + 1);
        form.push(w !== "--form-string" && v.startsWith("@") ? { name: f.slice(0, k), value: v.slice(1).replace(/;type=.*$/, ""), enabled: true, file: true } : { name: f.slice(0, k), value: v, enabled: true });
        break;
      }
      case "-u":
      case "--user": {
        const u = next();
        const k = u.indexOf(":");
        auth = { type: "basic", username: k < 0 ? u : u.slice(0, k), password: k < 0 ? "" : u.slice(k + 1) };
        break;
      }
      case "-b":
      case "--cookie":
        headers.push(kvOn("Cookie", next()));
        break;
      case "-A":
      case "--user-agent":
        headers.push(kvOn("User-Agent", next()));
        break;
      case "-e":
      case "--referer":
        headers.push(kvOn("Referer", next()));
        break;
      case "--url":
        url = next();
        break;
      case "-G":
      case "--get":
        get = true;
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-k":
      case "--insecure":
        settings.verifyTls = false;
        break;
      case "-L":
      case "--location":
        settings.followRedirects = true;
        break;
      case "--max-time":
      case "-m":
        settings.timeoutMs = Math.round(Number(next()) * 1000) || undefined;
        if (!settings.timeoutMs) delete settings.timeoutMs;
        break;
      case "-o":
      case "--output":
      case "-w":
      case "--write-out":
      case "--connect-timeout":
      case "--retry":
      case "-x":
      case "--proxy":
      case "--cacert":
      case "--cert":
      case "--key":
        next();
        break;
      default:
        if (!w.startsWith("-") && !url) url = w;
    }
  }
  if (!url) throw new Error("The curl command has no URL.");
  if (json) {
    if (!headers.some((h) => /^content-type$/i.test(h.name))) headers.push(kvOn("Content-Type", "application/json"));
    if (!headers.some((h) => /^accept$/i.test(h.name))) headers.push(kvOn("Accept", "application/json"));
  }
  const ct = headers.find((h) => /^content-type$/i.test(h.name))?.value.toLowerCase() ?? "";
  let body: ApiBody = { type: "none" };
  const joined = data.join("&");
  if (get && data.length) url += (url.includes("?") ? "&" : "?") + joined;
  else if (form.length) body = { type: "multipart", fields: form };
  else if (data.length) {
    if (ct.includes("json") || (!ct && /^\s*[[{]/.test(joined))) body = { type: "json", data: prettyJson(data.join("")) };
    else if (ct.includes("xml")) body = { type: "xml", data: data.join("") };
    else if ((!ct || ct.includes("x-www-form-urlencoded")) && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined)) body = { type: "form-urlencoded", fields: splitQuery(`?${joined}`).params };
    else body = { type: "text", data: data.join("") };
    if (body.type === "json" || body.type === "form-urlencoded") {
      const k = headers.findIndex((h) => /^content-type$/i.test(h.name) && /json$|x-www-form-urlencoded$/i.test(h.value.trim()));
      if (k >= 0 && !json) headers.splice(k, 1); // the body type sets it
    }
  }
  const { params } = splitQuery(url);
  const name = (() => {
    try {
      const u = new URL(url);
      return `${(method ?? "GET").toUpperCase()} ${u.pathname}`;
    } catch {
      return url.slice(0, 60);
    }
  })();
  return blankRequest({ name, method: method ?? (get ? "GET" : data.length || form.length ? "POST" : "GET"), url, params, pathParams: pathParamsOf(url), headers, body, auth, settings });
}

const prettyJson = (s: string) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

// ---- Postman v2.1 ----

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const a = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(o) : []);
const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

function postmanAuth(v: unknown, notes: string[], where: string): ApiAuth {
  const x = o(v);
  const type = str(x.type);
  const get = (k: string) => str(a(x[type]).find((p) => p.key === k)?.value);
  if (!type || type === "noauth") return { type: type ? "none" : "inherit" };
  if (type === "bearer") return { type: "bearer", token: get("token") };
  if (type === "basic") return { type: "basic", username: get("username"), password: get("password") };
  if (type === "apikey") return { type: "apikey", key: get("key"), value: get("value"), placement: get("in") === "query" ? "query" : "header" };
  notes.push(`${where} uses ${type} auth, which Shrike doesn't send yet. It's set to inherit.`);
  return { type: "inherit" };
}

export function importPostman(text: string): ImportDraft {
  const col = o(JSON.parse(text));
  const info = o(col.info);
  if (!/v2\.[01]/.test(str(info.schema)) || !Array.isArray(col.item)) throw new Error("That isn't a Postman v2.1 collection.");
  const notes: string[] = [];
  const draft: ImportDraft = { name: str(info.name) || "From Postman", requests: [], folders: [], vars: a(col.variable).map((v) => ({ name: str(v.key), value: str(v.value), enabled: v.disabled !== true })), auth: postmanAuth(col.auth, notes, "The collection"), headers: [], environments: [], notes };
  const walk = (items: Obj[], folder: string) => {
    items.forEach((it, k) => {
      const name = str(it.name) || `Item ${k + 1}`;
      if (Array.isArray(it.item)) {
        const f = folder ? `${folder}/${name}` : name;
        draft.folders.push(f);
        walk(a(it.item), f);
        return;
      }
      const r = typeof it.request === "string" ? { url: it.request } : o(it.request);
      const u = r.url;
      const uo = o(u);
      let url = typeof u === "string" ? u : str(uo.raw);
      if (!url && uo.host) url = `${uo.protocol ? `${str(uo.protocol)}://` : ""}${Array.isArray(uo.host) ? uo.host.join(".") : str(uo.host)}${uo.port ? `:${str(uo.port)}` : ""}/${Array.isArray(uo.path) ? uo.path.map(str).join("/") : str(uo.path)}`;
      const params = Array.isArray(uo.query) ? a(uo.query).map((q) => ({ name: str(q.key), value: str(q.value), enabled: q.disabled !== true })) : splitQuery(url).params;
      const pathParams = Array.isArray(uo.variable) ? a(uo.variable).map((q) => kvOn(str(q.key), str(q.value))) : pathParamsOf(url);
      const b = o(r.body);
      let body: ApiBody = { type: "none" };
      const mode = str(b.mode);
      if (mode === "raw") {
        const lang = str(o(o(b.options).raw).language);
        body = { type: lang === "json" || (!lang && /^\s*[[{]/.test(str(b.raw))) ? "json" : lang === "xml" ? "xml" : "text", data: str(b.raw) };
      } else if (mode === "urlencoded") body = { type: "form-urlencoded", fields: a(b.urlencoded).map((f) => ({ name: str(f.key), value: str(f.value), enabled: f.disabled !== true })) };
      else if (mode === "formdata") body = { type: "multipart", fields: a(b.formdata).map((f) => ({ name: str(f.key), value: f.type === "file" ? str(f.src) : str(f.value), enabled: f.disabled !== true, ...(f.type === "file" ? { file: true } : {}) })) };
      else if (mode === "graphql") body = { type: "graphql", query: str(o(b.graphql).query), variables: str(o(b.graphql).variables) };
      const scripts: ApiRequest["scripts"] = {};
      for (const ev of a(it.event)) {
        const exec = o(ev.script).exec;
        const code = Array.isArray(exec) ? exec.map(str).join("\n") : str(exec);
        if (!code.trim()) continue;
        // Postman's pm.* API isn't Bruno's bru.*; kept commented so nothing runs by surprise
        const kept = `// From Postman (${str(ev.listen)}). Postman's pm API doesn't run here; rewrite with bru, req and res.\n${code.split("\n").map((l) => `// ${l}`).join("\n")}`;
        if (ev.listen === "prerequest") scripts.pre = kept;
        else scripts.tests = kept;
        if (!notes.some((n) => n.startsWith("Postman scripts"))) notes.push("Postman scripts were kept as comments, since Postman's pm API doesn't run in Shrike or Bruno.");
      }
      draft.requests.push({
        folder,
        req: blankRequest({ name, seq: k + 1, method: str(r.method || "GET").toUpperCase(), url, params, pathParams, headers: a(r.header).map((h) => ({ name: str(h.key), value: str(h.value), enabled: h.disabled !== true })), body, auth: r.auth ? postmanAuth(r.auth, notes, name) : { type: "inherit" }, scripts, ...(r.description ? { docs: str(o(r.description).content ?? r.description) } : {}) }),
      });
    });
  };
  walk(a(col.item), "");
  return draft;
}

// ---- OpenAPI 3 ----

export function importOpenApi(text: string): ImportDraft {
  const t = text.trim();
  const spec = o(t.startsWith("{") ? JSON.parse(t) : (parseYaml(t) as Yaml));
  if (!/^3\./.test(str(spec.openapi))) throw new Error(spec.swagger ? "That's a Swagger 2 file. Shrike reads OpenAPI 3." : "That isn't an OpenAPI 3 file.");
  const info = o(spec.info);
  const notes: string[] = [];
  const server = str(o(a(spec.servers)[0]).url);
  const schemes = o(o(spec.components).securitySchemes);
  let auth: ApiAuth = { type: "none" };
  const firstSec = Object.keys(o(a(spec.security)[0]))[0] ?? Object.keys(schemes)[0];
  if (firstSec) {
    const s = o(schemes[firstSec]);
    if (s.type === "http" && str(s.scheme).toLowerCase() === "bearer") auth = { type: "bearer", token: "{{token}}" };
    else if (s.type === "http" && str(s.scheme).toLowerCase() === "basic") auth = { type: "basic", username: "{{username}}", password: "{{password}}" };
    else if (s.type === "apiKey") auth = { type: "apikey", key: str(s.name), value: "{{apiKey}}", placement: s.in === "query" ? "query" : "header" };
    else if (s.type) notes.push(`The API uses ${str(s.type)} auth, which Shrike doesn't send yet.`);
  }
  const draft: ImportDraft = {
    name: str(info.title) || "From OpenAPI",
    requests: [],
    folders: [],
    vars: [kvOn("baseUrl", server.replace(/\/$/, "") || "http://localhost:3000")],
    auth,
    headers: [],
    environments: [],
    notes,
  };
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const [path, item] of Object.entries(o(spec.paths))) {
    const shared = a(o(item).parameters);
    for (const m of methods) {
      const op = o(o(item)[m]);
      if (!Object.keys(op).length) continue;
      const folder = Array.isArray(op.tags) && op.tags.length ? str(op.tags[0]) : "";
      if (folder && !draft.folders.includes(folder)) draft.folders.push(folder);
      const ps = [...shared, ...a(op.parameters)].map((p) => (p.$ref ? o(str(p.$ref).slice(2).split("/").reduce<unknown>((c, k) => o(c)[k], spec)) : p));
      const sample = (p: Obj) => str(p.example ?? o(p.schema).example ?? o(p.schema).default ?? "");
      const url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      const content = o(o(op.requestBody).content);
      const jsonType = Object.keys(content).find((k) => /json/.test(k));
      const formType = Object.keys(content).find((k) => /x-www-form-urlencoded|multipart/.test(k));
      let body: ApiBody = { type: "none" };
      if (jsonType) {
        const c = o(content[jsonType]);
        const ex = c.example ?? o(Object.values(o(c.examples))[0]).value ?? skeleton(o(c.schema), spec);
        body = { type: "json", data: JSON.stringify(ex, null, 2) };
      } else if (formType) {
        const props = o(o(skeleton(o(o(content[formType]).schema), spec)));
        const fields = Object.entries(props).map(([k, v]) => kvOn(k, str(v)));
        body = formType.includes("multipart") ? { type: "multipart", fields } : { type: "form-urlencoded", fields };
      }
      draft.requests.push({
        folder,
        req: blankRequest({
          name: str(op.summary) || str(op.operationId) || `${m.toUpperCase()} ${path}`,
          seq: draft.requests.filter((r) => r.folder === folder).length + 1,
          method: m.toUpperCase(),
          url,
          params: ps.filter((p) => p.in === "query").map((p) => ({ name: str(p.name), value: sample(p), enabled: p.required === true })),
          pathParams: ps.filter((p) => p.in === "path").map((p) => kvOn(str(p.name), sample(p))),
          headers: ps.filter((p) => p.in === "header").map((p) => ({ name: str(p.name), value: sample(p), enabled: p.required === true })),
          body,
          ...(op.description ? { docs: str(op.description) } : {}),
        }),
      });
    }
  }
  if (!draft.requests.length) throw new Error("The OpenAPI file has no paths.");
  return draft;
}

// ---- scanned routes ----

/** Next's [id] and [...rest], OpenAPI's {id}, Flask's <int:id> as Express-style :id. */
export const colonPath = (p: string): string => p.replace(/\[\.\.\.(\w+)\]/g, ":$1").replace(/\[(\w+)\]/g, ":$1").replace(/\{(\w+)\}/g, ":$1").replace(/<(?:\w+:)?(\w+)>/g, ":$1");

export function importRoutes(routes: Route[], appUrl: string | undefined, name: string): ImportDraft {
  const draft: ImportDraft = { name, requests: [], folders: [], vars: [], auth: { type: "none" }, headers: [], environments: [{ name: "Local", vars: [kvOn("baseUrl", (appUrl ?? "http://localhost:3000").replace(/\/$/, ""))] }], notes: [] };
  const seen = new Set<string>();
  for (const r of routes) {
    const path = colonPath(r.path);
    const method = r.method.toUpperCase() === "ALL" || r.method === "*" ? "GET" : r.method.toUpperCase();
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const folder = path.split("/").filter((s) => s && s !== "api" && !s.startsWith(":"))[0] ?? "";
    if (folder && !draft.folders.includes(folder)) draft.folders.push(folder);
    const url = `{{baseUrl}}${path}`;
    draft.requests.push({
      folder,
      req: blankRequest({
        name: key,
        seq: draft.requests.filter((x) => x.folder === folder).length + 1,
        method,
        url,
        pathParams: pathParamsOf(url),
        body: ["POST", "PUT", "PATCH"].includes(method) ? { type: "json", data: "{\n  \n}" } : { type: "none" },
        ...(r.handler ? { docs: `Handler: ${r.handler.file}:${r.handler.line}` } : {}),
      }),
    });
  }
  return draft;
}
