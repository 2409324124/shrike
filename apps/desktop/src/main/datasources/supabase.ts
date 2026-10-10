// Supabase look-inside when no database URL is known: PostgREST reads (GET only) with the project's API key,
// so it shows what that key may see (row level security applies). With the database itself known, postgres.ts reads it.
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

/** The only way out: GET requests with a timeout. Exported for the read-only test. */
export async function get(s: Source, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") throw new Error("Shrike only reads, so it won't send that.");
  if (!s.key) throw new Error(`${s.from} has a Supabase URL but no API key, so Shrike can't read it.`);
  const res = await fetch(`${s.url}${path}`, { method, headers: { apikey: s.key, authorization: `Bearer ${s.key}`, ...headers }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Supabase answered ${res.status} for ${path.split("?")[0]}.`);
  return res;
}

interface Spec {
  definitions?: Record<string, { properties?: Record<string, { description?: string; type?: string; format?: string }> }>;
  paths?: Record<string, { get?: unknown }>;
}

async function schema(s: Source) {
  const spec = (await (await get(s, "/rest/v1/", { accept: "application/openapi+json" })).json()) as Spec;
  return Object.entries(spec.definitions ?? {})
    .filter(([name]) => spec.paths?.[`/${name}`]?.get)
    .map(([name, d]) => ({ name, columns: Object.entries(d.properties ?? {}).map(([c, p]) => ({ name: c, pk: /<pk\/>/.test(p.description ?? ""), text: p.type === "string" && !p.format?.includes("uuid") && !p.format?.includes("time") })) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const total = (r: Response) => Number(/\/(\d+)$/.exec(r.headers.get("content-range") ?? "")?.[1] ?? 0);

export async function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  const list = await schema(s);
  const counts = await Promise.all(list.map((t) => get(s, `/rest/v1/${encodeURIComponent(t.name)}?select=*&limit=1`, { prefer: "count=exact", range: "0-0" }).then(total, () => 0)));
  return {
    op: "tables",
    system: "supabase",
    how: `Supabase's API with the key in ${s.from}, so only what that key may see (row level security applies) · ${ctx.how}`,
    tables: list.map((t, i) => ({ name: t.name, rows: counts[i]!, columns: t.columns.map(({ name, pk }) => ({ name, pk })) })),
  };
}

export async function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>): Promise<InspectResult> {
  const t = (await schema(s)).find((x) => x.name === o.table);
  if (!t) throw new Error(`There's no table called ${o.table} that this key can see.`);
  const cols = t.columns.map((c) => c.name);
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
  const q = new URLSearchParams({ select: "*", limit: String(clamp(o.limit, 1, 200, 100)), offset: String(clamp(o.offset, 0, 10_000_000, 0)) });
  const by = o.orderBy && cols.includes(o.orderBy) ? o.orderBy : pk[0];
  if (by) q.set("order", `${by}.${o.desc ? "desc" : "asc"}`);
  const text = t.columns.filter((c) => c.text).map((c) => c.name);
  if (o.search && text.length) q.set("or", `(${text.map((c) => `${c}.ilike.*${o.search!.slice(0, 200).replace(/[,()*]/g, " ")}*`).join(",")})`);
  const res = await get(s, `/rest/v1/${encodeURIComponent(t.name)}?${q}`, { prefer: "count=exact" });
  const data = (await res.json()) as Record<string, unknown>[];
  return { op: "rows", table: t.name, columns: cols, pk, rows: data.map((r) => cols.map((c) => cell(r[c]))), total: total(res) || data.length };
}
