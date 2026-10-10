// mysql2 (and Sequelize, TypeORM, Knex, Drizzle on top of it) -> db_query. The callback API is the core;
// mysql2/promise calls it with a callback, so only callback calls are recorded (streams pass through).
import { dbEvent, once, ownerOf, serverPlace, sqlChange, tracked } from "./common.mjs";

const places = new WeakMap();

function placeOf(o) {
  let p = places.get(o);
  if (!p) {
    const c = o.config?.connectionConfig ?? o.config ?? {};
    p = serverPlace("mysql", c.socketPath ? "localhost" : c.host, c.port ?? 3306, c.database);
    places.set(o, p);
  }
  return p;
}

function patchMethods(proto) {
  if (!once(proto)) return;
  for (const name of ["query", "execute"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const patched = {
      [name](sql, values, cb) {
        const text = typeof sql === "string" ? sql : sql?.sql;
        const callback = typeof values === "function" ? values : cb;
        // A prepared Query command (the pool hands its own to the connection) keeps its own callback.
        if (typeof text !== "string" || typeof callback !== "function" || typeof sql?.onResult === "function") return orig.apply(this, arguments);
        const params = Array.isArray(values) ? values : typeof values === "object" && values ? values : sql?.values;
        return tracked(
          patched,
          () => dbEvent("mysql", placeOf(this), text, params),
          (event, r) => {
            const head = Array.isArray(r) ? undefined : r;
            if (head && typeof head.affectedRows === "number") {
              const change = sqlChange(text, Array.isArray(params) ? params : [], head.affectedRows);
              if (change) {
                if (change.op === "insert" && head.insertId && change.rows?.length === 1) change.rows[0] = { pk: String(head.insertId), after: { id: head.insertId, ...change.rows[0].after } };
                event.change = change;
              }
            } else if (Array.isArray(r)) event.returned = `${r.length} row${r.length === 1 ? "" : "s"}`;
          },
          (wrapped) => (typeof values === "function" ? orig.call(this, sql, wrapped) : orig.call(this, sql, values, wrapped)),
          callback,
        );
      },
    }[name];
    proto[name] = patched;
  }
}

/** lib/base/connection.js, lib/connection.js, lib/base/pool.js or lib/pool.js of mysql2. */
export function patchMysql(mod) {
  const cls = typeof mod === "function" ? mod : mod?.default;
  const proto = ownerOf(cls, "query");
  if (proto) patchMethods(proto);
}
