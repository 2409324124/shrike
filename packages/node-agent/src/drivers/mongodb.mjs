// mongodb driver 3.6+ (and mongoose on top of it) -> db_query. Every version's cmap Connection runs command
// monitoring when `monitorCommands` is on; this turns it on per connection (nothing reaches the app's client
// unless it asked for it) and turns the started/succeeded/failed events into one event per command.
import { changeOf, rowOut } from "../inspect.mjs";
import { hostKey } from "../place.mjs";
import { preview } from "../preview.mjs";
import { als, emit, errorInfo, newId, now, quietly } from "../runtime.mjs";
import { captureStack, userFrame } from "../stack.mjs";
import { once } from "./common.mjs";

const CRUD = new Set(["find", "insert", "update", "delete", "findandmodify", "aggregate", "count", "distinct"]);
const OPEN = new WeakMap(); // connection -> Map(requestId -> event)
const forced = new WeakSet();

const idOf = (v) => (v && typeof v === "object" && typeof v.toHexString === "function" ? v.toHexString() : v === undefined ? undefined : String(v));

function placeOf(conn, db, address) {
  const [host, port] = String(address ?? conn.address ?? "localhost:27017").split(/:(?=\d+$)/);
  const where = `${hostKey(host || "localhost", port ?? 27017)}/${db}`;
  return { kind: "data", id: `data:mongodb:${where}`, name: `MONGODB · ${db}`, detail: where };
}

// countDocuments() runs as aggregate [{ $match }, ..., { $group: { _id: 1, n: { $sum: 1 } } }].
const isCount = (name, cmd) => name === "aggregate" && Array.isArray(cmd.pipeline) && cmd.pipeline.at(-1)?.$group?._id === 1 && cmd.pipeline.at(-1)?.$group?.n?.$sum === 1;

// What a shell user would type: db.users.find({ email: "a@b" }), with values as a redacted params preview.
function describe(name, cmd) {
  const coll = String(cmd[Object.keys(cmd)[0]] ?? "");
  const args =
    name === "find" ? { filter: cmd.filter, sort: cmd.sort, limit: cmd.limit, skip: cmd.skip, projection: cmd.projection }
    : name === "insert" ? { documents: cmd.documents?.length }
    : name === "update" ? { updates: cmd.updates?.map((u) => ({ q: u.q, u: u.u })) }
    : name === "delete" ? { deletes: cmd.deletes?.map((d) => d.q) }
    : name === "findandmodify" ? { query: cmd.query, update: cmd.update, remove: cmd.remove }
    : name === "aggregate" ? { pipeline: cmd.pipeline }
    : { query: cmd.query, key: cmd.key };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  const verb = isCount(name, cmd) ? "countDocuments" : ({ insert: "insertMany", update: "update", delete: "deleteMany", findandmodify: "findOneAndUpdate", count: "countDocuments" }[name] ?? name);
  return { coll, statement: `db.${coll}.${verb}()`, params: preview(args) };
}

function started(conn, e) {
  const name = String(e.commandName ?? "").toLowerCase();
  const parent = als.getStore();
  if (!CRUD.has(name) || !parent || parent.lib) return;
  const cmd = e.command ?? {};
  const { coll, statement, params } = describe(name, cmd);
  const source = userFrame(captureStack(started).stack);
  const event = {
    id: newId(),
    traceId: parent.traceId,
    parentId: parent.eventId,
    startMs: now(),
    status: "ok",
    origin: "db",
    kind: "db_query",
    name: statement.slice(0, 60),
    db: { system: "mongodb", statement, params },
    place: placeOf(conn, e.databaseName ?? cmd.$db ?? "test", e.address ?? (typeof e.connectionId === "string" ? e.connectionId : undefined)),
  };
  if (source) event.source = source;
  let m = OPEN.get(conn);
  if (!m) OPEN.set(conn, (m = new Map()));
  m.set(e.requestId, { event, name, coll, cmd });
}

