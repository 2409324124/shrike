// Look inside (docs/13 DB): read a database lane straight from main, with the project's own connection settings,
// when no node-agent holds it (Python/Go backends, an app that isn't running, drivers node-agent only watches).
// Read-only per engine, timeouts everywhere, and it runs in Shrike's process, so it never makes trip events.
import { relative } from "node:path";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import { discover, isLocal, normHost, type Engine, type Source } from "./discover.ts";

export type Reader = {
  tables?(s: Source, ctx: Ctx): Promise<InspectResult>;
  rows?(s: Source, req: Extract<InspectRequest, { op: "rows" }>, ctx: Ctx): Promise<InspectResult>;
  cacheKeys?(s: Source, req: Extract<InspectRequest, { op: "cacheKeys" }>, ctx: Ctx): Promise<InspectResult>;
  cacheGet?(s: Source, req: Extract<InspectRequest, { op: "cacheGet" }>, ctx: Ctx): Promise<InspectResult>;
};
export interface Ctx {
  database?: string; // from the place id when the source didn't name one
  how: string; // "a read-only transaction on localhost:5432" + a not-on-this-machine note
}

const LOAD: Record<Engine, () => Promise<Reader>> = {
  postgres: () => import("./postgres.ts"),
  mysql: () => import("./mysql.ts"),
  mongodb: () => import("./mongodb.ts"),
  redis: () => import("./redis.ts"),
  sqlite: () => import("./sqlite.ts"),
  supabase: () => import("./supabase.ts"),
  dynamodb: () => import("./dynamodb.ts"),
  firestore: () => import("./firestore.ts"),
};

const TIMEOUT_MS = 8000;

/** "data:postgres:localhost:5432/app" -> { engine, host, port, database }; "data:sqlite:app.db" -> { file }. */
export function parsePlace(id: string): { engine: string; host?: string; port?: number; database?: string; file?: string } {
  const [kind, engine = "", ...rest] = id.split(":");
  const tail = rest.join(":");
  if (kind === "cache") return { engine: engine === "redis" ? "redis" : engine, ...hostPart(tail) };
  if (engine === "sqlite") return { engine, file: tail || undefined };
  if (kind === "data" && !(engine in LOAD) && engine !== "libsql") return { engine: "", ...hostPart(rest.length ? `${engine}:${tail}` : engine) }; // declared by host ("localhost:5432")
  return { engine, ...hostPart(tail) };
}

function hostPart(tail: string): { host?: string; port?: number; database?: string } {
  if (!tail) return {};
  const slash = tail.indexOf("/");
  const hp = slash < 0 ? tail : tail.slice(0, slash);
  const database = slash < 0 ? undefined : tail.slice(slash + 1) || undefined;
  const m = /^(.*?)(?::(\d+))?$/.exec(hp)!;
  return { host: m[1] || undefined, port: m[2] ? Number(m[2]) : undefined, database };
}

/** The project source that best matches a lane: same host, port and database beats same engine. */
export function pick(id: string, sources: Source[]): { source: Source; database?: string } | undefined {
  const p = parsePlace(id);
  const engines: Engine[] = p.engine === "supabase" ? ["postgres", "supabase"] : p.engine === "libsql" ? [] : p.engine ? [p.engine as Engine] : ["postgres", "mysql", "mongodb"];
  let best: { s: Source; score: number } | undefined;
  for (const s of sources) {
    if (!engines.includes(s.engine)) continue;
    if (p.engine === "supabase" && s.engine === "postgres" && !s.supabase) continue;
    let score = 1;
    if (s.engine === "sqlite") {
      if (p.file && s.file && !s.file.endsWith(`/${p.file}`) && s.file !== p.file) continue;
      score = p.file ? 3 : 1;
    } else if (!p.engine && !p.host) continue;
    else if (p.host) {
      const sameHost = normHost(s.host) === normHost(p.host);
      const samePort = !p.port || !s.port || s.port === p.port;
      if (p.engine === "supabase") score = sameHost || isLocal(p.host) ? (s.engine === "postgres" ? 4 : 3) : 0; // its own database beats the API
      else if (sameHost && samePort) score = 2 + (p.database && s.database === p.database ? 1 : 0);
      else continue; // a lane on a host the project's settings don't mention
    }
    if (score && (!best || score > best.score)) best = { s, score };
  }
  return best && { source: best.s, database: p.database };
}

