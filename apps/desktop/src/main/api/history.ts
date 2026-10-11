// Last 200 sends per project in userData, redacted before they're written.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ApiAuth, ApiBody, ApiHistoryEntry, ApiKv, ApiRequest } from "@shrike/schema";
import { redactCell, redactText } from "@shrike/redact";
import { atomicWrite } from "./collections.ts";
import { readJson } from "../state-file.ts";

export const HISTORY_MAX = 200;
const SENSITIVE = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i;
const isVar = (v: string) => /^\s*\{\{[^}]+\}\}\s*$/.test(v);
const mask = (name: string, v: string) => (isVar(v) ? v : SENSITIVE.test(name) ? `[redacted:${name.toLowerCase()}]` : String(redactCell(name, v)));
const rows = (list: ApiKv[]): ApiKv[] => list.map((r) => ({ ...r, value: r.secret ? "[redacted:secret]" : mask(r.name, r.value) }));

function redactAuth(a: ApiAuth): ApiAuth {
  if (a.type === "bearer") return { ...a, token: isVar(a.token) ? a.token : "[redacted:token]" };
  if (a.type === "basic") return { ...a, password: isVar(a.password) ? a.password : "[redacted:password]" };
  if (a.type === "apikey") return { ...a, value: isVar(a.value) ? a.value : `[redacted:${a.key.toLowerCase() || "key"}]` };
  return a;
}
function redactBody(b: ApiBody): ApiBody {
  if (b.type === "json" || b.type === "text" || b.type === "xml") return { ...b, data: redactText(b.data) };
  if (b.type === "form-urlencoded") return { ...b, fields: rows(b.fields) };
  if (b.type === "multipart") return { ...b, fields: b.fields.map((f) => (f.file ? f : { ...f, value: mask(f.name, f.value) })) };
  if (b.type === "graphql") return { ...b, query: redactText(b.query), variables: redactText(b.variables) };
  return b;
}

export function redactRequest(r: ApiRequest): ApiRequest {
  return {
    ...r,
    url: redactText(r.url),
    params: rows(r.params),
    pathParams: rows(r.pathParams),
    headers: rows(r.headers),
    body: redactBody(r.body),
    auth: redactAuth(r.auth),
    vars: { pre: rows(r.vars.pre), post: r.vars.post },
    scripts: {}, // scripts stay in the collection file; history is for what was sent
  };
}

export function createHistory(o: { stateDir: () => string; projectRoot: () => string | undefined }) {
  const file = () => {
    const root = o.projectRoot();
    return root ? join(o.stateDir(), "api-history", `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`) : undefined;
  };
  let chain = Promise.resolve();
  const read = async (): Promise<ApiHistoryEntry[]> => {
    const f = file();
    if (!f) return [];
    try {
      const list = await readJson(f);
      return Array.isArray(list) ? (list as ApiHistoryEntry[]) : [];
    } catch {
      return [];
    }
  };
  return {
    list: async () => (await chain, read()),
    add(entry: ApiHistoryEntry): Promise<void> {
      const f = file();
      if (!f) return Promise.resolve();
      const safe: ApiHistoryEntry = { ...entry, url: redactText(entry.url), request: redactRequest(entry.request) };
      chain = chain.then(async () => atomicWrite(f, JSON.stringify([safe, ...(await read())].slice(0, HISTORY_MAX)))).catch(() => {});
      return chain;
    },
    clear(): Promise<void> {
      const f = file();
      chain = chain.then(() => (f ? atomicWrite(f, "[]") : undefined)).catch(() => {});
      return chain;
    },
  };
}
