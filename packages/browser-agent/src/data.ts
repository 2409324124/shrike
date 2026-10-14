// Databases the page talks to directly (docs/13 DB, "see it run" in the browser): Supabase (PostgREST, auth) and
// Firestore (WebChannel streams and REST). Their requests become db_query events on the database's own lane.
// Pure: no window access, so test/data.test.ts runs it in Node. Mirrors node-agent drivers/http.mjs for Supabase.
import type { Cell, DataChange, DebugEvent, Place } from "@shrike/schema";

export type DataKind = "supabase" | "firestore" | "skip";
type Headers = Record<string, string>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "0.0.0.0", "localhost"]);
const hostKey = (u: URL) => {
  const h = LOOPBACK.has(u.hostname) ? "localhost" : u.hostname;
  return u.port && u.port !== (u.protocol === "https:" ? "443" : "80") ? `${h}:${u.port}` : h;
};
const FS_CHANNEL = /\/google\.firestore\.v1\.Firestore\/(Write|Listen)\/channel$/;
const FS_REST = /^\/v1\/projects\/([^/]+)\/databases\/([^/]+)\/documents(?:\/(.*?))?(:\w+)?$/;

const DEV_PATH = /^\/(__nextjs_|_next\/webpack-hmr|__webpack_hmr|__vite_ping)/; // the dev server's own calls (Next overlay, HMR), not the app's

/** At request start: a database call, a stream's plumbing to leave out, or a plain request (undefined). */
export function dataKind(url: URL, method: string, headers: Headers): DataKind | undefined {
  const p = url.pathname;
  if (DEV_PATH.test(p)) return "skip";
  if (/^\/(rest|auth)\/v1\//.test(p) && (url.hostname.endsWith(".supabase.co") || "apikey" in headers || /^supabase/.test(headers["x-client-info"] ?? ""))) return "supabase";
  if (FS_CHANNEL.test(p)) return method === "POST" && url.searchParams.get("TYPE") !== "terminate" ? "firestore" : "skip"; // GETs are the long-poll back channel
  if (FS_REST.test(p)) return "firestore";
  return undefined;
}

const json = (s: string | undefined): unknown => {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const cell = (v: unknown): Cell =>
  v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : clip(typeof v === "string" ? v : JSON.stringify(v), 2000);
const rowOf = (o: unknown): Record<string, Cell> => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).slice(0, 50).map(([k, v]) => [k, cell(v)]));
const plural = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

function failure(ev: DebugEvent): DebugEvent["error"] | undefined {
  if (ev.error) return ev.error;
  const s = ev.http?.status ?? 0;
  if (s < 400) return undefined;
  const b = json(ev.http?.resBody) as { message?: string; msg?: string; error_description?: string; error?: { message?: string } } | undefined;
  return { message: `${s} ${clip(b?.message ?? b?.msg ?? b?.error_description ?? b?.error?.message ?? ev.http?.resBody ?? "", 300)}`.trim() };
}

function asQuery(ev: DebugEvent, place: Place, system: string, statement: string, params?: unknown[]): DebugEvent {
  const out: DebugEvent = { ...ev, kind: "db_query", name: clip(statement.replace(/\s+/g, " "), 60), db: { system, statement }, place };
  if (params?.length) out.db!.params = clip(JSON.stringify(params), 2000);
  const err = failure(ev);
  if (err) Object.assign(out, { error: err, status: "error" });
  return out;
}

// ---- Supabase: GET /rest/v1/notes?select=*&id=eq.3, POST /auth/v1/token?grant_type=password

const VERB: Record<string, string> = { POST: "INSERT INTO", PUT: "UPSERT INTO", DELETE: "DELETE FROM" };
const AUTH: Record<string, string> = {
  signup: "sign up", logout: "sign out", user: "get the signed-in user", recover: "send a password reset", otp: "send a sign-in code",
  ".well-known": "read the signing keys", verify: "verify a code", magiclink: "send a magic link", authorize: "sign in with a provider", resend: "resend a confirmation", settings: "read auth settings",
};