function label(s: Source, root: string): string {
  if (s.engine === "sqlite") {
    const file = s.file ? relative(root, s.file) : "";
    return file && file !== s.from ? `${file}, from ${s.from}.` : `${s.from}.`;
  }
  const at = `${normHost(s.host)}${s.port ? `:${s.port}` : ""}`;
  const remote = !isLocal(s.host) ? ` This database is not on this machine; Shrike only reads it.` : "";
  return `${at}, from ${s.from}.${remote}`;
}

let cache: { root: string; at: number; sources: Source[] } | undefined;
function sourcesFor(root: string): Source[] {
  // ponytail: rescanned at most every 5 s; settings files rarely change while a lane is open.
  if (cache?.root !== root || Date.now() - cache.at > 5000) cache = { root, at: Date.now(), sources: discover(root) };
  return cache.sources;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`Reading ${what} took longer than ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS)))]).finally(() => clearTimeout(t));
}

// Driver errors can carry the connection string; only plain words leave main.
export function plainError(e: unknown, s: Source): Error {
  const msg = String((e as { message?: unknown })?.message ?? e);
  const code = String((e as { code?: unknown })?.code ?? "");
  const at = `${normHost(s.host)}${s.port ? `:${s.port}` : ""}`;
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect ETIMEDOUT|Server selection timed out|Connection is closed/i.test(msg + code)) return new Error(`Shrike couldn't reach the database at ${at}. Is it running?`);
  if (/password|authentication|access denied|auth failed|NOAUTH|WRONGPASS|28P01|ER_ACCESS_DENIED/i.test(msg + code)) return new Error(`The database at ${at} turned down the login from ${s.from}.`);
  if (/took longer than/.test(msg)) return new Error(msg);
  let safe = msg;
  for (const secret of [s.url, s.key].filter(Boolean) as string[]) safe = safe.split(secret).join("[connection settings]");
  return new Error(safe.replace(/\b[a-z][\w+.-]*:\/\/[^\s'"]+/gi, "[connection settings]").slice(0, 300));
}

/** A read from the project's own settings, or undefined when Shrike knows no way in for this lane. */
export function directInspect(root: string, req: InspectRequest, sources = sourcesFor(root)): Promise<InspectResult> | undefined {
  const hit = pick(req.placeId, sources);
  if (!hit) return undefined;
  const s = hit.source;
  return withTimeout(
    LOAD[s.engine]().then((reader) => {
      const fn = reader[req.op] as ((s: Source, req: InspectRequest, ctx: Ctx) => Promise<InspectResult>) | undefined;
      if (!fn) throw new Error(`Shrike can't show that for this ${s.engine === "redis" ? "cache" : "database"}.`);
      return req.op === "tables" ? (fn as unknown as (s: Source, ctx: Ctx) => Promise<InspectResult>)(s, { database: hit.database, how: label(s, root) }) : fn(s, req, { database: hit.database, how: label(s, root) });
    }),
    `the ${s.engine} database`,
  ).catch((e) => {
    throw plainError(e, s);
  });
}

export const MAX_CELL = 300;
export const clamp = (v: number | undefined, lo: number, hi: number, d: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v!)) : d);
/** One cell for the grid: dates as ISO text, bytes as a size, objects as JSON, all cut to 300 characters. */
export function cell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  const s = typeof v === "string" ? v : typeof (v as { toHexString?: unknown }).toHexString === "function" ? (v as { toHexString(): string }).toHexString() : safeJson(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x && typeof x === "object" && typeof x.toHexString === "function" ? x.toHexString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
}
