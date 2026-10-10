// Redis look-inside: its own short connection that can only send the read commands listed here.
import { createClient } from "redis";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { clamp, MAX_CELL, type Ctx } from "./index.ts";

export const READ = new Set(["SCAN", "TYPE", "TTL", "PTTL", "GET", "STRLEN", "HGETALL", "HLEN", "LRANGE", "LLEN", "SMEMBERS", "SCARD", "ZRANGE", "ZCARD", "XLEN", "XREVRANGE", "JSON.GET", "DBSIZE", "EXISTS"]);
type Send = (...args: (string | number)[]) => Promise<unknown>;

/** A connection whose only way out is `send`, which refuses anything not in READ. Exported for the read-only test. */
export async function readOnly<T>(s: Source, fn: (send: Send) => Promise<T>): Promise<T> {
  const client = createClient({ url: s.url, socket: { connectTimeout: 4000, reconnectStrategy: false }, disableOfflineQueue: true });
  client.on("error", () => {});
  await client.connect();
  const send: Send = (cmd, ...args) => (READ.has(String(cmd).toUpperCase()) ? client.sendCommand([String(cmd), ...args.map(String)]) : Promise.reject(new Error(`${cmd} is not a read command, so Shrike won't send it.`)));
  try {
    return await fn(send);
  } finally {
    await client.quit().catch(() => client.destroy());
  }
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const text = (v: unknown, max: number) => cut(typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString() : JSON.stringify(v) ?? "", max);
const pairs = (a: unknown) => (Array.isArray(a) ? Object.fromEntries(Array.from({ length: a.length / 2 }, (_, i) => [String(a[2 * i]), String(a[2 * i + 1])])) : a);

async function value(send: Send, key: string, type: string, max: number): Promise<{ value: string; bytes?: number }> {
  if (type === "string") {
    const n = Number(await send("STRLEN", key));
    return { bytes: n, value: n > 4096 ? `(${n} bytes)` : text(await send("GET", key), max) };
  }
  if (type === "hash") return { value: text(pairs(await send("HGETALL", key)), max) };
  if (type === "list") return { value: text(await send("LRANGE", key, 0, 19), max) };
  if (type === "set") return { value: text(((await send("SMEMBERS", key)) as unknown[]).slice(0, 20), max) };
  if (type === "zset") return { value: text(await send("ZRANGE", key, 0, 19), max) };
  if (type === "ReJSON-RL") return { value: text(await send("JSON.GET", key), max) };
  if (type === "stream") return { value: `${await send("XLEN", key)} entries, newest: ${text(await send("XREVRANGE", key, "+", "-", "COUNT", 1), max)}` };
  return { value: `(${type})` };
}

export function cacheKeys(s: Source, o: Extract<InspectRequest, { op: "cacheKeys" }>, ctx: Ctx): Promise<InspectResult> {
  void ctx;
  return readOnly(s, async (send) => {
    const limit = clamp(o.limit, 1, 500, 200);
    const pattern = o.match ? `*${o.match.replace(/[*?[\]\\]/g, "\\$&")}*` : "*";
    const keys: string[] = [];
    let cursor = /^\d{1,20}$/.test(o.cursor ?? "") ? o.cursor! : "0";
    for (let i = 0; i < 20 && keys.length < limit; i++) {
      const [next, batch] = (await send("SCAN", cursor, "MATCH", pattern, "COUNT", 100)) as [string, string[]];
      keys.push(...batch.map(String));
      cursor = String(next);
      if (cursor === "0") break;
    }
    const entries = await Promise.all(
      keys.slice(0, limit).map(async (k) => {
        const [type, ttl] = [String(await send("TYPE", k)), Number(await send("TTL", k))];
        const v = await value(send, k, type, MAX_CELL);
        return { key: k, type, preview: v.value, ttlMs: ttl >= 0 ? ttl * 1000 : null, ...(v.bytes !== undefined ? { bytes: v.bytes } : {}) };
      }),
    );
    return { op: "cacheKeys", system: "redis", size: Number(await send("DBSIZE")), entries, ...(cursor !== "0" ? { cursor } : {}) };
  });
}

export function cacheGet(s: Source, o: Extract<InspectRequest, { op: "cacheGet" }>): Promise<InspectResult> {
  if (o.key.includes("[redacted]")) return Promise.reject(new Error("This key is hidden because it looks like a secret."));
  return readOnly(s, async (send) => {
    const type = String(await send("TYPE", o.key));
    if (type === "none") throw new Error("That key isn't in the cache anymore.");
    return { op: "cacheGet", key: o.key, type, value: (await value(send, o.key, type, 8192)).value };
  });
}