function supabase(ev: DebugEvent, url: URL): DebugEvent {
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
  const host = hostKey(url);
  const place: Place = { kind: "data", id: `data:supabase:${host}`, name: `SUPABASE · ${ref ?? host}`, detail: host };
  const method = ev.http?.method ?? "GET";
  const auth = /^\/auth\/v1\/(.+?)\/?$/.exec(url.pathname)?.[1];
  if (auth) {
    const grant = url.searchParams.get("grant_type");
    const what = auth === "token" ? (grant === "refresh_token" ? "refresh the session" : `sign in${grant ? ` with ${grant.replace(/_/g, " ")}` : ""}`) : (AUTH[auth.split("/")[0]!] ?? `${method} ${auth}`);
    const out = asQuery(ev, place, "supabase", `${what} (auth)`); // not "auth: x", which main redacts as a secret
    const res = (json(ev.http?.resBody) ?? {}) as Record<string, unknown> & { user?: Record<string, unknown> };
    const u = res.user ?? res;
    if (auth === "signup" && out.status !== "error" && u.id) out.change = { table: "auth.users", op: "insert", count: 1, rows: [{ pk: String(u.id), after: rowOf({ id: u.id, email: u.email, created_at: u.created_at }) }] };
    return out;
  }
  const m = /^\/rest\/v1\/(rpc\/)?([^/?]+)\/?$/.exec(url.pathname);
  if (!m) return asQuery(ev, place, "postgres", `${method} ${url.pathname}`);
  const table = decodeURIComponent(m[2]!);
  const q = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "apikey"));
  const select = q.select ?? "*";
  const filters = Object.entries(q).filter(([k]) => !["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k));
  const where = filters.length ? ` WHERE ${filters.map(([k], i) => `${k} = $${i + 1}`).join(" AND ")}` : "";
  const statement = m[1] ? `SELECT ${table}()`
    : method === "GET" || method === "HEAD" ? `SELECT ${select} FROM ${table}${where}`
    : method === "PATCH" ? `UPDATE ${table} SET …${where}`
    : `${VERB[method] ?? method} ${table}${method === "DELETE" ? where : ""}`;
  const out = asQuery(ev, place, "postgres", statement, filters.map(([, v]) => v.replace(/^\w+\./, "")));
  const body = json(ev.http?.resBody);
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && !("code" in body) ? [body] : [];
  const op: DataChange["op"] | undefined = m[1] ? undefined : method === "POST" || method === "PUT" ? "insert" : method === "PATCH" ? "update" : method === "DELETE" ? "delete" : undefined;
  if (op && out.status !== "error") {
    const range = /\/(\d+)$/.exec(ev.http?.resHeaders?.["content-range"] ?? "")?.[1];
    const after = rows.length ? rows : op === "insert" ? [json(ev.http?.reqBody)].flat().filter((x) => x && typeof x === "object") : [];
    const count = rows.length || (range !== undefined ? Number(range) : op === "insert" && after.length ? after.length : undefined); // unknown stays unset, not 0
    out.change = { table, op, ...(count !== undefined && { count }), rows: after.slice(0, 5).map((r) => (op === "delete" ? { before: rowOf(r) } : { after: rowOf(r) })) };
  } else if (Array.isArray(body)) out.returned = plural(body.length);
  return out;
}

// ---- Firestore: WebChannel POST bodies (count=1&ofs=0&req0___data__={...}) and the REST API

type FsValue = Record<string, unknown>;
type FsWrite = {
  update?: { name: string; fields?: Record<string, FsValue> };
  delete?: string;
  updateMask?: unknown;
  currentDocument?: { exists?: boolean };
  updateTransforms?: FsTransform[];
  transform?: { document: string; fieldTransforms?: FsTransform[] };
};
type FsTransform = { fieldPath: string; increment?: FsValue; setToServerValue?: string; appendMissingElements?: unknown; removeAllFromArray?: unknown; maximum?: FsValue; minimum?: FsValue };
type FsField = { field: { fieldPath: string } };
type FsFilter = { fieldFilter?: FsField & { op: string; value: FsValue }; unaryFilter?: FsField & { op: string }; compositeFilter?: { op: string; filters?: FsFilter[] } };
type FsQuery = { from?: { collectionId: string }[]; where?: FsFilter; orderBy?: { field: { fieldPath: string }; direction?: string }[]; limit?: number | { value: number } };

function plain(v: FsValue | undefined): unknown {
  if (!v) return null;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("referenceValue" in v) return String(v.referenceValue).split("/documents/")[1];
  if ("mapValue" in v) return Object.fromEntries(Object.entries((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {}).map(([k, x]) => [k, plain(x)]));
  if ("arrayValue" in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(plain);
  for (const k of ["stringValue", "doubleValue", "booleanValue", "timestampValue", "geoPointValue"]) if (k in v) return v[k];
  return "nullValue" in v ? null : "<bytes>";
}
const fields = (f: Record<string, FsValue> | undefined) => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, plain(v)]));
const docPath = (name: string) => (/\/documents(\/|$)/.test(name) ? name.replace(/^.*?\/documents(\/|$)/, "") : name);
const split = (path: string) => {
  const i = path.lastIndexOf("/");
  return { coll: path.slice(0, i), id: path.slice(i + 1) };
};
const transformWords = (t: FsTransform) =>
  t.increment ? `increment(${plain(t.increment)})` : t.setToServerValue ? "server time" : t.appendMissingElements ? "array union" : t.removeAllFromArray ? "array remove" : t.maximum ? `max(${plain(t.maximum)})` : t.minimum ? `min(${plain(t.minimum)})` : "transform";

