// Databases spoken to over HTTP: an outgoing call that is really a database call becomes db_query or cache_op
// on the database's own lane. Supabase (supabase-js PostgREST /rest/v1), Upstash Redis REST, Neon's HTTP
// driver (/sql) and libSQL/Turso (/v2|v3/pipeline). Supabase auth (GoTrue /auth/v1) joins the Supabase lane, as in
// browser-agent data.ts; storage and the rest stay outside calls.
import { safeKey } from "../cache.mjs";
import { changeOf, writeOf } from "../inspect.mjs";
import { hostKey } from "../place.mjs";
import { preview } from "../preview.mjs";
import { dbEvent, oneLine, serverPlace, sqlChange, urlParts } from "./common.mjs";

const json = (s) => {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};
const header = (h, name) => h?.[name] ?? h?.[name.toLowerCase()];

function morph(event, extra) {
  const { http, ...rest } = event;
  return { ...rest, origin: "db", ...extra, status: (http?.status ?? 0) >= 400 || event.status === "error" ? "error" : rest.status, ...(event.error ? { error: event.error } : http?.status >= 400 ? { error: { message: `${http.status} ${oneLine(http.resBody ?? "").slice(0, 300)}` } } : {}) };
}

// ---- Supabase PostgREST: GET /rest/v1/notes?select=*&id=eq.3

const VERB = { GET: "SELECT", HEAD: "SELECT", POST: "INSERT INTO", PATCH: "UPDATE", PUT: "UPSERT INTO", DELETE: "DELETE FROM" };

const AUTH = { signup: "sign up", logout: "sign out", user: "get the signed-in user", ".well-known": "read the signing keys", recover: "send a password reset", otp: "send a sign-in code", verify: "verify a code", settings: "read auth settings" };

function supabase(event, url) {
  const host = hostKey(url.hostname, url.port, url.protocol === "https:" ? 443 : 80);
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
  const place = { kind: "data", id: `data:supabase:${host}`, name: `SUPABASE · ${ref ?? host}`, detail: host };
  const auth = /^\/auth\/v1\/(.+?)\/?$/.exec(url.pathname)?.[1];
  if (auth) {
    const grant = url.searchParams.get("grant_type");
    const what = auth === "token" ? (grant === "refresh_token" ? "refresh the session" : `sign in${grant ? ` with ${grant.replace(/_/g, " ")}` : ""}`) : (AUTH[auth.split("/")[0]] ?? `${event.http.method} ${auth}`);
    return morph(event, { kind: "db_query", name: what, db: { system: "supabase", statement: `${what} (auth)` }, place }); // not "auth: x", which main redacts
  }
  const m = /^\/rest\/v1\/(rpc\/)?([^/?]+)\/?$/.exec(url.pathname);
  if (!m) return undefined;
  const table = decodeURIComponent(m[2]);
  const q = Object.fromEntries([...url.searchParams].filter(([k]) => !["apikey"].includes(k)));
  const select = q.select ?? "*";
  delete q.select;
  const method = event.http.method;
  const filters = Object.entries(q).filter(([k]) => !["order", "limit", "offset", "on_conflict", "columns"].includes(k));
  const where = filters.length ? ` WHERE ${filters.map(([k], i) => `${k} = $${i + 1}`).join(" AND ")}` : "";
  const statement = m[1] ? `SELECT ${table}()` : method === "GET" || method === "HEAD" ? `SELECT ${select} FROM ${table}${where}` : method === "PATCH" ? `UPDATE ${table} SET …${where}` : `${VERB[method] ?? method} ${table}${method === "DELETE" ? where : ""}`;
  const e = morph(event, { kind: "db_query", name: oneLine(statement).slice(0, 60), db: { system: "postgres", statement, params: filters.length ? preview(filters.map(([, v]) => v.replace(/^\w+\./, ""))) : undefined }, place });
  const body = json(event.http.resBody);
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && !body.code ? [body] : [];
  const plan = method === "POST" || method === "PUT" ? { op: "insert", table } : method === "PATCH" ? { op: "update", table } : method === "DELETE" ? { op: "delete", table } : undefined;
  if (plan && e.status !== "error") {
    const range = /\/(\d+|\*)$/.exec(String(header(event.http.resHeaders, "content-range") ?? ""))?.[1];
    const sent = json(event.http.reqBody);
    const after = rows.length ? rows : plan.op === "insert" ? [sent].flat().filter((x) => x && typeof x === "object") : [];
    e.change = changeOf(plan, rows.length || Number(range) || after.length, plan.op === "delete" ? { before: rows } : { after });
  } else if (Array.isArray(body)) e.returned = `${body.length} row${body.length === 1 ? "" : "s"}`;
  return e;
}

