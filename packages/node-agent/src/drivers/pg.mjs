// node-postgres (pg), pg-pool and @neondatabase/serverless's Client/Pool (a bundled copy of pg) -> db_query.
// Pool.query is recorded itself (its client.query then runs in lib context), so the event sits in the caller's trip
// even when the pool hands over a client freed by another request.
import { dbEvent, once, ownerOf, serverPlace, sqlChange, tracked, urlParts } from "./common.mjs";

const places = new WeakMap();

function placeOf(o) {
  let p = places.get(o);
  if (p) return p;
  const c = o.connectionParameters ?? o.options ?? {};
  const u = c.connectionString ? urlParts(c.connectionString) : {};
  const env = process.env;
  const host = c.host ?? u.host ?? env.PGHOST ?? "localhost";
  p = serverPlace("postgres", String(host).startsWith("/") ? "localhost" : host, c.port ?? u.port ?? env.PGPORT ?? 5432, c.database ?? u.database ?? env.PGDATABASE ?? c.user ?? env.PGUSER);
  places.set(o, p);
  return p;
}

function patchQuery(proto) {
  if (!once(proto)) return;
  const orig = proto.query;
  const patched = function query(config, values, callback) {
    // Submittables (pg-cursor, pg-query-stream) and config.callback keep their own lifecycle.
    if (config == null || typeof config.submit === "function" || typeof config.callback === "function") return orig.apply(this, arguments);
    const text = typeof config === "string" ? config : config.text;
    if (typeof text !== "string") return orig.apply(this, arguments);
    const params = Array.isArray(values) ? values : Array.isArray(config.values) ? config.values : undefined;
    const cb = typeof values === "function" ? values : typeof callback === "function" ? callback : undefined;
    return tracked(
      patched,
      () => dbEvent("postgres", placeOf(this), text, params),
      (event, r) => {
        const last = Array.isArray(r) ? r[r.length - 1] : r;
        if (!last) return;
        const names = last.fields?.map((f) => f.name);
        const rows = Array.isArray(last.rows) && Array.isArray(last.rows[0]) && names ? last.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))) : last.rows;
        const change = sqlChange(text, params, last.rowCount, rows);
        if (change) event.change = change;
        else if (Array.isArray(last.rows)) event.returned = `${last.rows.length} row${last.rows.length === 1 ? "" : "s"}`;
      },
      (wrapped) => (wrapped ? orig.call(this, config, typeof values === "function" ? wrapped : values, typeof values === "function" ? undefined : wrapped) : orig.apply(this, arguments)),
      cb,
    );
  };
  proto.query = patched;
}

/** pg's index (Client, Pool), pg-pool's Pool, or @neondatabase/serverless. */
export function patchPg(mod) {
  const m = mod?.default && typeof mod.default === "object" ? mod.default : mod;
  for (const cls of [m?.Client, m?.Pool, typeof m === "function" ? m : undefined]) {
    const proto = typeof cls === "function" ? ownerOf(cls, "query") : undefined;
    if (proto) patchQuery(proto);
  }
}
