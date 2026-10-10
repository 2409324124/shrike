// MongoDB look-inside. Mongo has no read-only session, so reads go through a facade that only has
// listCollections, estimatedDocumentCount, countDocuments, find and aggregate (refusing $out and $merge).
import { MongoClient, type Document } from "mongodb";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

const MAX_MS = 4000;

export interface ReadOnlyDb {
  collections(): Promise<string[]>;
  estimate(coll: string): Promise<number>;
  count(coll: string, filter: Document): Promise<number>;
  find(coll: string, filter: Document, o: { sort?: Document; skip?: number; limit: number }): Promise<Document[]>;
  aggregate(coll: string, pipeline: Document[]): Promise<Document[]>;
}

/** Opens the database behind a facade that can only read. Exported for the read-only test. */
export async function readOnly<T>(s: Source, database: string | undefined, fn: (db: ReadOnlyDb) => Promise<T>): Promise<T> {
  const client = new MongoClient(s.url!, { serverSelectionTimeoutMS: MAX_MS, connectTimeoutMS: MAX_MS, socketTimeoutMS: 8000, maxPoolSize: 1, appName: "shrike inspector (read only)" });
  try {
    await client.connect();
    const db = client.db(s.database ?? database ?? undefined);
    const facade: ReadOnlyDb = {
      collections: async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort(),
      estimate: (c) => db.collection(c).estimatedDocumentCount({ maxTimeMS: MAX_MS }),
      count: (c, filter) => db.collection(c).countDocuments(filter, { maxTimeMS: MAX_MS }),
      find: (c, filter, o) => db.collection(c).find(filter, { sort: o.sort, skip: o.skip, limit: o.limit, maxTimeMS: MAX_MS }).toArray(),
      aggregate: (c, pipeline) => {
        if (pipeline.some((st) => "$out" in st || "$merge" in st)) return Promise.reject(new Error("Shrike only reads: $out and $merge are refused."));
        return db.collection(c).aggregate(pipeline, { maxTimeMS: MAX_MS }).toArray();
      },
    };
    return await fn(Object.freeze(facade));
  } finally {
    await client.close().catch(() => {});
  }
}

const keysOf = (docs: Document[]) => {
  const keys = new Set<string>(["_id"]);
  for (const d of docs) for (const k of Object.keys(d)) keys.add(k);
  return [...keys];
};

export function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, ctx.database, async (db) => {
    const names = await db.collections();
    const list = await Promise.all(
      names.slice(0, 200).map(async (name) => ({ name, rows: await db.estimate(name), columns: keysOf(await db.find(name, {}, { limit: 20 })).map((n) => ({ name: n, pk: n === "_id" })) })),
    );
    return { op: "tables", system: "mongodb", how: `read-only queries (find and count) on ${ctx.how}`, tables: list };
  });
}

export function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, ctx.database, async (db) => {
    if (!(await db.collections()).includes(o.table)) throw new Error(`There's no collection called ${o.table} here.`);
    const cols = keysOf(await db.find(o.table, {}, { limit: 20 }));
    const term = o.search?.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fields = cols.filter((c) => c !== "_id");
    const filter: Document = term && fields.length ? { $or: fields.map((c) => ({ [c]: { $regex: term, $options: "i" } })) } : {};
    const sort: Document | undefined = o.orderBy && cols.includes(o.orderBy) ? { [o.orderBy]: o.desc ? -1 : 1 } : { _id: 1 };
    const docs = await db.find(o.table, filter, { sort, skip: clamp(o.offset, 0, 10_000_000, 0), limit: clamp(o.limit, 1, 200, 100) });
    const all = [...new Set([...cols, ...keysOf(docs)])];
    return { op: "rows", table: o.table, columns: all, pk: ["_id"], rows: docs.map((d) => all.map((c) => cell(d[c]))), total: await db.count(o.table, filter) };
  });
}
