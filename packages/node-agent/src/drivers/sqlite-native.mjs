// better-sqlite3 and libsql (the engine under @libsql/client's file: URLs) -> db_query. Both are sync and share
// one API: db.prepare(sql) -> statement.run/get/all/iterate. Write capture reuses node:sqlite's (same SQL, same calls).
import path from "node:path";
import { libCall, quietly } from "../runtime.mjs";
import { planWrite, settleWrite } from "../sqlite.mjs";
import { dbEvent, once } from "./common.mjs";

const stmts = new WeakMap(); // statement -> { sql, db }
const places = new WeakMap(); // db -> place

function placeOf(db, prepare) {
  let p = places.get(db);
  if (p) return p;
  let file = "";
  try {
    file = prepare.call(db, "PRAGMA database_list").all().find((r) => r.name === "main")?.file ?? "";
  } catch {}
  const name = file ? path.basename(file) : ":memory:";
  p = { kind: "data", id: `data:sqlite:${name}`, name: `SQLITE · ${name}` };
  places.set(db, p);
  return p;
}

const flat = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);

function patchStatement(proto) {
  if (!once(proto)) return;
  for (const name of ["run", "get", "all", "iterate"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const patched = {
      [name](...args) {
        const s = stmts.get(this);
        if (!s) return orig.apply(this, args);
        let plan;
        return libCall(
          patched,
          () => {
            const params = flat(args);
            if (name !== "iterate") plan = planWrite(s.sql, s.db, params);
            return { ...dbEvent("sqlite", s.place, s.sql, params) };
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

/** better-sqlite3's or libsql's Database class (the package's main export). */
export function patchSqliteNative(mod) {
  const Database = typeof mod === "function" ? mod : mod?.default;
  const proto = Database?.prototype;
  const prepare = proto?.prepare;
  if (typeof prepare !== "function" || !once(proto)) return;
  proto.prepare = function prepare_(sql) {
    const stmt = prepare.apply(this, arguments);
    quietly(() => {
      patchStatement(Object.getPrototypeOf(stmt));
      stmts.set(stmt, { sql: String(sql), db: this, place: placeOf(this, prepare) });
    });
    return stmt;
  };
}
