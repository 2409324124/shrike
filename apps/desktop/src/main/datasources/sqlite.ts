// SQLite look-inside: the file opened read-only by node:sqlite (Electron's Node), closed after each read.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
const like = (s: string) => `%${s.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;

/** Exported for the read-only test. */
export function readOnly<T>(s: Source, fn: (db: DatabaseSync) => T): Promise<T> {
  if (!s.file || !existsSync(s.file)) return Promise.reject(new Error(`The database file from ${s.from} isn't there yet.`));
  const db = new DatabaseSync(s.file, { readOnly: true, timeout: 2000 });
  try {
    return Promise.resolve(fn(db));
  } catch (e) {
    return Promise.reject(e);
  } finally {
    db.close();
  }
}

function schema(db: DatabaseSync) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => ({
    name,
    columns: (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; pk: number }[]).map((c) => ({ name: c.name, pk: c.pk > 0 })),
  }));
}

export function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, (db) => ({
    op: "tables" as const,
    system: "sqlite" as const,
    how: `the file ${ctx.how}`,
    tables: schema(db).map((t) => ({ ...t, rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`).get() as { n: number }).n) })),
  }));
}

export function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>): Promise<InspectResult> {
  return readOnly(s, (db) => {
    const t = schema(db).find((x) => x.name === o.table);
    if (!t) throw new Error(`There's no table called ${o.table} here.`);
    const cols = t.columns.map((c) => c.name);
    const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
    const where = o.search ? ` WHERE ${cols.map((c) => `CAST(${quote(c)} AS TEXT) LIKE ? ESCAPE '\\'`).join(" OR ")}` : "";
    const params = o.search ? cols.map(() => like(o.search!)) : [];
    const order = o.orderBy && cols.includes(o.orderBy) ? ` ORDER BY ${quote(o.orderBy)} ${o.desc ? "DESC" : "ASC"}` : pk.length ? ` ORDER BY ${pk.map(quote).join(", ")}` : "";
    const res = db.prepare(`SELECT * FROM ${quote(t.name)}${where}${order} LIMIT ${clamp(o.limit, 1, 200, 100)} OFFSET ${clamp(o.offset, 0, 10_000_000, 0)}`).all(...params) as Record<string, unknown>[];
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}${where}`).get(...params) as { n: number }).n);
    return { op: "rows" as const, table: t.name, columns: cols, pk, rows: res.map((r) => cols.map((c) => cell(r[c]))), total };
  });
}
