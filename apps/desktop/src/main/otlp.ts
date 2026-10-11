// OTLP/HTTP traces in (POST /v1/traces): any OpenTelemetry backend (.NET, Python, Go, Java) shows real steps in its lane.
// ponytail: only the ExportTraceServiceRequest subset Shrike maps (no logs, metrics, links, gRPC). Upgrade path: @opentelemetry/otlp-transformer, or a gRPC listener on its own port.
import { basename } from "node:path";
import { z } from "zod";
import type { DebugEvent, IngestMessage, Place } from "@shrike/schema";

type Reader = { buf: Uint8Array; pos: number };
type Msg = Record<number, (bigint | Uint8Array)[]>;

function varint(r: Reader): bigint {
  let v = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const b = r.buf[r.pos++];
    if (b === undefined) throw new Error("truncated varint");
    v |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return v;
  }
  throw new Error("bad varint");
}

function take(r: Reader, n: number): Uint8Array {
  if (r.pos + n > r.buf.length) throw new Error("truncated field");
  return r.buf.subarray(r.pos, (r.pos += n));
}

const le = (b: Uint8Array) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);

/** One protobuf message: field number -> raw values (varints and fixed as bigint, length-delimited as bytes). */
function fields(buf: Uint8Array): Msg {
  const r: Reader = { buf, pos: 0 };
  const out: Msg = {};
  while (r.pos < buf.length) {
    const key = Number(varint(r));
    const wire = key & 7;
    const v = wire === 0 ? varint(r) : wire === 1 ? le(take(r, 8)) : wire === 2 ? take(r, Number(varint(r))) : wire === 5 ? le(take(r, 4)) : undefined;
    if (v === undefined) throw new Error(`unsupported wire type ${wire}`);
    (out[key >>> 3] ??= []).push(v);
  }
  return out;
}

const text = new TextDecoder();
const bytes = (m: Msg, f: number) => m[f]?.at(-1) as Uint8Array | undefined;
const str = (m: Msg, f: number) => {
  const b = bytes(m, f);
  return b ? text.decode(b) : undefined;
};
const num = (m: Msg, f: number) => m[f]?.at(-1) as bigint | undefined;
const subs = (m: Msg, f: number) => ((m[f] ?? []) as Uint8Array[]).map(fields);
const hex = (b: Uint8Array | undefined) => (b?.length ? Buffer.from(b).toString("hex") : undefined);

function anyValue(m: Msg): unknown {
  if (m[1]) return { stringValue: str(m, 1) };
  if (m[2]) return { boolValue: num(m, 2) !== 0n };
  if (m[3]) return { intValue: BigInt.asIntN(64, num(m, 3)!).toString() };
  if (m[4]) {
    const d = new DataView(new ArrayBuffer(8));
    d.setBigUint64(0, num(m, 4)!, true);
    return { doubleValue: d.getFloat64(0, true) };
  }
  if (m[5]) return { arrayValue: { values: subs(fields(bytes(m, 5)!), 1).map(anyValue) } };
  return {};
}
const status = (m: Msg) => ({ message: str(m, 2), code: Number(num(m, 3) ?? 0n) });
const keyValues = (m: Msg, f: number) => subs(m, f).map((kv) => ({ key: str(kv, 1) ?? "", value: kv[2] ? anyValue(fields(bytes(kv, 2)!)) : {} }));

/** ExportTraceServiceRequest (protobuf) in the OTLP/JSON shape, so both encodings share one schema and one mapping. */
export function decodeTraces(buf: Uint8Array): unknown {
  return {
    resourceSpans: subs(fields(buf), 1).map((rs) => ({
      resource: { attributes: rs[1] ? keyValues(fields(bytes(rs, 1)!), 1) : [] },
      scopeSpans: subs(rs, 2).map((ss) => ({
        spans: subs(ss, 2).map((s) => ({
          traceId: hex(bytes(s, 1)),
          spanId: hex(bytes(s, 2)),
          parentSpanId: hex(bytes(s, 4)),
          name: str(s, 5) ?? "",
          kind: Number(num(s, 6) ?? 0n),
          startTimeUnixNano: String(num(s, 7) ?? 0n),
          endTimeUnixNano: String(num(s, 8) ?? 0n),
          attributes: keyValues(s, 9),
          events: subs(s, 11).map((e) => ({ name: str(e, 2) ?? "", attributes: keyValues(e, 3) })),
          status: s[15] ? status(fields(bytes(s, 15)!)) : undefined,
        })),
      })),
    })),
  };
}

