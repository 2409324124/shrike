// Prisma 4-6 (library engine) -> db_query. Its Rust engine talks to the database itself, so no Node driver sees the
// SQL. The engine is a native addon loaded with process.dlopen (also from bundled code: Next, Remix); its
// QueryEngine is swapped for a subclass that records each query() call and turns on the engine's query log to
// learn the SQL. The app only gets query log lines it asked for. Prisma 7 runs on JS driver adapters (pg,
// better-sqlite3, ...), which the driver hooks already see.
import path from "node:path";
import { preview } from "../preview.mjs";
import { libCall } from "../runtime.mjs";
import { changeOf, writeOf } from "../inspect.mjs";
import { LABEL, oneLine, serverPlace, urlParts } from "./common.mjs";

const SYSTEM = { postgresql: "postgres", postgres: "postgres", cockroachdb: "postgres", mysql: "mysql", sqlite: "sqlite", mongodb: "mongodb", sqlserver: "sqlserver" };
const QUIET = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET |SELECT 1\b)/i;

function placeOf(cfg) {
  const dm = String(cfg?.datamodel ?? "");
  const ds = /datasource\s+(\w+)\s*\{([^}]*)\}/.exec(dm);
  const provider = /provider\s*=\s*"(\w+)"/.exec(ds?.[2] ?? "")?.[1] ?? "";
  const system = SYSTEM[provider] ?? (provider || "prisma");
  const fromEnv = /url\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(ds?.[2] ?? "")?.[1];
  const url = cfg?.datasourceOverrides?.[ds?.[1] ?? "db"] ?? (fromEnv ? (cfg?.env?.[fromEnv] ?? process.env[fromEnv]) : /url\s*=\s*"([^"]+)"/.exec(ds?.[2] ?? "")?.[1]) ?? "";
  if (system === "sqlite") {
    const name = path.basename(String(url).replace(/^file:/, "").split("?")[0]) || "prisma.db";
    return { system, place: { kind: "data", id: `data:sqlite:${name}`, name: `SQLITE · ${name}` } };
  }
  const u = urlParts(url);
  if (LABEL[system]) return { system, place: serverPlace(system, u.host, u.port ?? { postgres: 5432, mysql: 3306, mongodb: 27017 }[system], u.database) };
  return { system, place: { kind: "data", id: `data:${system}`, name: system.toUpperCase() } };
}

/** Model name -> table name (@@map) from the datamodel, so a query log line finds the call it belongs to. */
function tablesOf(cfg) {
  const out = {};
  for (const m of String(cfg?.datamodel ?? "").matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)) out[m[1]] = /@@map\(\s*"([^"]+)"/.exec(m[2])?.[1] ?? m[1];
  return out;
}
const mentions = (sql, table) => sql.includes(`"${table}"`) || sql.includes(`\`${table}\``);
// Same selected columns: findMany { id, title } and findFirst { id, body, title } on one table running at once.
function sameColumns(sql, rec) {
  if (!rec.fields?.length) return false;
  const head = sql.split(/\bFROM\b/i)[0] ?? "";
  const cols = new Set();
  for (const q of ['"', "`"]) for (const part of head.split(`${q}${rec.table}${q}.${q}`).slice(1)) cols.add(part.slice(0, part.indexOf(q)));
  return cols.size === rec.fields.length && rec.fields.every((f) => cols.has(f));
}

const ACTION = { createOne: "insert", createMany: "insert", createManyAndReturn: "insert", updateOne: "update", updateMany: "update", updateManyAndReturn: "update", upsertOne: "update", deleteOne: "delete", deleteMany: "delete" };

// The engine's JSON protocol tags values: { $type: "DateTime", value: "2026-..." }; the row shows the value.
const plain = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === "object" && typeof v.$type === "string" && "value" in v ? v.value : v]));

function changeFrom(op, sqls, data) {
  const write = sqls.map((s) => writeOf(s)).find(Boolean);
  const row = data && typeof data === "object" ? Object.values(data)[0] : undefined;
  const table = write?.table ?? "";
  if (!table) return undefined;
  if (row && typeof row === "object" && !Array.isArray(row) && typeof row.count === "number") return changeOf({ op, table }, row.count);
  const rows = (Array.isArray(row) ? row : row ? [row] : []).filter((r) => r && typeof r === "object").map(plain);
  return changeOf({ op, table }, rows.length, op === "delete" ? { before: rows } : { after: rows });
}