interface FsOp {
  statement: string;
  params?: unknown[];
  change?: DataChange;
}

function writeOp(w: FsWrite): FsOp | undefined {
  const name = w.update?.name ?? w.delete ?? w.transform?.document;
  if (!name) return undefined;
  const { coll, id } = split(docPath(name));
  if (w.delete) return { statement: `db.${coll}.delete("${id}")`, change: { table: coll, op: "delete", count: 1, rows: [{ pk: id }] } };
  const after: Record<string, unknown> = fields(w.update?.fields);
  for (const t of w.updateTransforms ?? w.transform?.fieldTransforms ?? []) after[t.fieldPath] = transformWords(t);
  const insert = w.currentDocument?.exists === false;
  const verb = insert ? "add" : w.updateMask || !w.update ? "update" : "set";
  const shown = Object.keys(after).length ? `, ${clip(JSON.stringify(after), 200)}` : "";
  return { statement: `db.${coll}.${verb}("${id}"${shown})`, change: { table: coll, op: insert ? "insert" : "update", count: 1, rows: [{ pk: id, after: rowOf({ id, ...after }) }] } };
}

function queryOp(q: FsQuery, parent = ""): FsOp {
  const base = docPath(parent);
  const coll = [base, q.from?.[0]?.collectionId].filter(Boolean).join("/") || "?";
  const parts: string[] = [];
  const where = (f: FsFilter): string =>
    f.fieldFilter ? `${f.fieldFilter.field.fieldPath} ${f.fieldFilter.op} ${JSON.stringify(plain(f.fieldFilter.value))}`
    : f.unaryFilter ? `${f.unaryFilter.field.fieldPath} ${f.unaryFilter.op}`
    : f.compositeFilter ? (f.compositeFilter.filters ?? []).map(where).join(` ${f.compositeFilter.op} `) : "";
  if (q.where) parts.push(`where ${where(q.where)}`);
  if (q.orderBy?.length) parts.push(`order by ${q.orderBy.map((o) => `${o.field.fieldPath}${o.direction === "DESCENDING" ? " desc" : ""}`).join(", ")}`);
  const limit = typeof q.limit === "number" ? q.limit : q.limit?.value;
  if (limit) parts.push(`limit ${limit}`);
  return { statement: `db.${coll}.query(${parts.join(", ")})` };
}

