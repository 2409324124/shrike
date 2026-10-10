// MySQL / MariaDB look-inside: one connection, the session and the transaction both READ ONLY, rolled back.
import mysql from "mysql2/promise";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

const quote = (id: string) => `\`${id.replaceAll("`", "``")}\``;
const like = (s: string) => `%${s.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** Runs `fn` inside START TRANSACTION READ ONLY on a READ ONLY session. Exported for the read-only test. */
export async function readOnly<T>(s: Source, database: string | undefined, fn: (q: Q, db: string) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({ uri: s.url, connectTimeout: 4000, multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  conn.on("error", () => {});
  try {
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    await conn.query("SET SESSION max_execution_time = 4000").catch(() => {}); // MariaDB names it differently
    await conn.query("START TRANSACTION READ ONLY");
    const q: Q = async (sql, params) => (await conn.query({ sql, timeout: 6000 }, params ?? []))[0] as Record<string, unknown>[];
    const db = s.database ?? database ?? String((await q("SELECT DATABASE() AS d"))[0]?.d ?? "");
    if (!db) throw new Error(`The settings in ${s.from} don't name a database.`);
    return await fn(q, db);
  } finally {
    await conn.query("ROLLBACK").catch(() => {});
    await conn.end().catch(() => conn.destroy());
  }
}

async function schema(q: Q, db: string) {
  const tables = (await q("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY 1", [db])).map((r) => String(r.t));
  const cols = await q("SELECT TABLE_NAME AS t, COLUMN_NAME AS n, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [db]);
  return tables.map((t) => ({ name: t, ref: `${quote(db)}.${quote(t)}`, columns: cols.filter((c) => c.t === t).map((c) => ({ name: String(c.n), pk: c.k === "PRI" })) }));
}

export function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, ctx.database, async (q, db) => {
    const list = await schema(q, db);
    const counts = list.length ? (await q(`SELECT ${list.map((t, i) => `(SELECT COUNT(*) FROM ${t.ref}) AS c${i}`).join(", ")}`))[0]! : {};
    return { op: "tables", system: "mysql", how: `a read-only transaction on ${ctx.how}`, tables: list.map((t, i) => ({ name: t.name, columns: t.columns, rows: Number(counts[`c${i}`] ?? 0) })) };
  });
}

export function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, ctx.database, async (q, db) => {
    const t = (await schema(q, db)).find((x) => x.name === o.table);
    if (!t) throw new Error(`There's no table called ${o.table} here.`);
    const cols = t.columns.map((c) => c.name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const where = o.search ? ` WHERE ${cols.map((c) => `CAST(${quote(c)} AS CHAR) LIKE ?`).join(" OR ")}` : "";
    const params = o.search ? cols.map(() => like(o.search!)) : [];
    const order = o.orderBy && cols.includes(o.orderBy) ? ` ORDER BY ${quote(o.orderBy)} ${o.desc ? "DESC" : "ASC"}` : pk.length ? ` ORDER BY ${pk.map(quote).join(", ")}` : "";
    const res = await q(`SELECT * FROM ${t.ref}${where}${order} LIMIT ${clamp(o.limit, 1, 200, 100)} OFFSET ${clamp(o.offset, 0, 10_000_000, 0)}`, params);
    const total = Number((await q(`SELECT COUNT(*) AS n FROM ${t.ref}${where}`, params))[0]?.n ?? 0);
    return { op: "rows", table: t.name, columns: cols, pk, rows: res.map((r) => cols.map((c) => cell(r[c]))), total };
  });
}
