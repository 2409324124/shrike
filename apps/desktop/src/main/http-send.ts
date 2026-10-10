import type { DebugEvent, HttpRequestSpec, HttpResponseSpec } from "@shrike/schema";
import { randomHex, type Store } from "./store.ts";

const MAX_EVENT_BODY = 64 * 1024;
const MAX_RETURN_BODY = 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);

export function resolveTarget(raw: string, baseUrl: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    throw new Error(baseUrl ? `That isn't a valid URL: ${raw}` : "Run your app first so relative URLs have somewhere to go.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be sent: ${raw}`);
  // ponytail: loopback only, so agents can't reach other origins. Upgrade: allowlist in .shrike/config.json.
  if (!LOOPBACK.has(url.hostname)) throw new Error(`Shrike only sends requests to your local app (localhost), not ${url.host}.`);
  return url;
}

export async function sendRequest(
  store: Store,
  spec: HttpRequestSpec,
  baseUrl: string | undefined,
  trigger: "explorer" | "agent",
): Promise<{ response: HttpResponseSpec; actionId: string }> {
  const url = resolveTarget(spec.url, baseUrl);
  const hidden = [spec.url, spec.body ?? "", ...Object.values(spec.headers ?? {})].join("\n").match(/\[redacted:[\w.-]*\]/)?.[0];
  if (hidden) throw new Error(`Type the real value for ${hidden} first. Shrike hid it in the recording.`);
  const method = spec.method.toUpperCase();
  const path = url.pathname + url.search;
  const traceId = randomHex(16);
  const reqId = randomHex(8);
  const start = Date.now();
  const root: DebugEvent = {
    id: randomHex(8),
    traceId,
    origin: trigger,
    kind: "user_action",
    name: `Sent ${method} ${path}`,
    startMs: start,
    status: "ok",
    trigger,
    ...(spec.name ? { caller: { kind: trigger, label: spec.name.slice(0, 120) } } : {}), // AP: the request's name on the caller card
    ...(spec.resendOf ? { resendOf: spec.resendOf } : {}),
  };
  store.handle({ type: "events", events: [root] });

  const reqHeaders: Record<string, string> = { ...spec.headers, traceparent: `00-${traceId}-${reqId}-01` };
  const hasBody = spec.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-type")) reqHeaders["content-type"] = "application/json";
  const event: DebugEvent = {
    id: reqId,
    traceId,
    parentId: root.id,
    origin: trigger,
    kind: "http_request",
    name: `${method} ${path}`,
    startMs: start,
    status: "ok",
    http: { method, url: path, reqHeaders, reqBody: hasBody ? cut(spec.body!, MAX_EVENT_BODY) : undefined },
  };

  try {
    const res = await fetch(url, { method, headers: reqHeaders, body: hasBody ? spec.body : undefined, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const durationMs = Date.now() - start;
    const headers = Object.fromEntries(res.headers.entries());
    const status = res.status >= 500 ? "error" : "ok";
    event.durationMs = durationMs;
    event.status = status;
    event.http = { ...event.http!, status: res.status, resHeaders: headers, resBody: cut(body, MAX_EVENT_BODY) };
    store.handle({ type: "events", events: [event, { ...root, durationMs, status }] });
    return { response: { status: res.status, statusText: res.statusText, headers, body: cut(body, MAX_RETURN_BODY), durationMs }, actionId: root.id };
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    const message = timedOut ? "The request took longer than 30 seconds." : `Couldn't reach ${url.origin}. Is your app running?`;
    event.durationMs = Date.now() - start;
    event.status = "error";
    event.error = { message, type: (err as Error).name };
    store.handle({ type: "events", events: [event, { ...root, durationMs: event.durationMs, status: "error" }] });
    throw new Error(message);
  } finally {
    store.handle({ type: "action_end", actionId: root.id, at: Date.now() });
  }
}
