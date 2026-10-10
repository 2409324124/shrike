// Firestore look-inside through the local emulator's REST API (reads only: list collections, list documents).
// ponytail: the emulator only; a real project needs firebase-admin with a service account (upgrade path).
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

type Value = Record<string, unknown>;
export function plain(v: Value | undefined): unknown {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("referenceValue" in v) return String(v.referenceValue).split("/documents/")[1];
  if ("mapValue" in v) return Object.fromEntries(Object.entries((v.mapValue as { fields?: Record<string, Value> }).fields ?? {}).map(([k, x]) => [k, plain(x)]));
  if ("arrayValue" in v) return ((v.arrayValue as { values?: Value[] }).values ?? []).map(plain);
  if ("geoPointValue" in v) return v.geoPointValue;
  return "<bytes>";
}

/** Exported for the read-only test: only the two read endpoints can be reached. */
export async function read(s: Source, path: "listCollectionIds" | `documents/${string}`, body?: unknown): Promise<Record<string, unknown>> {
  if (path !== "listCollectionIds" && !path.startsWith("documents/")) throw new Error("Shrike only reads, so it won't send that.");
  const base = `http://${s.host}:${s.port}/v1/projects/${encodeURIComponent(s.project!)}/databases/(default)/documents`;
  const url = path === "listCollectionIds" ? `${base}:listCollectionIds` : `${base}/${path.slice("documents/".length)}`;
  const res = await fetch(url, { method: path === "listCollectionIds" ? "POST" : "GET", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: path === "listCollectionIds" ? JSON.stringify(body ?? { pageSize: 300 }) : undefined, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`The Firestore emulator answered ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}

async function docs(s: Source, coll: string, max: number) {
  const out: { id: string; fields: Record<string, unknown> }[] = [];
  let token = "";
  do {
    const r = await read(s, `documents/${encodeURIComponent(coll)}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    for (const d of (r.documents as { name: string; fields?: Record<string, Value> }[]) ?? []) out.push({ id: d.name.split("/").pop()!, fields: Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, plain(v)])) });
    token = String(r.nextPageToken ?? "");
  } while (token && out.length < max);
  return out;
}

// The lane names the project the page used (data:firestore:host/<project>); it beats the settings' guess.
const forLane = (s: Source, ctx?: Ctx): Source => (ctx?.database ? { ...s, project: ctx.database } : s);

export async function tables(src: Source, ctx: Ctx): Promise<InspectResult> {
  const s = forLane(src, ctx);
  const ids = ((await read(s, "listCollectionIds")).collectionIds as string[]) ?? [];
  const list = await Promise.all(ids.sort().map(async (name) => {
    const d = await docs(s, name, 1000);
    return { name, rows: d.length, columns: [{ name: "id", pk: true }, ...[...new Set(d.slice(0, 20).flatMap((x) => Object.keys(x.fields)))].map((n) => ({ name: n, pk: false }))] };
  }));
  return { op: "tables", system: "firestore", how: `the Firestore emulator's read API on ${ctx.how} (project ${s.project})`, tables: list };
}

export async function rows(src: Source, o: Extract<InspectRequest, { op: "rows" }>, ctx?: Ctx): Promise<InspectResult> {
  const s = forLane(src, ctx);
  let all = (await docs(s, o.table, 2000)).map((d) => ({ id: d.id, ...d.fields }));
  if (o.search) all = all.filter((r) => JSON.stringify(r).toLowerCase().includes(o.search!.toLowerCase()));
  const cols = ["id", ...new Set(all.flatMap((r) => Object.keys(r)).filter((k) => k !== "id"))];
  if (o.orderBy && cols.includes(o.orderBy)) all.sort((a, b) => (String((a as Record<string, unknown>)[o.orderBy!]) < String((b as Record<string, unknown>)[o.orderBy!]) ? -1 : 1) * (o.desc ? -1 : 1));
  const page = all.slice(clamp(o.offset, 0, 10_000_000, 0), clamp(o.offset, 0, 10_000_000, 0) + clamp(o.limit, 1, 200, 100));
  return { op: "rows", table: o.table, columns: cols, pk: ["id"], rows: page.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c]))), total: all.length };
}
