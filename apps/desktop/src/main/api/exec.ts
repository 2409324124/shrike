// Sends one ApiRequest: vars, auth, body, cookies, redirects, timings. Every send is recorded as a trip, like http-send.ts.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { ApiAuth, ApiKv, ApiRequest, ApiResponse, ApiSendResult, DebugEvent } from "@shrike/schema";
import { randomHex, type Store } from "../store.ts";
import { runAssertions } from "./assert.ts";
import { runScript, type ScriptReq } from "./script.ts";
import { asText, evalPath, interpolate, scopeOf, type ResLike, type Scope } from "./vars.ts";

export const MAX_BODY = 10 * 1024 * 1024;
const MAX_EVENT_BODY = 64 * 1024;
const LOOPBACK = /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;
export const isLoopback = (u: URL) => LOOPBACK.test(u.hostname);

export interface Layer {
  headers: ApiKv[];
  auth: ApiAuth;
  vars: ApiKv[];
}
export interface SendContext {
  collection?: Layer;
  folders?: Layer[]; // outer to inner
  env?: Scope;
  runtime?: Scope; // vars set by earlier sends, highest precedence
  baseUrl?: string; // the running app, for relative URLs
  root?: string; // collection folder: Bruno stores @file() paths relative to it
  jar?: CookieJar;
  signal?: AbortSignal;
  runScripts?: boolean;
  store?: Store;
  trigger?: "explorer" | "agent";
  resendOf?: string; // AP16: the trip this edits, so the new one sits under it
  verifyTls?: boolean;
  timeoutMs?: number;
  live?: string[]; // #53: the live project's origins; an agent can't change data there
}

export const LIVE_WRITE = "This is your live site. Shrike won't change live data. Try it on your local app.";

// ponytail: name=value per host, no path/expiry/domain matching. Upgrade: tough-cookie if a login flow needs it.
export class CookieJar {
  private hosts = new Map<string, Map<string, string>>();
  header(u: URL) {
    const c = this.hosts.get(u.hostname);
    return c && c.size ? [...c].map(([k, v]) => `${k}=${v}`).join("; ") : undefined;
  }
  take(u: URL, setCookie: string[] | undefined) {
    for (const line of setCookie ?? []) {
      const [pair] = line.split(";");
      const k = pair!.indexOf("=");
      if (k <= 0) continue;
      const c = this.hosts.get(u.hostname) ?? new Map<string, string>();
      const name = pair!.slice(0, k).trim();
      const value = pair!.slice(k + 1).trim();
      if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(line)) c.delete(name);
      else c.set(name, value);
      this.hosts.set(u.hostname, c);
    }
  }
  clear() {
    this.hosts.clear();
  }
}

const setHeader = (h: Record<string, string>, name: string, value: string) => {
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) delete h[k];
  h[name] = value;
};
const hasHeader = (h: Record<string, string>, name: string) => Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());

export function effectiveAuth(req: ApiRequest, ctx: SendContext): ApiAuth {
  for (const a of [req.auth, ...[...(ctx.folders ?? [])].reverse().map((f) => f.auth), ctx.collection?.auth]) if (a && a.type !== "inherit") return a;
  return { type: "none" };
}

export interface Prepared {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer | undefined;
  scope: Scope;
}

