// DynamoDB look-inside: ListTables, DescribeTable and Scan with a limit, nothing else can be sent.
import { DescribeTableCommand, DynamoDBClient, ListTablesCommand, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import type { Source } from "./discover.ts";
import { cell, clamp, type Ctx } from "./index.ts";

const READS = [ListTablesCommand, DescribeTableCommand, ScanCommand];
type ReadCommand = ListTablesCommand | DescribeTableCommand | ScanCommand;

/** A client that refuses every command but the three reads. Exported for the read-only test. */
export async function readOnly<T>(s: Source, fn: (send: (c: ReadCommand) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const local = !!s.url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(s.url).hostname);
  const client = new DynamoDBClient({ region: s.region ?? "us-east-1", endpoint: s.url, maxAttempts: 1, requestHandler: { requestTimeout: 6000, connectionTimeout: 4000 }, ...(local ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}) });
  const send = (c: ReadCommand) => (READS.some((R) => c instanceof R) ? (client.send(c as ScanCommand) as unknown as Promise<Record<string, unknown>>) : Promise.reject(new Error("Shrike only reads, so it won't send that.")));
  try {
    return await fn(send);
  } finally {
    client.destroy();
  }
}

export function plain(v: AttributeValue | undefined): unknown {
  if (!v) return null;
  if ("S" in v) return v.S;
  if ("N" in v) return Number(v.N);
  if ("BOOL" in v) return v.BOOL;
  if ("NULL" in v) return null;
  if ("M" in v) return Object.fromEntries(Object.entries(v.M ?? {}).map(([k, x]) => [k, plain(x)]));
  if ("L" in v) return (v.L ?? []).map(plain);
  if ("SS" in v) return v.SS;
  if ("NS" in v) return v.NS?.map(Number);
  return "<bytes>";
}

async function describe(send: (c: ReadCommand) => Promise<Record<string, unknown>>, name: string) {
  const t = (await send(new DescribeTableCommand({ TableName: name }))).Table as { ItemCount?: number; KeySchema?: { AttributeName?: string }[]; AttributeDefinitions?: { AttributeName?: string }[] };
  const pk = (t.KeySchema ?? []).map((k) => k.AttributeName!).filter(Boolean);
  return { name, rows: Number(t.ItemCount ?? 0), pk, attrs: (t.AttributeDefinitions ?? []).map((a) => a.AttributeName!).filter(Boolean) };
}

export function tables(s: Source, ctx: Ctx): Promise<InspectResult> {
  return readOnly(s, async (send) => {
    const names = ((await send(new ListTablesCommand({ Limit: 100 }))).TableNames as string[]) ?? [];
    const list = await Promise.all(names.map((n) => describe(send, n)));
    return { op: "tables", system: "dynamodb", how: `ListTables, DescribeTable and Scan on ${ctx.how} (item counts are DynamoDB's estimate)`, tables: list.map((t) => ({ name: t.name, rows: t.rows, columns: [...new Set([...t.pk, ...t.attrs])].map((n) => ({ name: n, pk: t.pk.includes(n) })) })) };
  });
}

export function rows(s: Source, o: Extract<InspectRequest, { op: "rows" }>): Promise<InspectResult> {
  return readOnly(s, async (send) => {
    const t = await describe(send, o.table);
    const limit = clamp(o.limit, 1, 200, 100);
    const offset = clamp(o.offset, 0, 2000, 0);
    const items: Record<string, AttributeValue>[] = [];
    let start: Record<string, AttributeValue> | undefined;
    // ponytail: offset paging scans from the start (max 2,000 items); a cursor is the upgrade path.
    do {
      const r = await send(new ScanCommand({ TableName: o.table, Limit: Math.min(1000, offset + limit - items.length), ExclusiveStartKey: start }));
      items.push(...((r.Items as Record<string, AttributeValue>[]) ?? []));
      start = r.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
    } while (start && items.length < offset + limit);
    let page = items.slice(offset, offset + limit).map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, plain(v)])));
    if (o.search) page = page.filter((r) => JSON.stringify(r).toLowerCase().includes(o.search!.toLowerCase()));
    const cols = [...new Set([...t.pk, ...page.flatMap((r) => Object.keys(r))])];
    if (o.orderBy && cols.includes(o.orderBy)) page.sort((a, b) => (String(a[o.orderBy!]) < String(b[o.orderBy!]) ? -1 : 1) * (o.desc ? -1 : 1));
    return { op: "rows", table: o.table, columns: cols, pk: t.pk, rows: page.map((r) => cols.map((c) => cell(r[c]))), total: Math.max(t.rows, items.length) };
  });
}
