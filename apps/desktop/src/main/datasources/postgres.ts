// Postgres (and Supabase's, Neon's) look-inside: one short connection, BEGIN READ ONLY, statements built here, ROLLBACK.
import pg from "pg";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
const like = (s: string) => `%${s.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
// Schemas that belong to Postgres itself, or to Supabase's own services.
const SYSTEM = /^(pg_.*|information_schema|auth|storage|realtime|_realtime|supabase_.*|extensions|graphql|graphql_public|vault|pgsodium.*|net|cron|_analytics|pgbouncer|drizzle)$/;

// date, timestamp and timestamptz as the database prints them: a timestamp without a zone isn't shifted to Shrike's clock.
const AS_TEXT = new Set([1082, 1114, 1184]);
const asStored = ((oid: number, format?: "text" | "binary") => (AS_TEXT.has(oid) ? (v: string) => v : pg.types.getTypeParser(oid, format as "text"))) as typeof pg.types.getTypeParser;

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

/** Runs `fn` inside a READ ONLY transaction that is always rolled back. Exported for the read-only test. */
export async function readOnly<T>(s: Source, fn: (q: Q) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: s.url, connectionTimeoutMillis: 4000, query_timeout: 6000, application_name: "shrike inspector (read only)", types: { getTypeParser: asStored } });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"); // also covers anything after a COMMIT
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 4000");
    return await fn((sql, params) => client.query(sql, params));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

interface Table {
  name: string;
  ref: string;
  columns: { name: string; pk: boolean }[];
}

async function schema(q: Q, s: Source): Promise<Table[]> {
  const tables = (await q(`SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`)).rows as { s: string; t: string }[];
  const cols = (await q(`SELECT table_schema AS s, table_name AS t, column_name AS n FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`)).rows as { s: string; t: string; n: string }[];
  const pks = (await q(`SELECT k.table_schema AS s, k.table_name AS t, k.column_name AS n FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k ON k.constraint_name = c.constraint_name AND k.table_schema = c.table_schema WHERE c.constraint_type = 'PRIMARY KEY'`)).rows as { s: string; t: string; n: string }[];
  const isPk = new Set(pks.map((p) => `${p.s}.${p.t}.${p.n}`));
  const user = tables.filter((t) => !SYSTEM.test(t.s));
  // A Supabase or managed database: hide the platform's own schemas when the app has tables of its own.
  const shown = s.supabase || user.length ? user : tables;
  return shown.map(({ s: sc, t }) => ({
    name: sc === "public" ? t : `${sc}.${t}`,
    ref: `${quote(sc)}.${quote(t)}`,
    columns: cols.filter((c) => c.s === sc && c.t === t).map((c) => ({ name: c.n, pk: isPk.has(`${sc}.${t}.${c.n}`) })),
  }));
}

export function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, async (q) => {
    const list = await schema(q, s);
    const counts = list.length ? (await q(`SELECT ${list.map((t, i) => `(SELECT COUNT(*) FROM ${t.ref}) AS c${i}`).join(", ")}`)).rows[0] : {};
    return { op: "tables", system: "postgres", how: `a read-only transaction on ${ctx.how}`, tables: list.map((t, i) => ({ name: t.name, columns: t.columns, rows: Number(counts[`c${i}`] ?? 0) })) };
  });
}

export function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>): Promise<InspectResult> {
  return readOnly(s, async (q) => {
    const t = (await schema(q, s)).find((x) => x.name === o.table);
    if (!t) throw new Error(`There's no table called ${o.table} here.`);
    const cols = t.columns.map((c) => c.name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const where = o.search ? ` WHERE ${cols.map((c) => `${quote(c)}::text ILIKE $1`).join(" OR ")}` : "";
    const params = o.search ? [like(o.search)] : [];
    const order = o.orderBy && cols.includes(o.orderBy) ? ` ORDER BY ${quote(o.orderBy)} ${o.desc ? "DESC" : "ASC"}` : pk.length ? ` ORDER BY ${pk.map(quote).join(", ")}` : "";
    const res = await q(`SELECT * FROM ${t.ref}${where}${order} LIMIT ${clamp(o.limit, 1, 200, 100)} OFFSET ${clamp(o.offset, 0, 10_000_000, 0)}`, params);
    const total = Number((await q(`SELECT COUNT(*) AS n FROM ${t.ref}${where}`, params)).rows[0].n);
    return { op: "rows", table: t.name, columns: cols, pk, rows: res.rows.map((r) => cols.map((c) => cell(r[c]))), total };
  });
}