/** Everything except the network: the request exactly as it will go out. Also used by code generation. */
export async function prepare(req: ApiRequest, ctx: SendContext, extraVars: Scope = {}): Promise<Prepared> {
  const scope = scopeOf(ctx.collection?.vars, ctx.env, ...(ctx.folders ?? []).map((f) => f.vars), req.vars.pre, ctx.runtime, extraVars);
  const i = (s: string) => interpolate(s, scope);
  let raw = i(req.url.trim());
  for (const p of req.pathParams) if (p.enabled) raw = raw.replace(new RegExp(`:${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/?#])`), encodeURIComponent(i(p.value)));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.startsWith("/") && /^[\w.-]+(:\d+)?(\/|$)/.test(raw)) raw = `http://${raw}`;
  let url: URL;
  try {
    url = new URL(raw, ctx.baseUrl);
  } catch {
    throw new Error(raw.startsWith("/") && !ctx.baseUrl ? "Run your app first so relative URLs have somewhere to go." : `That isn't a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be sent: ${raw}`);
  if (req.params.length) {
    url.search = "";
    for (const p of req.params) if (p.enabled && p.name) url.searchParams.append(i(p.name), i(p.value));
  }
  const headers: Record<string, string> = {};
  for (const layer of [ctx.collection?.headers, ...(ctx.folders ?? []).map((f) => f.headers), req.headers]) for (const h of layer ?? []) if (h.enabled && h.name) setHeader(headers, i(h.name), i(h.value));
  const auth = effectiveAuth(req, ctx);
  if (auth.type === "bearer" && !hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${i(auth.token)}`;
  if (auth.type === "basic" && !hasHeader(headers, "authorization")) headers.Authorization = `Basic ${Buffer.from(`${i(auth.username)}:${i(auth.password)}`).toString("base64")}`;
  if (auth.type === "apikey" && auth.key) {
    if (auth.placement === "query") url.searchParams.set(i(auth.key), i(auth.value));
    else setHeader(headers, i(auth.key), i(auth.value));
  }
  const method = req.method.toUpperCase();
  let body: Buffer | undefined;
  const b = req.body;
  const type = (t: string) => !hasHeader(headers, "content-type") && (headers["content-type"] = t);
  if (b.type === "json" || b.type === "text" || b.type === "xml") {
    if (b.data !== "") {
      body = Buffer.from(i(b.data));
      type(b.type === "json" ? "application/json" : b.type === "xml" ? "application/xml" : "text/plain");
    }
  } else if (b.type === "form-urlencoded") {
    body = Buffer.from(new URLSearchParams(b.fields.filter((f) => f.enabled).map((f) => [i(f.name), i(f.value)])).toString());
    type("application/x-www-form-urlencoded");
  } else if (b.type === "multipart") {
    const form = new FormData();
    for (const f of b.fields) {
      if (!f.enabled) continue;
      if (!f.file) form.append(i(f.name), i(f.value));
      else for (const path of f.value.split("|").filter(Boolean)) form.append(i(f.name), new Blob([await readFile(isAbsolute(path) || !ctx.root ? path : resolve(ctx.root, path))]), basename(path));
    }
    const encoded = new Response(form);
    body = Buffer.from(await encoded.arrayBuffer());
    setHeader(headers, "content-type", encoded.headers.get("content-type")!);
  } else if (b.type === "graphql") {
    let variables: unknown;
    try {
      variables = b.variables.trim() ? JSON.parse(i(b.variables)) : undefined;
    } catch {
      throw new Error("The GraphQL variables aren't valid JSON.");
    }
    body = Buffer.from(JSON.stringify({ query: i(b.query), ...(variables === undefined ? {} : { variables }) }));
    type("application/json");
  }
  return { method, url, headers, body, scope };
}

const TEXTY = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|problem\+json|ld\+json|x-ndjson))|\+json|\+xml/i;
export function isBinary(contentType: string | undefined, bytes: Buffer): boolean {
  if (contentType && TEXTY.test(contentType)) return false;
  if (contentType && /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|wasm|protobuf)/i.test(contentType)) return true;
  return bytes.subarray(0, 1024).includes(0);
}

interface Raw {
  res: IncomingMessage;
  bytes: Buffer;
  size: number;
  truncated: boolean;
  timings: ApiResponse["timings"];
}

function once(p: Prepared, verifyTls: boolean, timeoutMs: number, signal: AbortSignal | undefined): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const at: Record<string, number> = {};
    const mark = (k: string) => (at[k] ??= performance.now() - t0);
    const send = p.url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = { ...p.headers, ...(p.body ? { "content-length": String(p.body.length) } : {}) };
    const req = send(p.url, { method: p.method, headers, agent: false, rejectUnauthorized: verifyTls, signal, timeout: timeoutMs }, (res) => {
      mark("ttfb");
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (truncated) return;
        if (size > MAX_BODY) {
          truncated = true;
          chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
          res.destroy();
          finish();
        } else chunks.push(c);
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const total = performance.now() - t0;
        resolve({
          res,
          bytes: Buffer.concat(chunks),
          size,
          truncated,
          timings: {
            ...(at.lookup !== undefined ? { dnsMs: at.lookup } : {}),
            ...(at.connect !== undefined ? { connectMs: at.connect - (at.lookup ?? 0) } : {}),
            ...(at.tls !== undefined ? { tlsMs: at.tls - (at.connect ?? 0) } : {}),
            ttfbMs: at.ttfb! - (at.tls ?? at.connect ?? 0),
            downloadMs: total - at.ttfb!,
            totalMs: total,
          },
        });
      };
      res.on("end", finish);
      res.on("error", (e) => (truncated ? finish() : reject(e)));
    });
    req.on("socket", (s) => {
      s.once("lookup", () => mark("lookup"));
      s.once("connect", () => mark("connect"));
      s.once("secureConnect", () => mark("tls"));
    });
    const timeUp = () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError", started: at.ttfb !== undefined }));
    req.on("timeout", timeUp);
    const deadline = setTimeout(timeUp, timeoutMs); // the socket timeout is idle time: a body that trickles forever never trips it
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(p.body);
  });
}

function decode(raw: Raw): Buffer {
  const enc = String(raw.res.headers["content-encoding"] ?? "").toLowerCase();
  try {
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(raw.bytes);
    if (enc === "br") return brotliDecompressSync(raw.bytes);
    if (enc === "deflate") return inflateSync(raw.bytes);
  } catch {
    // truncated or mislabelled: show the bytes as they came
  }
  return raw.bytes;
}

const headerRecord = (res: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
};

export function friendlyError(err: unknown, url: URL, timeoutMs: number, curlHint = true): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.name === "AbortError") return "Cancelled.";
  const secs = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)} seconds`;
  if (e?.name === "TimeoutError") return (e as { started?: boolean }).started ? `${url.host} was still sending after ${secs}, so Shrike stopped waiting.` : `No answer from ${url.host} after ${secs}.`;
  if (e?.code === "ECONNREFUSED") return isLoopback(url) ? `Nothing is listening on ${url.host}. Is your app running?` : `${url.host} refused the connection.`;
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return `Couldn't find ${url.hostname}. Check the address or your connection.`;
  if (e?.code && /WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG/i.test(e.code)) return `${url.host} didn't answer over https. Try http:// instead.`;
  if (e?.code && /CERT|SSL|TLS|SELF_SIGNED/i.test(e.code)) return `${url.host} has a certificate Shrike doesn't trust (${e.code}).${curlHint ? " If it's your own dev certificate, import the request as cURL with -k to skip the check." : ""}`;
  if (e?.code === "ECONNRESET") return `${url.host} closed the connection.`;
  return `Couldn't reach ${url.host}: ${e?.message ?? String(err)}`;
}

/** The whole send: pre vars and script, request, redirects, post vars and script, assertions, and the trip. */
export async function execute(req: ApiRequest, ctx: SendContext = {}): Promise<ApiSendResult> {
  const result: ApiSendResult = { sent: { method: req.method.toUpperCase(), url: req.url, headers: {} }, assertions: [], setVars: {}, logs: [] };
  const timeoutMs = req.settings.timeoutMs || ctx.timeoutMs || 30_000;
  const verifyTls = req.settings.verifyTls ?? ctx.verifyTls ?? true;
  let p = await prepare(req, ctx);
  const env = { ...(ctx.env ?? {}) };
  if (ctx.runScripts && req.scripts.pre?.trim()) {
    const out = await runScript({ code: req.scripts.pre, req: { method: p.method, url: p.url.href, headers: p.headers, body: p.body?.toString() }, vars: p.scope, env });
    result.logs.push(...out.logs);
    Object.assign(result.setVars, out.setVars);
    if (out.error) result.scriptError = `Before the request: ${out.error}`;
    p = await applyScriptReq(p, out.req, out.setVars, req, ctx);
  }

  const hidden = [p.url.href, p.body && !isBinary(p.headers["content-type"], p.body) ? p.body.toString() : "", ...Object.values(p.headers)].join("\n").match(/\[redacted(?::|%3A)[\w.-]*\]|%5Bredacted(?::|%3A)[\w.-]*%5D/i)?.[0];
  if (hidden) throw new Error(`Type the real value for ${decodeURIComponent(hidden)} first. Shrike hid it in the recording.`);
  const traceId = randomHex(16);
  const start = Date.now();
  const trigger = ctx.trigger ?? "explorer";
  const onLive = !!ctx.live?.includes(p.url.origin);
  if (onLive && trigger === "agent" && p.method !== "GET" && p.method !== "HEAD") throw new Error(LIVE_WRITE);
  const local = !!ctx.baseUrl && new URL(ctx.baseUrl).origin === p.url.origin ? true : isLoopback(p.url);
  if (local && !onLive) setHeader(p.headers, "traceparent", `00-${traceId}-${randomHex(8)}-01`);
  if (!hasHeader(p.headers, "user-agent")) p.headers["user-agent"] = "Shrike";
  if (!hasHeader(p.headers, "accept-encoding")) p.headers["accept-encoding"] = "gzip, deflate, br";
  const cookie = ctx.jar?.header(p.url);
  if (cookie && !hasHeader(p.headers, "cookie")) p.headers.cookie = cookie;
  result.sent = { method: p.method, url: p.url.href, headers: { ...p.headers } };

  const where = local ? p.url.pathname + p.url.search : p.url.href;
  const root: DebugEvent = { id: randomHex(8), traceId, origin: trigger, kind: "user_action", name: `Sent ${p.method} ${where}`, startMs: start, status: "ok", trigger, ...(req.name ? { caller: { kind: trigger, label: req.name.slice(0, 120) } } : {}), ...(ctx.resendOf ? { resendOf: ctx.resendOf } : {}) }; // AP15: the request's name on the caller card
  ctx.store?.handle({ type: "events", events: [root] });
  const reqId = p.headers.traceparent?.split("-")[2] ?? randomHex(8);
  const event: DebugEvent = {
    id: reqId,
    traceId,
    parentId: root.id,
    origin: trigger,
    kind: "http_request",
    name: `${p.method} ${where}`,
    startMs: start,
    status: "ok",
    http: { method: p.method, url: where, reqHeaders: { ...p.headers }, reqBody: p.body && !isBinary(p.headers["content-type"], p.body) ? cut(p.body.toString()) : undefined },
  };
  if (!local) event.place = { id: `outside:${p.url.host}`, kind: "outside", name: p.url.hostname.split(".").slice(-2, -1)[0]?.toUpperCase() || p.url.host, detail: p.url.host };

  let raw: Raw;
  let redirects = 0;
  try {
    let cur = p;
    for (;;) {
      raw = await once(cur, verifyTls, timeoutMs, ctx.signal);
      ctx.jar?.take(cur.url, raw.res.headers["set-cookie"]);
      const loc = raw.res.headers.location;
      const code = raw.res.statusCode ?? 0;
      if (!loc || code < 300 || code > 399 || req.settings.followRedirects === false || redirects >= (req.settings.maxRedirects ?? 5)) break;
      redirects++;
      const next = new URL(loc, cur.url);
      if (next.protocol !== "http:" && next.protocol !== "https:") break;
      if (trigger === "agent" && next.origin !== cur.url.origin) break; // agent scope: never follow out of the approved origin
      const headers = { ...cur.headers };
      if (next.origin !== cur.url.origin) for (const k of Object.keys(headers)) if (/^(authorization|cookie|traceparent)$/i.test(k)) delete headers[k];
      const c = ctx.jar?.header(next);
      if (c) headers.cookie = c;
      const keep = code === 307 || code === 308;
      if (!keep) for (const k of Object.keys(headers)) if (/^content-(type|length)$/i.test(k)) delete headers[k];
      cur = { ...cur, url: next, headers, method: keep || cur.method === "HEAD" ? cur.method : "GET", body: keep ? cur.body : undefined };
    }
    raw = raw!;
    p = cur;
  } catch (err) {
    result.error = friendlyError(err, p.url, timeoutMs);
    event.durationMs = Date.now() - start;
    event.status = "error";
    event.error = { message: result.error, type: (err as Error).name };
    ctx.store?.handle({ type: "events", events: [event, { ...root, durationMs: event.durationMs, status: "error" }] });
    ctx.store?.handle({ type: "action_end", actionId: root.id, at: Date.now() });
    result.actionId = ctx.store ? root.id : undefined;
    return result;
  }

  const bytes = decode(raw);
  const headers = headerRecord(raw.res);
  const contentType = headers["content-type"];
  const binary = isBinary(contentType, bytes);
  const text = binary ? "" : bytes.toString("utf8");
  const status = raw.res.statusCode ?? 0;
  const response: ApiResponse = {
    status,
    statusText: raw.res.statusMessage ?? "",
    headers,
    body: binary ? bytes.toString("base64") : text,
    bodyEncoding: binary ? "base64" : "text",
    ...(contentType ? { contentType } : {}),
    size: raw.size,
    truncated: raw.truncated,
    url: p.url.href,
    redirects,
    timings: raw.timings,
  };
  result.response = response;

  const durationMs = Date.now() - start;
  event.durationMs = durationMs;
  event.status = status >= 500 ? "error" : "ok";
  event.http = { ...event.http!, status, resHeaders: headers, resBody: binary ? `[${contentType ?? "binary"}, ${raw.size} bytes]` : cut(text) };
  ctx.store?.handle({ type: "events", events: [event, { ...root, durationMs, status: event.status }] });
  ctx.store?.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  if (ctx.store) result.actionId = root.id;

  let parsed: unknown = text;
  if (!binary) {
    try {
      parsed = JSON.parse(text);
    } catch {}
  }
  const resLike: ResLike = { status, headers, body: parsed, responseTime: Math.round(raw.timings.totalMs) };
  for (const v of req.vars.post) {
    if (!v.enabled || !v.name) continue;
    try {
      const got = evalPath(interpolate(v.value, p.scope), resLike);
      result.setVars[v.name] = got === undefined && !/^res\b/.test(v.value.trim()) ? interpolate(v.value, p.scope) : asText(got);
    } catch {
      result.setVars[v.name] = "";
    }
  }
  const after = { ...p.scope, ...result.setVars };
  for (const [code, label] of [
    [req.scripts.post, "After the response"],
    [req.scripts.tests, "Tests"],
  ] as const) {
    if (!ctx.runScripts || !code?.trim()) continue;
    const out = await runScript({ code, req: { method: p.method, url: p.url.href, headers: p.headers, body: p.body?.toString() }, res: { status, statusText: response.statusText, headers, body: parsed, responseTime: resLike.responseTime }, vars: after, env });
    result.logs.push(...out.logs);
    Object.assign(result.setVars, out.setVars);
    Object.assign(after, out.setVars);
    for (const t of out.tests) result.assertions.push({ expr: t.name, op: "test", value: "", enabled: true, ok: t.ok, ...(t.error ? { error: t.error } : {}) });
    if (out.error) result.scriptError = `${label}: ${out.error}`;
  }
  result.assertions.unshift(...runAssertions(req.assertions, resLike, after));
  return result;
}

async function applyScriptReq(p: Prepared, s: ScriptReq, setVars: Scope, req: ApiRequest, ctx: SendContext): Promise<Prepared> {
  // A script that set vars may change what {{vars}} resolve to; re-prepare, then lay the script's own edits on top.
  const base = Object.keys(setVars).length ? await prepare(req, ctx, setVars) : p;
  let url = base.url;
  if (s.url !== p.url.href) {
    try {
      const u = new URL(s.url, ctx.baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") url = u;
    } catch {}
  }
  const headers = JSON.stringify(s.headers) !== JSON.stringify(p.headers) ? { ...s.headers } : base.headers;
  const body = s.body !== p.body?.toString() ? (s.body === undefined ? undefined : Buffer.from(s.body)) : base.body;
  return { ...base, method: s.method.toUpperCase(), url, headers, body };
}

const cut = (s: string) => (s.length > MAX_EVENT_BODY ? `${s.slice(0, MAX_EVENT_BODY)}…[truncated]` : s);