// No length caps on strings here (a long stack or statement mustn't drop the batch); the ingest schema checks the mapped events.
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const value: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      stringValue: z.string().optional(),
      boolValue: z.boolean().optional(),
      intValue: z.union([z.string(), z.number()]).optional(),
      doubleValue: z.number().optional(),
      arrayValue: z.object({ values: z.array(value).max(100).optional() }).optional(),
    })
    .passthrough(),
);
const attrs = z.array(z.object({ key: z.string(), value: value.optional() }).passthrough()).max(1000).optional();
const hexId = (n: number) => z.string().regex(new RegExp(`^[0-9a-fA-F]{${n}}$`));
const nanos = z.union([z.string().regex(/^\d{1,20}$/), z.number().nonnegative()]);
const requestSchema = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: z.object({ attributes: attrs }).passthrough().optional(),
        scopeSpans: z
          .array(
            z.object({
              spans: z
                .array(
                  z
                    .object({
                      traceId: hexId(32),
                      spanId: hexId(16),
                      parentSpanId: z.union([hexId(16), z.literal("")]).optional(),
                      name: z.string(),
                      kind: z.number().int().optional(),
                      startTimeUnixNano: nanos,
                      endTimeUnixNano: nanos,
                      attributes: attrs,
                      events: z.array(z.object({ name: z.string(), attributes: attrs }).passthrough()).max(1000).optional(),
                      status: z.object({ code: z.number().int().optional(), message: z.string().optional() }).passthrough().optional(),
                    })
                    .passthrough(),
                )
                .max(10_000)
                .optional(),
            })
            .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
    )
    .optional(),
});
type Request = z.infer<typeof requestSchema>;
type Attrs = Record<string, z.infer<typeof scalar>>;

function flat(list: z.infer<typeof attrs>): Attrs {
  const out: Attrs = {};
  const one = (v: any): z.infer<typeof scalar> | undefined =>
    v?.stringValue ?? v?.boolValue ?? (v?.intValue !== undefined ? Number(v.intValue) : undefined) ?? v?.doubleValue ?? (v?.arrayValue ? (v.arrayValue.values ?? []).map(one).join(",") : undefined);
  for (const kv of list ?? []) {
    const v = one(kv.value);
    if (v !== undefined) out[kv.key] = v;
  }
  return out;
}

const ms = (ns: string | number) => Number(BigInt(typeof ns === "number" ? Math.round(ns) : ns) / 1000n) / 1000;
const s = (v: unknown) => (v === undefined || v === "" ? undefined : String(v));
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0|localhost)$/i;
const hostKey = (host: string | undefined, port: unknown) => (host ? `${LOOPBACK.test(host) ? "localhost" : host.toLowerCase()}${port ? `:${port}` : ""}` : undefined);
const SYSTEM: Record<string, string> = { postgresql: "postgres" };
const oneLine = (x: string) => x.replace(/\s+/g, " ").trim();
// The deepest frame of a Python traceback that isn't a library, as the error's place in the code.
const PY_FRAME = /File "([^"]+)", line (\d+), in ([^\s]+)/g;
const LIB = /site-packages|dist-packages|[\\/]lib[\\/]python\d|<frozen/;

function url(a: Attrs): URL | undefined {
  try {
    const u = s(a["url.full"] ?? a["http.url"]);
    return u ? new URL(u) : undefined;
  } catch {
    return undefined;
  }
}

/** The address a server span was served on: "localhost:8000". Its Host header when the SDK recorded one. */
function servedOn(a: Attrs): string | undefined {
  const u = url(a);
  const hostPort = s(a["http.host"])?.match(/^(.*?)(?::(\d+))?$/);
  return (
    hostKey(s(a["server.address"]), a["server.port"]) ??
    hostKey(hostPort?.[1], hostPort?.[2] ?? a["net.host.port"]) ??
    hostKey(s(a["net.host.name"]), a["net.host.port"]) ??
    hostKey(u?.hostname, u?.port || undefined) ??
    (a["server.port"] ?? a["net.host.port"] ? `localhost:${a["server.port"] ?? a["net.host.port"]}` : undefined)
  );
}

function pathOf(a: Attrs): string | undefined {
  const p = s(a["url.path"]);
  if (p) return p + (a["url.query"] ? `?${a["url.query"]}` : "");
  const u = url(a);
  return u ? u.pathname + u.search : s(a["http.target"]);
}

function dataPlace(system: string, a: Attrs): Place {
  const label = system.toUpperCase();
  const name = s(a["db.namespace"] ?? a["db.name"]);
  if (system === "sqlite") return name ? { id: `data:sqlite:${basename(name)}`, kind: "data", name: `SQLITE · ${basename(name)}` } : { id: "data:sqlite", kind: "data", name: "SQLITE" }; // Python's sqlite3 instrumentation names no file
  const where = `${hostKey(s(a["server.address"] ?? a["net.peer.name"]) ?? "localhost", a["server.port"] ?? a["net.peer.port"])}${name ? `/${name}` : ""}`;
  return { id: `data:${system}:${where}`, kind: "data", name: name ? `${label} · ${name}` : label, detail: where };
}

function outsidePlace(a: Attrs): Place | undefined {
  const u = url(a);
  const host = hostKey(u?.hostname ?? s(a["server.address"] ?? a["net.peer.name"]), u?.port || a["server.port"] || a["net.peer.port"]);
  if (!host) return undefined;
  const bare = host.split(":")[0]!;
  const label = /^[\d.]+$/.test(bare) || !bare.includes(".") ? host.toUpperCase() : bare.split(".").at(-2)!.toUpperCase();
  return { id: `outside:${host}`, kind: "outside", name: label, detail: host };
}