type FsMessage = { writes?: FsWrite[]; addTarget?: { documents?: { documents?: string[] }; query?: { structuredQuery?: FsQuery; parent?: string } } };

function channelOps(msg: FsMessage): FsOp[] {
  if (Array.isArray(msg.writes)) return msg.writes.map(writeOp).filter((x): x is FsOp => !!x);
  const t = msg.addTarget;
  if (!t) return []; // stream handshake, removeTarget
  if (t.documents?.documents) return t.documents.documents.map((d) => {
    const { coll, id } = split(docPath(d));
    return { statement: `db.${coll}.get("${id}")` };
  });
  if (t.query?.structuredQuery) return [queryOp(t.query.structuredQuery, t.query.parent)];
  return [];
}

function firestoreOps(url: URL, method: string, body: string | undefined): FsOp[] {
  if (FS_CHANNEL.test(url.pathname)) {
    const msgs: FsOp[] = [];
    for (const [k, v] of new URLSearchParams(body ?? "")) if (/^req\d+___data__$/.test(k)) msgs.push(...channelOps((json(v) as FsMessage | undefined) ?? {}));
    return msgs;
  }
  const m = FS_REST.exec(url.pathname)!;
  const b = (json(body) ?? {}) as { writes?: FsWrite[]; structuredQuery?: FsQuery; documents?: string[]; fields?: Record<string, FsValue> };
  if (m[4] === ":commit") return channelOps({ writes: b.writes ?? [] });
  if (m[4] === ":runQuery" && b.structuredQuery) return [queryOp(b.structuredQuery, m[3] ? `/documents/${m[3]}` : "")];
  if (m[4] === ":batchGet") return (b.documents ?? []).map((d) => channelOps({ addTarget: { documents: { documents: [d] } } })[0]!);
  const path = decodeURIComponent(m[3] ?? "");
  if (!path) return [];
  if (method === "GET") return path.split("/").length % 2 ? [{ statement: `db.${path}.query()` }] : channelOps({ addTarget: { documents: { documents: [path] } } });
  if (method === "DELETE") return [writeOp({ delete: path })!];
  if (method === "PATCH") return [writeOp({ update: { name: path, fields: b.fields }, updateMask: url.searchParams.has("updateMask.fieldPaths") || undefined })!];
  if (method === "POST") return [writeOp({ update: { name: `${path}/${url.searchParams.get("documentId") ?? "(new)"}`, fields: b.fields }, currentDocument: { exists: false } })!];
  return [];
}

/** At settle: the events to emit for a recorded request (none for stream plumbing, several for a batch). */
export function toData(ev: DebugEvent, url: URL, kind: DataKind, newId: () => string): DebugEvent[] {
  if (kind === "supabase") return [supabase(ev, url)];
  if (kind !== "firestore") return [];
  const raw = FS_CHANNEL.test(url.pathname) ? new URLSearchParams(url.search).get("database") ?? "" : url.pathname;
  const project = /projects\/([^/]+)/.exec(decodeURIComponent(raw))?.[1] ?? "?";
  const host = hostKey(url);
  const place: Place = { kind: "data", id: `data:firestore:${host}/${project}`, name: `FIRESTORE · ${project}`, detail: host };
  // ponytail: a write's result comes back on the back channel; only the POST's own status is seen here.
  return firestoreOps(url, ev.http?.method ?? "GET", ev.http?.reqBody).map((op, i) => {
    const out = asQuery({ ...ev, id: i ? newId() : ev.id }, place, "firestore", op.statement, op.params);
    if (op.change && out.status !== "error") out.change = op.change;
    return out;
  });
}