// ---- Upstash Redis REST: POST / with ["SET", "k", "v"], /pipeline and /multi-exec with [[...], ...]

function upstash(event, url) {
  const body = json(event.http.reqBody);
  if (!Array.isArray(body)) return undefined;
  const host = url.hostname;
  const place = { kind: "cache", id: `cache:redis:${host}/0`, name: "REDIS · UPSTASH", detail: host };
  const cmds = Array.isArray(body[0]) ? body : [body];
  const [op, key] = [String(cmds[0][0] ?? "").toLowerCase(), cmds[0][1]];
  const k = key === undefined ? undefined : safeKey(String(key));
  const label = cmds.length > 1 ? `${op.toUpperCase()} +${cmds.length - 1}` : op.toUpperCase();
  const e = morph(event, { kind: "cache_op", name: k === undefined ? label : `${label} ${k}`, cache: { op, key: k }, place });
  const res = json(event.http.resBody);
  const first = Array.isArray(res) ? res[0]?.result : res?.result;
  if (/^(get|hget|hgetall|mget|exists|json\.get|smembers|lrange|zrange)$/.test(op)) {
    e.cache.hit = first != null && !(Array.isArray(first) && !first.length) && !(op === "exists" && Number(first) === 0);
    if (e.cache.hit) e.returned = preview(first);
  }
  return e;
}

// ---- Neon serverless HTTP: POST https://<host>/sql, Neon-Connection-String header, { query, params }

function neon(event) {
  const conn = header(event.http.reqHeaders, "neon-connection-string");
  const body = json(event.http.reqBody);
  if (!conn || !body) return undefined;
  const u = urlParts(conn);
  const first = Array.isArray(body.queries) ? body.queries[0] : body;
  const statement = String(first?.query ?? "");
  const e = morph(event, dbEvent("postgres", serverPlace("postgres", u.host, u.port ?? 5432, u.database), statement, first?.params));
  const res = json(event.http.resBody);
  const last = Array.isArray(res?.results) ? res.results[res.results.length - 1] : res;
  const change = sqlChange(statement, first?.params, last?.rowCount, last?.rows);
  if (change) e.change = change;
  return e;
}

// ---- libSQL / Turso HTTP: POST /v2/pipeline { requests: [{ type: "execute", stmt: { sql, args } }] }

function libsql(event, url) {
  const body = json(event.http.reqBody);
  const stmts = (body?.requests ?? []).map((r) => r?.stmt ?? r?.batch?.steps?.[0]?.stmt).filter((s) => typeof s?.sql === "string");
  if (!stmts.length) return undefined;
  const host = hostKey(url.hostname, url.port, url.protocol === "https:" ? 443 : 80);
  const place = { kind: "data", id: `data:libsql:${host}`, name: `LIBSQL · ${url.hostname.split(".")[0]}`, detail: host };
  const params = (stmts[0].args ?? []).map((a) => (a && typeof a === "object" && "value" in a ? a.value : a));
  const e = morph(event, dbEvent("sqlite", place, stmts.map((s) => s.sql).join(";\n"), params));
  const res = json(event.http.resBody)?.results?.[0]?.response?.result;
  const plan = writeOf(stmts[0].sql);
  if (plan && res) e.change = changeOf(plan, res.affected_row_count, {});
  return e;
}

/** The event to emit for an outgoing call: a database call on its database's lane, or the call itself. */
export function reclassify(event) {
  try {
    if (event?.kind !== "external_call" || !event.http?.url) return event;
    const url = new URL(event.http.url);
    if (/^\/(rest|auth)\/v1\//.test(url.pathname) && (url.hostname.endsWith(".supabase.co") || header(event.http.reqHeaders, "apikey") || header(event.http.reqHeaders, "x-client-info")?.startsWith("supabase"))) return supabase(event, url) ?? event;
    if (event.http.method === "POST" && (url.hostname.endsWith(".upstash.io") || header(event.http.reqHeaders, "upstash-encoding") !== undefined)) return upstash(event, url) ?? event;
    if (event.http.method === "POST" && url.pathname === "/sql") return neon(event) ?? event;
    if (event.http.method === "POST" && /^\/v[23]\/pipeline$/.test(url.pathname)) return libsql(event, url) ?? event;
  } catch {}
  return event;
}
