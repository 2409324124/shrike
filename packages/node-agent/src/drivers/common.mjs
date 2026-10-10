// Shared bits for the database driver hooks (docs/13 DB): places, events, callbacks, cheap write capture.
import { changeOf, writeOf } from "../inspect.mjs";
import { hostKey } from "../place.mjs";
import { preview, SECRET } from "../preview.mjs";
import { libCall } from "../runtime.mjs";

export const LABEL = { postgres: "POSTGRES", mysql: "MYSQL", mongodb: "MONGODB", sqlite: "SQLITE", dynamodb: "DYNAMODB", supabase: "SUPABASE", libsql: "LIBSQL", firestore: "FIRESTORE" };

/** data:postgres:localhost:5432/app, "POSTGRES · app". Never carries credentials. */
export function serverPlace(system, host, port, database) {
  const where = `${hostKey(String(host || "localhost"), port)}${database ? `/${database}` : ""}`;
  return { kind: "data", id: `data:${system}:${where}`, name: database ? `${LABEL[system]} · ${database}` : LABEL[system], detail: where };
}

/** Host, port and database from a connection URL; the user and password are dropped here. */
export function urlParts(url) {
  try {
    const u = new URL(url);
    return { host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, "")), port: u.port || undefined, database: decodeURIComponent(u.pathname.replace(/^\/+/, "").split("/")[0] ?? "") || undefined };
  } catch {
    return {};
  }
}

export const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

export function dbEvent(system, place, statement, params) {
  return {
    origin: "db",
    kind: "db_query",
    name: oneLine(statement).slice(0, 60),
    db: { system, statement: String(statement), params: params !== undefined && (!Array.isArray(params) || params.length) ? preview(maskParams(String(statement), params)) : undefined },
    place,
  };
}

// The column each placeholder feeds: INSERT (a, b) VALUES ($1, ?), SET a = ?, WHERE a = $2.
// ponytail: a ? inside a string literal shifts the count; those params are left as they are.
function paramColumns(sql) {
  const cols = new Map();
  const ins = /\(([^()]*)\)\s*VALUES\s*\(([^()]*)\)/i.exec(sql);
  const names = ins ? splitTop(ins[1]).map(unq) : [];
  const start = ins ? ins.index + ins[0].length - 1 - ins[2].length : -1;
  let q = 0;
  for (const m of sql.matchAll(/\$(\d+)|\?/g)) {
    const i = m[1] ? Number(m[1]) - 1 : q++;
    const col =
      ins && m.index >= start && m.index < start + ins[2].length
        ? names[splitTop(`${sql.slice(start, m.index)}x`).length - 1]
        : /["`]?([\w$]+)["`]?\s*(?:=|<>|!=|>=|<=|>|<|\bLIKE|\bIN\s*\()\s*$/i.exec(sql.slice(Math.max(0, m.index - 80), m.index))?.[1];
    if (col) cols.set(i, col);
  }
  return cols;
}

/** Params whose column names a secret (password, api_token, ...) are shown as [redacted]. */
export function maskParams(sql, params) {
  if (!Array.isArray(params) || !params.length) return params;
  try {
    const cols = paramColumns(sql);
    if (![...cols.values()].some((c) => SECRET.test(c))) return params;
    return params.map((v, i) => (SECRET.test(cols.get(i) ?? "") && v != null ? "[redacted]" : v));
  } catch {
    return params;
  }
}

/** Walks up from a class to the prototype that defines `method` itself. */
export function ownerOf(cls, method) {
  let p = cls?.prototype;
  while (p && !Object.hasOwn(p, method)) p = Object.getPrototypeOf(p);
  return p && p !== Object.prototype ? p : undefined;
}

export function once(proto, tag = "__shrike") {
  if (!proto || Object.hasOwn(proto, tag)) return false;
  Object.defineProperty(proto, tag, { value: true });
  return true;
}

/**
 * One driver call that finishes either through a node-style callback or a returned promise.
 * Returns exactly what the driver returned; the app's callback still gets every argument.
 */
export function tracked(stackFn, build, settle, invoke, cb) {
  if (typeof cb !== "function") return libCall(stackFn, build, () => invoke(undefined), settle, true);
  let ret;
  let done;
  const p = new Promise((resolve, reject) => (done = (e, v) => (e ? reject(e) : resolve(v))));
  p.catch(() => {});
  libCall(
    stackFn,
    build,
    () => {
      ret = invoke(function (err, v) {
        done(err, v);
        return cb.apply(this, arguments);
      });
      return p;
    },
    settle,
    true,
  );
  return ret;
}

// ---- cheap write capture: rows from the statement's own params, no extra queries

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  let q = "";
  for (const ch of s) {
    if (q) {
      if (ch === q) q = "";
    } else if (ch === "'" || ch === '"' || ch === "`") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unq = (c) => c.trim().replace(/^[`"[]|[`"\]]$/g, "");

function valueOf(token, params, next) {
  const t = token.trim();
  const pg = /^\$(\d+)(?:::[\w\s[\]]+)?$/.exec(t);
  if (pg) return { v: params[Number(pg[1]) - 1] };
  if (t === "?") return { v: params[next.i++] };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { v: Number(t) };
  if (/^'.*'$/s.test(t)) return { v: t.slice(1, -1).replaceAll("''", "'") };
  if (/^null$/i.test(t)) return { v: null };
  if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t) };
  return undefined; // default, now(), expressions
}

// ponytail: single-table INSERT ... VALUES and UPDATE ... SET ... WHERE col = ?; anything fancier gets counts only.
export function rowsFromParams(plan, sql, params = []) {
  if (!Array.isArray(params)) return {};
  if (plan.op === "insert") {
    const m = /\(([^()]*)\)\s*VALUES\s*([\s\S]*?)(?:\bON\s+(?:CONFLICT|DUPLICATE)\b|\bRETURNING\b|;|$)/i.exec(sql);
    if (!m) return {};
    const cols = splitTop(m[1]).map(unq);
    const next = { i: 0 };
    const after = [];
    for (const tuple of m[2].matchAll(/\(((?:[^()]|\([^()]*\))*)\)/g)) {
      const vals = splitTop(tuple[1]);
      const row = {};
      vals.forEach((t, i) => {
        const v = valueOf(t, params, next);
        if (v && cols[i]) row[cols[i]] = v.v;
      });
      after.push(row);
      if (after.length >= 5) break;
    }
    return { after };
  }
  const where = plan.where ? params[plan.where.index] : undefined;
  if (where === undefined) return {};
  const key = { [plan.where.col]: where };
  if (plan.op === "delete") return { before: [key] };
  const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(sql);
  const row = { ...key };
  const next = { i: 0 };
  for (const part of set ? splitTop(set[1]) : []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const v = valueOf(part.slice(eq + 1), params, next);
    if (v) row[unq(part.slice(0, eq).replace(/^.*\./, ""))] = v.v;
  }
  return { after: [row] };
}

/** I3 change for a SQL write from its statement, params, the affected count and any RETURNING rows. */
export function sqlChange(sql, params, count, returned) {
  const plan = writeOf(String(sql));
  if (!plan) return undefined;
  const rows = plan.returning && Array.isArray(returned) && returned.length ? (plan.op === "delete" ? { before: returned } : { after: returned }) : rowsFromParams(plan, String(sql), params);
  return changeOf(plan, count, rows);
}
