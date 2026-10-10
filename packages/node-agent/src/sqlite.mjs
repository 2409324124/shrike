import path from "node:path";
import { changeOf, quote, remember, writeOf } from "./inspect.mjs";
import { preview } from "./preview.mjs";
import { libCall } from "./runtime.mjs";

const stmts = new WeakMap(); // StatementSync -> { place, db }
const pks = new WeakMap(); // DatabaseSync -> Map(table -> primary key columns)

function dbPlace(db) {
  let file = ":memory:";
  try {
    const loc = db.location?.();
    if (loc) file = path.basename(loc);
  } catch {}
  return { kind: "data", id: `data:sqlite:${file}`, name: `SQLITE · ${file}` };
}

export function patchSqlite({ DatabaseSync, StatementSync }) {
  const dbProto = DatabaseSync?.prototype;
  const proto = StatementSync?.prototype;
  if (!proto || !dbProto || proto.__shrike) return;
  Object.defineProperty(proto, "__shrike", { value: true });

  const prepare = dbProto.prepare;
  if (typeof prepare === "function") {
    dbProto.prepare = function prepare_(...args) {
      const stmt = prepare.apply(this, args);
      try {
        const place = dbPlace(this);
        stmts.set(stmt, { place, db: this });
        remember(place, "sqlite", this);
      } catch {}
      return stmt;
    };
  }

  for (const name of ["run", "get", "all", "iterate"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const patched = {
      [name](...args) {
        let plan;
        return libCall(
          patched,
          () => {
            const e = build(this, args);
            if (name !== "iterate") plan = planWrite(e.db.statement, stmts.get(this)?.db, args);
            return e;
          },
          () => orig.apply(this, args),
          (event, v) => {
            try {
              if (plan) event.change = settleWrite(plan, name, v);
            } catch {}
          },
        );
      },
    }[name];
    proto[name] = patched;
  }
}

function build(stmt, args) {
  const sql = String(typeof stmt.sourceSQL === "function" ? stmt.sourceSQL() : stmt.sourceSQL);
  return {
    origin: "db",
    kind: "db_query",
    name: sql.replace(/\s+/g, " ").trim().slice(0, 60),
    db: { system: "sqlite", statement: sql, params: args.length ? preview(args) : undefined },
    place: stmts.get(stmt)?.place ?? { kind: "data", id: "data:sqlite:unknown", name: "SQLITE" },
  };
}

// I3. Runs inside libCall's quiet build/settle (Shrike busy), so these extra reads are never recorded.
function pkCols(db, table) {
  let m = pks.get(db);
  if (!m) pks.set(db, (m = new Map()));
  if (!m.has(table)) m.set(table, db.prepare(`PRAGMA table_info(${quote(table)})`).all().filter((c) => c.pk > 0).map((c) => c.name));
  return m.get(table);
}

export function planWrite(sql, db, args) {
  const w = db && writeOf(sql);
  if (!w) return undefined;
  const plan = { ...w, db };
  try {
    plan.pk = pkCols(db, w.table);
    const value = w.where && !(args[0] && typeof args[0] === "object") ? args[w.where.index] : undefined;
    if (value !== undefined) {
      plan.select = () => db.prepare(`SELECT * FROM ${quote(w.table)} WHERE ${quote(w.where.col)} = ? LIMIT 5`).all(value);
      plan.before = plan.select();
    }
  } catch {}
  return plan;
}

export function settleWrite(plan, method, v) {
  const { db } = plan;
  const { n, r } = db.prepare("SELECT changes() AS n, last_insert_rowid() AS r").get();
  const returned = plan.returning ? (method === "all" ? v : v ? [v] : []) : undefined;
  let after;
  if (plan.op === "insert") after = returned ?? (n === 1 ? db.prepare(`SELECT * FROM ${quote(plan.table)} WHERE rowid = ?`).all(r) : undefined);
  else if (plan.op === "update") after = plan.select?.() ?? returned;
  return changeOf(plan, n, { before: plan.before, after, pk: plan.pk });
}
