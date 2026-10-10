import path from "node:path";
import { changeOf, quote, remember, writeOf } from "./inspect.mjs";
import { preview } from "./preview.mjs";
import { libCall } from "./runtime.mjs";

function place(db) {
  const dir = typeof db.dataDir === "string" ? db.dataDir.replace(/^[a-z]+:\/\//, "") : "";
  const name = dir ? path.basename(dir) || dir : "memory";
  return { kind: "data", id: `data:postgres:${dir || "memory"}`, name: `POSTGRES · ${name}` };
}

// query() and exec() live on PGlite's base class; db.sql`` goes through query().
export function patchPglite({ PGlite }) {
  let proto = PGlite?.prototype;
  while (proto && !Object.hasOwn(proto, "query")) proto = Object.getPrototypeOf(proto);
  if (!proto || proto.__shrike) return;
  Object.defineProperty(proto, "__shrike", { value: true });
  for (const name of ["query", "exec"]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    const patched = {
      [name](sql, ...rest) {
        try {
          remember(place(this), "postgres", this);
        } catch {}
        let plan;
        return libCall(
          patched,
          () => {
            const statement = String(sql);
            const params = name === "query" && Array.isArray(rest[0]) && rest[0].length ? preview(rest[0]) : undefined;
            // ponytail: I3 follows query() only; exec() can hold several statements.
            if (name === "query") plan = writeOf(statement);
            return {
              origin: "db",
              kind: "db_query",
              name: statement.replace(/\s+/g, " ").trim().slice(0, 60),
              db: { system: "postgres", statement, params },
              place: place(this),
            };
          },
          () => (plan?.where && Array.isArray(rest[0]) ? captured(this, orig, plan, sql, rest) : orig.call(this, sql, ...rest)),
          (event, v) => {
            try {
              if (plan) event.change = changeOf(plan, v?.affectedRows ?? v?.rows?.length, { before: plan.before, after: plan.op === "insert" ? (plan.returning ? v?.rows : undefined) : (plan.after ?? (plan.returning ? v?.rows : undefined)) });
            } catch {}
          },
        );
      },
    }[name];
    proto[name] = patched;
  }
}

// I3: one lookup by the WHERE key before (and, for an update, after) the app's own statement. The app gets its own result.
async function captured(db, orig, plan, sql, rest) {
  const value = rest[0][plan.where.index];
  const select = () => orig.call(db, `SELECT * FROM ${quote(plan.table)} WHERE ${quote(plan.where.col)} = $1 LIMIT 5`, [value]).then((r) => r.rows, () => undefined);
  if (value !== undefined) plan.before = await select();
  const result = await orig.call(db, sql, ...rest);
  if (value !== undefined && plan.op === "update") plan.after = await select();
  return result;
}
