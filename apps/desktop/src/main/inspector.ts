// Place inspector (docs/13 I): routes the renderer's look-inside requests to the node-agent that holds the place.
// Each node-agent long-polls POST /inspect/poll on the ingest (127.0.0.1, same token) and answers on POST /inspect/reply.
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import { redactCell, redactText } from "@shrike/redact";

const placeId = z.string().min(1).max(300).regex(/^(data|cache):/, "only database and cache lanes can be read");
const limit = z.number().int().min(1).max(200).optional();
export const inspectRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tables"), placeId }).strict(),
  z.object({ op: z.literal("rows"), placeId, table: z.string().min(1).max(300), limit, offset: z.number().int().min(0).max(10_000_000).optional(), orderBy: z.string().max(300).optional(), desc: z.boolean().optional(), search: z.string().max(200).optional() }).strict(),
  z.object({ op: z.literal("cacheKeys"), placeId, limit, cursor: z.string().max(40).optional(), match: z.string().max(200).optional() }).strict(),
  z.object({ op: z.literal("cacheGet"), placeId, key: z.string().min(1).max(2000) }).strict(),
]);

const text = z.string().max(20_000);
const cell = z.union([text, z.number(), z.boolean(), z.null()]);
const resultSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tables"), system: z.enum(["sqlite", "postgres", "mysql", "mongodb", "supabase", "dynamodb", "firestore"]), how: text, tables: z.array(z.object({ name: text, rows: z.number(), columns: z.array(z.object({ name: text, pk: z.boolean() })).max(1000) })).max(1000) }),
  z.object({ op: z.literal("rows"), table: text, columns: z.array(text).max(1000), pk: z.array(text).max(100), rows: z.array(z.array(cell).max(1000)).max(200), total: z.number() }),
  z.object({
    op: z.literal("cacheKeys"),
    system: z.enum(["lru", "redis"]),
    size: z.number(),
    max: z.number().optional(),
    entries: z.array(z.object({ key: text, preview: text, type: z.string().max(40).optional(), ttlMs: z.number().nullable(), bytes: z.number().optional() })).max(500),
    cursor: z.string().max(40).optional(),
  }),
  z.object({ op: z.literal("cacheGet"), key: text, type: z.string().max(40).optional(), value: text }),
]);
const pollSchema = z.object({ pid: z.number().int().positive(), service: z.string().max(200), places: z.array(z.string().max(300)).max(500) });
const replySchema = z.object({ id: z.string().max(40), ok: z.boolean(), missing: z.boolean().optional(), error: z.string().max(2000).optional(), result: z.unknown().optional() });

interface Agent {
  pid: number;
  service: string;
  places: Set<string>;
  queue: (InspectRequest & { id: string })[];
  waiter?: ServerResponse;
  hold?: ReturnType<typeof setTimeout>;
  seenAt: number;
}

interface Pending {
  targets: number;
  misses: number;
  placeId: string;
  resolve(r: InspectResult): void;
  reject(e: Error): void;
}

/** Main runs @shrike/redact on every reply too: secret-named columns and keys masked, values scanned. */
export function redactResult(r: InspectResult): InspectResult {
  if (r.op === "rows") return { ...r, rows: r.rows.map((row) => row.map((v, i) => redactCell(r.columns[i] ?? "", v))) };
  if (r.op === "cacheKeys") return { ...r, entries: r.entries.map((e) => ({ ...e, key: redactText(e.key), preview: String(redactCell(e.key, e.preview)) })) };
  if (r.op === "cacheGet") return { ...r, key: redactText(r.key), value: String(redactCell(r.key, r.value)) };
  return r;
}

const noun = (id: string) => (id.startsWith("cache:") ? "cache" : "database");
const svcName = (s: string | undefined) => s?.replace(/^service:/, "");

export class InspectHub {
  private agents = new Map<number, Agent>();
  private owners = new Map<string, string>(); // place id -> service id that last held it
  private pending = new Map<string, Pending>();
  private n = 0;
  private holdMs: number;
  private timeoutMs: number;
  private aliveMs: number;
  /** DB: a direct read-only connection from the project's settings (datasources/), or undefined when there is none. */
  direct?: (req: InspectRequest) => Promise<InspectResult> | undefined;

  constructor(o: { holdMs?: number; timeoutMs?: number; aliveMs?: number; direct?: InspectHub["direct"] } = {}) {
    this.holdMs = o.holdMs ?? 15_000;
    this.timeoutMs = o.timeoutMs ?? 6_000;
    this.aliveMs = o.aliveMs ?? 3_000;
    this.direct = o.direct;
  }

