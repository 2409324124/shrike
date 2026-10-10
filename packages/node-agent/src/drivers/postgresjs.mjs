// postgres (postgres.js) -> db_query. Its queries are lazy Promise subclasses run by Query#handle(); the place
// comes from sql.options, matched through each sql instance's handler (learnt from one probe query, never run).
import { libCall, quietly } from "../runtime.mjs";
import { dbEvent, once, oneLine, serverPlace, sqlChange } from "./common.mjs";

const byHandler = new WeakMap();
let last;

function placeOf(options) {
  const host = [options?.host].flat()[0] ?? "localhost";
  return serverPlace("postgres", options?.path ? "localhost" : host, [options?.port].flat()[0] ?? 5432, options?.database);
}

function textOf(q) {
  if (typeof q.string === "string") return q.string;
  const s = q.strings ?? [];
  return q.tagged ? s.reduce((a, b, i) => `${a}$${i}${b}`) : String(s[0] ?? "");
}

function patchQuery(proto) {
  if (!once(proto) || typeof proto.handle !== "function") return;
  const orig = proto.handle;
  proto.handle = function handle() {
    if (this.executed) return orig.apply(this, arguments);
    let ret;
    const q = this;
    libCall(
      handle,
      () => dbEvent("postgres", byHandler.get(q.handler) ?? last ?? placeOf({}), textOf(q), q.tagged ? q.args : undefined),
      () => ((ret = orig.apply(q, arguments)), q),
      (event, r) => {
        const text = textOf(q);
        event.db.statement = text;
        event.name = oneLine(text).slice(0, 60);
        const change = sqlChange(text, q.parameters ?? q.args, r?.count, Array.isArray(r) ? r : undefined);
        if (change) event.change = change;
        else if (Array.isArray(r)) event.returned = `${r.length} row${r.length === 1 ? "" : "s"}`;
      },
      true,
    );
    return ret;
  };
}

function learn(sql) {
  if (typeof sql !== "function") return;
  const probe = sql`select 1`;
  const place = placeOf(sql.options);
  byHandler.set(probe.handler, place);
  last = place;
  patchQuery(Object.getPrototypeOf(probe));
}

/** The postgres() factory, wrapped so every sql instance it makes is known. Same function otherwise. */
export function wrapPostgres(orig) {
  if (typeof orig !== "function") return orig;
  const postgres = function postgres() {
    const sql = orig.apply(this, arguments);
    quietly(() => learn(sql));
    return sql;
  };
  return Object.assign(postgres, orig);
}