function subclass(QueryEngine) {
  return class QueryEngine_ extends QueryEngine {
    constructor(cfg, log, ...rest) {
      const wants = !!cfg?.logQueries;
      const open = [];
      let where;
      let tables = {};
      try {
        where = placeOf(cfg);
        tables = tablesOf(cfg);
      } catch {}
      const logged = function (line) {
        if (typeof line === "string" && line.includes('"is_query":true')) {
          try {
            const q = JSON.parse(line);
            // Concurrent calls: the oldest open call on the line's table, else the newest call.
            // ponytail: two concurrent calls on one table can swap SQL; Prisma's tracing would pin it exactly.
            const named = open.filter((r) => r.table && mentions(q.query ?? "", r.table));
            const fresh = named.filter((r) => !r.sql.length);
            const rec = fresh.find((r) => sameColumns(q.query ?? "", r)) ?? fresh[0] ?? named[0] ?? open[open.length - 1];
            if (rec && typeof q.query === "string") rec.sql.push({ text: q.query, params: q.params });
            if (rec && !QUIET.test(q.query ?? "")) rec.wake?.();
          } catch {}
          if (!wants) return;
        }
        return log?.apply(this, arguments);
      };
      super(cfg && typeof cfg === "object" ? { ...cfg, logQueries: true } : cfg, logged, ...rest);
      Object.defineProperties(this, { __shrikeOpen: { value: open }, __shrikePlace: { value: where }, __shrikeTables: { value: tables } });
    }

    query(body) {
      const rec = { sql: [] };
      const where = this.__shrikePlace;
      if (!where) return super.query(...arguments);
      let req;
      return libCall(
        QueryEngine_.prototype.query,
        () => {
          req = JSON.parse(String(body));
          const first = req.batch?.[0] ?? req;
          rec.table = this.__shrikeTables[first.modelName];
          const sel = first.query?.selection ?? {};
          rec.fields = sel.$scalars ? undefined : Object.keys(sel).filter((k) => sel[k] === true);
          const statement = `${first.modelName ?? ""}${first.modelName ? "." : ""}${first.action ?? "query"}${req.batch ? ` (+${req.batch.length - 1} in a batch)` : ""}`;
          return { origin: "db", kind: "db_query", name: statement, db: { system: where.system, statement }, place: where.place };
        },
        () => {
          this.__shrikeOpen.push(rec);
          // The engine's log line can land a moment after the result; wait for it, at most 25 ms.
          const p = super.query(...arguments).then((v) =>
            rec.sql.some((x) => !QUIET.test(x.text))
              ? v
              : new Promise((resolve) => {
                  const go = () => (clearTimeout(t), resolve(v));
                  const t = setTimeout(go, 25);
                  rec.wake = go;
                }),
          );
          const off = () => this.__shrikeOpen.splice(this.__shrikeOpen.indexOf(rec) >>> 0, 1);
          p.then(off, off);
          return p;
        },
        (event, out) => {
          const sqls = rec.sql.map((s) => s.text).filter((s) => !QUIET.test(s));
          if (sqls.length) {
            // The write leads: lanes, station labels and the inspector read the statement's first line.
            const head = sqls.find((s) => writeOf(s)) ?? sqls[0];
            event.db.statement = [head, ...sqls.filter((s) => s !== head)].join(";\n");
            event.name = oneLine(head).slice(0, 60);
            const main = rec.sql.find((s) => s.text === head);
            try {
              const params = JSON.parse(main?.params ?? "[]");
              if (Array.isArray(params) && params.length) event.db.params = preview(params);
            } catch {}
          }
          let res;
          try {
            res = JSON.parse(String(out));
          } catch {
            return;
          }
          const results = res?.batchResult ?? [res];
          const failed = results.find((r) => r?.errors?.length);
          if (failed) {
            event.status = "error";
            event.error = { message: String(failed.errors[0].error ?? failed.errors[0].user_facing_error?.message ?? "Prisma query failed").slice(0, 2000), type: "PrismaClientKnownRequestError" };
            return;
          }
          const items = req?.batch ?? [req];
          const i = items.findIndex((x) => ACTION[x?.action]);
          if (i >= 0) {
            const c = changeFrom(ACTION[items[i].action], rec.sql.map((s) => s.text), results[i]?.data);
            if (c) event.change = c;
          }
        },
        true,
      );
    }
  };
}

/** Wraps process.dlopen so Prisma's query engine addon gets a recording QueryEngine. */
export function hookPrismaEngine() {
  const dlopen = process.dlopen;
  if (typeof dlopen !== "function" || dlopen.__shrike) return;
  const patched = function (module, filename) {
    const r = dlopen.apply(this, arguments);
    try {
      const QE = module?.exports?.QueryEngine;
      if (/query[_-]engine/i.test(String(filename)) && typeof QE === "function" && !QE.__shrike) {
        const Sub = subclass(QE);
        Object.defineProperty(Sub, "__shrike", { value: true });
        module.exports.QueryEngine = Sub;
      }
    } catch {}
    return r;
  };
  Object.defineProperty(patched, "__shrike", { value: true });
  process.dlopen = patched;
}