function change(name, coll, cmd, reply) {
  const n = Number(reply?.n ?? 0);
  const pk = ["_id"];
  if (name === "insert") return changeOf({ op: "insert", table: coll }, n, { after: (cmd.documents ?? []).map((d) => ({ ...d, _id: idOf(d._id) })), pk });
  if (name === "update") return changeOf({ op: "update", table: coll }, reply?.nModified ?? n, { after: (reply?.upserted ?? []).map((u) => ({ _id: idOf(u._id) })), pk });
  if (name === "delete") return changeOf({ op: "delete", table: coll }, n, {});
  if (name === "findandmodify" && reply?.value) {
    const v = { ...reply.value, _id: idOf(reply.value._id) };
    return changeOf({ op: cmd.remove ? "delete" : "update", table: coll }, 1, cmd.remove ? { before: [v], pk } : { after: [v], pk });
  }
  return undefined;
}

function finished(conn, e, failed) {
  const m = OPEN.get(conn);
  const rec = m?.get(e.requestId);
  if (!rec) return;
  m.delete(e.requestId);
  const { event, name, coll, cmd } = rec;
  event.durationMs = Math.round((now() - event.startMs) * 100) / 100;
  if (failed) {
    event.status = "error";
    event.error = errorInfo(e.failure);
  } else {
    const r = e.reply ?? {};
    if (r.writeErrors?.length) {
      event.status = "error";
      event.error = { message: String(r.writeErrors[0].errmsg ?? "write failed"), type: "MongoServerError" };
    }
    const c = change(name, coll, cmd, r);
    if (c) event.change = c;
    const batch = r.cursor?.firstBatch;
    if (Array.isArray(batch) && isCount(name, cmd)) event.returned = String(batch[0]?.n ?? 0);
    else if (Array.isArray(batch)) event.returned = `${batch.length} document${batch.length === 1 ? "" : "s"}${batch.length ? ` · ${preview(rowOut({ ...batch[0], _id: idOf(batch[0]._id) }))}` : ""}`;
    else if (name === "count") event.returned = String(r.n);
  }
  emit(event);
}

function patchEmit(proto, wanted) {
  const emitOrig = proto.emit;
  proto.emit = function emitPatched(type, e) {
    if (type === "commandStarted") quietly(() => started(this, e));
    else if (type === "commandSucceeded") quietly(() => finished(this, e, false));
    else if (type === "commandFailed") quietly(() => finished(this, e, true));
    // Only pass monitoring events on when the app itself turned monitoring on.
    if ((type === "commandStarted" || type === "commandSucceeded" || type === "commandFailed") && !wanted(this)) return false;
    return emitOrig.apply(this, arguments);
  };
}

/** The cmap Connection class (lib/cmap/connection.js), any driver version from 3.6 on. */
export function patchMongo(mod) {
  const Connection = mod?.Connection ?? mod?.default?.Connection;
  const proto = Connection?.prototype;
  if (typeof proto?.emit !== "function" || !once(proto)) return;
  Object.defineProperty(proto, "monitorCommands", {
    configurable: true,
    get() {
      return forced.has(this) || this.__shrikeMonitor === true;
    },
    set(v) {
      try {
        forced.add(this);
        Object.defineProperty(this, "__shrikeMonitor", { value: !!v, writable: true, configurable: true });
      } catch {}
    },
  });
  patchEmit(proto, (c) => c.__shrikeMonitor === true);
}

/** Driver 3.x's legacy topology (mongoose 5 without useUnifiedTopology): lib/core/connection/pool.js monitors in write(). */
export function patchMongoPool(mod) {
  const proto = (mod?.default ?? mod)?.prototype;
  if (typeof proto?.write !== "function" || typeof proto.emit !== "function" || !once(proto)) return;
  const appWants = new WeakMap();
  const write = proto.write;
  proto.write = function (command, options, cb) {
    const o = this.options;
    if (o && !appWants.has(this)) {
      appWants.set(this, !!o.monitorCommands);
      quietly(() => (o.monitorCommands = true));
    }
    return write.apply(this, arguments);
  };
  patchEmit(proto, (p) => appWants.get(p) !== false);
}