  /** POST /inspect/poll and /inspect/reply, after the ingest checked the token. */
  handle(path: string, body: unknown, res: ServerResponse): void {
    if (path === "/inspect/poll") return this.poll(body, res);
    if (path !== "/inspect/reply") return void res.writeHead(404).end();
    res.writeHead(204).end();
    const r = replySchema.safeParse(body);
    const p = r.success ? this.pending.get(r.data.id) : undefined;
    if (!r.success || !p) return;
    if (r.data.missing) {
      if (++p.misses >= p.targets) this.settle(r.data.id, new Error(this.why(this.owners.get(p.placeId), true, p.placeId)));
      return;
    }
    if (!r.data.ok) return this.settle(r.data.id, new Error(r.data.error || "Shrike couldn't read it."));
    const v = resultSchema.safeParse(r.data.result);
    this.settle(r.data.id, v.success ? redactResult(v.data as InspectResult) : new Error("Shrike got an answer it couldn't read."));
  }

  private poll(body: unknown, res: ServerResponse): void {
    const p = pollSchema.safeParse(body);
    if (!p.success) return void res.writeHead(400).end();
    const { pid, service, places } = p.data;
    let a = this.agents.get(pid);
    if (!a) this.agents.set(pid, (a = { pid, service, places: new Set(), queue: [], seenAt: Date.now() }));
    a.service = service;
    a.places = new Set(places);
    for (const id of places) this.owners.set(id, service);
    this.release(a); // a newer poll replaces an older one
    const agent = a;
    a.waiter = res;
    res.on("close", () => {
      if (agent.waiter !== res) return;
      agent.waiter = undefined;
      agent.seenAt = Date.now();
      clearTimeout(agent.hold);
    });
    a.hold = setTimeout(() => this.release(agent), this.holdMs);
    if (a.queue.length) this.release(a);
  }

  private release(a: Agent): void {
    const res = a.waiter;
    clearTimeout(a.hold);
    if (!res) return;
    a.waiter = undefined;
    a.seenAt = Date.now();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ requests: a.queue.splice(0) }));
  }

  private alive(a: Agent): boolean {
    return !!a.waiter || Date.now() - a.seenAt < this.aliveMs;
  }

  // A declared place ("events.db" in .shrike/config.json) has its own id; the agent knows the place it found.
  private resolve(id: string): string {
    if (this.owners.has(id)) return id;
    const tail = id.slice(id.indexOf(":") + 1);
    return [...this.owners.keys()].find((k) => k.endsWith(`:${tail}`) && k.startsWith(id.slice(0, id.indexOf(":") + 1))) ?? id;
  }

  private why(owner: string | undefined, running: boolean, id: string): string {
    const thing = noun(id);
    if (owner && !running) return `This ${thing} lives in the ${svcName(owner)} process, which isn't running. Press Run to start it.`;
    return `Shrike hasn't seen your app use this ${thing} yet. Click something in your app that uses it, then look again.`;
  }

  // A process holding the place answers first; else, or when it can't, Shrike's own read-only connection does.
  request(req: InspectRequest): Promise<InspectResult> {
    const placeId = this.resolve(req.placeId);
    const holder = [...this.agents.values()].find((a) => this.alive(a) && a.places.has(placeId));
    const direct = () => this.direct?.({ ...req, placeId })?.then(redactResult);
    if (!holder) {
      const d = direct();
      if (d) return d;
    }
    const viaAgents = this.viaAgents(req);
    return this.direct ? viaAgents.catch((e: Error) => direct() ?? Promise.reject(e)) : viaAgents;
  }

  private viaAgents(req: InspectRequest): Promise<InspectResult> {
    for (const [pid, a] of this.agents) if (!this.alive(a) && Date.now() - a.seenAt > 60_000) this.agents.delete(pid);
    const placeId = this.resolve(req.placeId);
    const owner = this.owners.get(placeId);
    const live = [...this.agents.values()].filter((a) => this.alive(a));
    const holder = live.find((a) => a.places.has(placeId));
    const targets = holder ? [holder] : live;
    if (!targets.length) {
      const msg = owner ? this.why(owner, false, placeId) : `Shrike hasn't seen your app use this ${noun(placeId)} yet and found no settings for it in the project. Run your app and click something that uses it, then look again.`;
      return Promise.reject(new Error(msg));
    }
    const id = `i${++this.n}`;
    return new Promise<InspectResult>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(id, new Error(`The ${svcName(holder?.service ?? owner) ?? "app"} process didn't answer within ${Math.max(1, Math.round(this.timeoutMs / 1000))} seconds. It may be busy; try again in a moment.`)),
        this.timeoutMs,
      );
      this.pending.set(id, {
        targets: targets.length,
        misses: 0,
        placeId,
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      for (const a of targets) {
        a.queue.push({ ...req, placeId, id });
        if (a.waiter) this.release(a);
      }
    });
  }

  private settle(id: string, r: InspectResult | Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (r instanceof Error) p.reject(r);
    else p.resolve(r);
  }
}

export const inspector = new InspectHub();