type Span = NonNullable<NonNullable<NonNullable<Request["resourceSpans"]>[number]["scopeSpans"]>[number]["spans"]>[number];

function toEvent(span: Span, service: Place): DebugEvent | undefined {
  const a = flat(span.attributes);
  if (a["asgi.event.type"] !== undefined) return undefined; // ASGI's per-message "http send/receive" spans: noise, not steps
  const startMs = ms(span.startTimeUnixNano);
  const e: DebugEvent = {
    id: span.spanId.toLowerCase(),
    traceId: span.traceId.toLowerCase(),
    origin: "server",
    kind: "function",
    name: span.name.slice(0, 200),
    startMs,
    durationMs: Math.max(0, Math.round((ms(span.endTimeUnixNano) - startMs) * 100) / 100),
    status: "ok",
    place: service,
    otel: true,
  };
  if (span.parentSpanId && !/^0+$/.test(span.parentSpanId)) e.parentId = span.parentSpanId.toLowerCase();

  const method = s(a["http.request.method"] ?? a["http.method"]);
  const httpStatus = Number(a["http.response.status_code"] ?? a["http.status_code"]) || undefined;
  const system = s(a["db.system.name"] ?? a["db.system"]);
  if (system) {
    const sys = SYSTEM[system] ?? system;
    const statement = s(a["db.query.text"] ?? a["db.statement"]) ?? span.name;
    Object.assign(e, { kind: "db_query", origin: "db", name: oneLine(statement).slice(0, 60), db: { system: sys, statement }, place: dataPlace(sys, a) });
  } else if (span.kind === 2 && method) {
    const path = pathOf(a) ?? "/";
    const host = servedOn(a);
    const internal = Object.keys(a).some((k) => /^http\.request\.header\.x[-_]shrike[-_]internal$/.test(k));
    e.kind = "http_request";
    e.name = `${method} ${path.split("?")[0]}`;
    e.http = { method, url: path, status: httpStatus, reqHeaders: { ...(host ? { host } : {}), ...(internal ? { "x-shrike-internal": "1" } : {}) } };
    if (httpStatus && httpStatus >= 500) e.status = "error";
  } else if (span.kind === 3 || span.kind === 4) {
    e.kind = "external_call";
    const place = outsidePlace(a);
    if (place) e.place = place;
    const u = url(a);
    if (method) {
      e.http = { method, url: u?.href ?? `${place?.detail ?? ""}${pathOf(a) ?? ""}`, status: httpStatus };
      e.name = `${method} ${place?.detail ?? ""}${u?.pathname ?? ""}`;
    }
    if (httpStatus && httpStatus >= 400) e.status = "error";
  }

  const ex = span.events?.find((x) => x.name === "exception");
  const xa = flat(ex?.attributes);
  if (span.status?.code === 2 || ex) {
    e.status = "error";
    e.error = { message: s(xa["exception.message"]) ?? s(span.status?.message) ?? (httpStatus ? `HTTP ${httpStatus}` : "Error"), type: s(xa["exception.type"]), stack: s(xa["exception.stacktrace"]) };
  }

  const file = s(a["code.file.path"] ?? a["code.filepath"]);
  const line = Number(a["code.line.number"] ?? a["code.lineno"]);
  const fn = s(a["code.function.name"] ?? a["code.function"]);
  if (file) e.source = { file, line: line || 1, functionName: fn, precision: line ? "exact" : "approximate" };
  else if (e.error?.stack) {
    const frame = [...e.error.stack.matchAll(PY_FRAME)].findLast((m) => !LIB.test(m[1]!));
    if (frame) e.source = { file: frame[1]!, line: Number(frame[2]), functionName: frame[3], precision: "approximate" };
  }
  return e;
}

export function servicePlace(name: string): Place {
  return { id: `service:${name.toLowerCase()}`, kind: "service", name: name.toUpperCase() };
}

/**
 * OTLP traces (already decoded, or OTLP/JSON) -> a hello per service, so its lane counts as recorded, and its events.
 * Null when the payload isn't an ExportTraceServiceRequest. `skip`: services another recorder already covers.
 */
export function otlpMessages(body: unknown, skip: (placeId: string) => boolean = () => false): IngestMessage[] | null {
  const r = requestSchema.safeParse(body);
  if (!r.success) return null;
  const out: IngestMessage[] = [];
  for (const rs of r.data.resourceSpans ?? []) {
    const name = s(flat(rs.resource?.attributes)["service.name"]) ?? "app";
    const place = servicePlace(name);
    if (skip(place.id)) continue;
    const spans = (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []);
    const served = spans.find((x) => x.kind === 2);
    const detail = served && servedOn(flat(served.attributes));
    if (detail) place.detail = detail;
    out.push({ type: "hello", source: "server", place, ...(detail ? { url: `http://${detail}` } : {}), at: Date.now() });
    const events = spans.map((x) => toEvent(x, place)).filter((e) => e !== undefined);
    if (events.length) out.push({ type: "events", events });
  }
  return out;
}
