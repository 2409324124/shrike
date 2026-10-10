// Cache clients (D5): ioredis and lru-cache -> cache_op events.
import { readFileSync } from "node:fs";
import path from "node:path";
import { preview } from "./preview.mjs";
import { remember } from "./inspect.mjs";
import { hostKey } from "./place.mjs";
import { libCall } from "./runtime.mjs";
import { projectRoot } from "./stack.mjs";

// A key segment that looks like a token (long, letters and digits) is hidden: "session:[redacted]".
// ponytail: a UUID stays visible ("todos:<uuid>" is a record id, as in @shrike/redact); a UUID session id slips through.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function safeKey(key) {
  const s = typeof key === "string" || typeof key === "number" ? String(key) : preview(key);
  return s
    .split(/([:/])/)
    .map((seg) => (seg.length >= 16 && /\d/.test(seg) && /[a-z]/i.test(seg) && !UUID.test(seg) ? "[redacted]" : seg))
    .join("")
    .slice(0, 200);
}

const opEvent = (op, key, place) => {
  const k = key === undefined ? undefined : safeKey(key);
  return { origin: "db", kind: "cache_op", name: k === undefined ? op.toUpperCase() : `${op.toUpperCase()} ${k}`, cache: { op, key: k }, place };
};

// ---- ioredis

const READS = new Set(["get", "mget", "hget", "hmget", "hgetall", "exists", "getdel", "getex", "smembers", "lrange", "zrange", "ttl"]);
const WRITES = new Set(["set", "setex", "psetex", "setnx", "mset", "del", "unlink", "incr", "incrby", "decr", "decrby", "expire", "pexpire", "hset", "hdel", "hincrby", "sadd", "srem", "lpush", "rpush", "zadd"]);
const sent = new WeakSet();

const str = (v) => (Buffer.isBuffer(v) ? v.toString() : String(v));

function redisHit(op, v) {
  if (v == null) return false;
  if (op === "exists") return Number(v) > 0;
  if (op === "hgetall") return typeof v === "object" && Object.keys(v).length > 0;
  if (op === "mget" || op === "hmget") return Array.isArray(v) && v.some((x) => x != null);
  if (op === "smembers" || op === "lrange" || op === "zrange") return Array.isArray(v) && v.length > 0;
  if (op === "ttl") return Number(v) >= 0;
  return true;
}

function redisPlace(redis) {
  const o = redis.options ?? {};
  const where = o.path ?? hostKey(String(o.host ?? "localhost"), o.port ?? 6379);
  return { kind: "cache", id: `cache:redis:${where}/${o.db ?? 0}`, name: "REDIS", detail: `${where}/${o.db ?? 0}` };
}

// Redis.prototype.sendCommand sees every command; the offline queue re-sends the same Command object.
export function patchIoredis(mod) {
  const Redis = mod?.default ?? mod?.Redis ?? mod;
  const proto = Redis?.prototype;
  const orig = proto?.sendCommand;
  if (typeof orig !== "function" || proto.__shrike) return;
  Object.defineProperty(proto, "__shrike", { value: true });
  const patched = function sendCommand(command, ...rest) {
    const op = String(command?.name ?? "").toLowerCase();
    if (!op || sent.has(command) || (!READS.has(op) && !WRITES.has(op))) return orig.call(this, command, ...rest);
    try {
      sent.add(command);
    } catch {}
    const args = Array.isArray(command.args) ? command.args : [];
    return libCall(
      patched,
      () => {
        const place = redisPlace(this);
        remember(place, "redis", this);
        return opEvent(op, args.length ? (op === "mget" ? args.map(str).join(" ") : str(args[0])) : undefined, place);
      },
      () => orig.call(this, command, ...rest),
      (event, v) => {
        if (!READS.has(op)) return;
        event.cache.hit = redisHit(op, v);
        event.returned = preview(Buffer.isBuffer(v) ? v.toString() : v);
      },
      true,
    );
  };
  proto.sendCommand = patched;
}

// ---- lru-cache

const labels = new WeakMap();
let lruCount = 0;
const lines = new Map();

// The variable the cache lives in, read from the calling line ("sessions.get(id)" -> "sessions").
function varName(source) {
  try {
    const root = projectRoot();
    if (!source || !root) return undefined;
    let text = lines.get(source.file);
    if (text === undefined) {
      text = readFileSync(path.join(root, source.file), "utf8").split("\n");
      lines.set(source.file, text);
    }
    const line = text[source.line - 1] ?? "";
    return /([A-Za-z_$][\w$]*)\s*\??\.\s*(?:get|set|has|delete)\s*\(/.exec(line.slice(Math.max(0, (source.column ?? 1) - 60)))?.[1];
  } catch {
    return undefined;
  }
}

function lruPlace(cache, source) {
  let label = labels.get(cache);
  if (!label) {
    const name = varName(source);
    label = name && !/^(this|cache|lru)$/i.test(name) ? name : `cache ${++lruCount}`;
    labels.set(cache, label);
  }
  return { kind: "cache", id: `cache:lru:${label}`, name: `LRU · ${label}` };
}

export function patchLru(mod) {
  const proto = mod?.LRUCache?.prototype;
  if (!proto || proto.__shrike) return;
  Object.defineProperty(proto, "__shrike", { value: true });
  for (const op of ["get", "set", "has", "delete"]) {
    const orig = proto[op];
    if (typeof orig !== "function") continue;
    const patched = {
      [op](key, ...rest) {
        const cache = this;
        return libCall(
          patched,
          (source) => {
            const place = lruPlace(cache, source);
            remember(place, "lru", cache);
            return opEvent(op, key, place);
          },
          () => orig.call(this, key, ...rest),
          (event, v) => {
            if (op === "get") {
              event.cache.hit = v !== undefined;
              if (v !== undefined) event.returned = preview(v);
            } else if (op === "has") event.cache.hit = v === true;
          },
        );
      },
    }[op];
    proto[op] = patched;
  }
}
