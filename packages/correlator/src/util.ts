import type { DebugEvent, SourceLocation, TimelineNode } from "@shrike/schema";

const WORDS: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No content",
  301: "Moved", 302: "Redirect", 304: "Not modified",
  400: "Bad request", 401: "Not signed in", 403: "Not allowed", 404: "Not found",
  405: "Method not allowed", 409: "Conflict", 413: "Too large", 422: "Invalid data", 429: "Too many requests",
  500: "Server error", 502: "Bad gateway", 503: "Unavailable", 504: "Timed out",
};

export function statusWord(code: number): string {
  return WORDS[code] ?? (code >= 500 ? "Server error" : code >= 400 ? "Request refused" : code >= 300 ? "Redirect" : "OK");
}

export const withWord = (code: number): string => `${code} ${statusWord(code)}`;

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function loc(s: SourceLocation | undefined): string {
  if (!s || s.precision === "unavailable" || !s.file) return "";
  return `${s.precision === "approximate" ? "~" : ""}${s.file}:${s.line}`;
}

export const endOf = (e: DebugEvent): number => e.startMs + (e.durationMs ?? 0);

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function trunc(s: string, n = 160): string {
  const t = oneLine(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function walk(
  nodes: TimelineNode[],
  fn: (node: TimelineNode, parent: TimelineNode | undefined, depth: number) => void,
  parent?: TimelineNode,
  depth = 0,
): void {
  for (const n of nodes) {
    fn(n, parent, depth);
    walk(n.children, fn, n, depth + 1);
  }
}

export function allEvents(nodes: TimelineNode[]): DebugEvent[] {
  const out: DebugEvent[] = [];
  walk(nodes, (n) => out.push(n.event));
  return out;
}

export const reqName = (e: DebugEvent): string => (e.http ? `${e.http.method} ${e.http.url}` : e.name);

export const isFailure = (e: DebugEvent): boolean =>
  e.kind === "error" ||
  ((e.kind === "function" || e.kind === "db_query" || e.kind === "cache_op" || e.kind === "external_call") && e.status === "error");

// Places in prose: services by their short id ("auth"), outside hosts by their label ("Stripe").
export function serviceName(e: DebugEvent): string | undefined {
  if (e.place?.kind !== "service") return undefined;
  return e.place.id.startsWith("service:") ? e.place.id.slice(8) : e.place.name.toLowerCase();
}

export function outsideName(e: DebugEvent): string {
  const name = e.place?.name;
  if (name && /^[A-Z][A-Z0-9-]*$/.test(name)) return name[0] + name.slice(1).toLowerCase();
  if (name && !name.includes(":")) return name;
  if (e.place?.detail) return e.place.detail;
  try {
    return new URL(e.http?.url ?? "").host || e.name;
  } catch {
    return e.name;
  }
}

// The instrumented service an external_call reached, if its own request joined the trace.
export const calleeOf = (n: TimelineNode): DebugEvent | undefined =>
  n.children.find((c) => c.event.kind === "http_request" && c.event.origin === "server")?.event;

export const targetName = (n: TimelineNode): string => {
  const callee = calleeOf(n);
  return (callee && serviceName(callee)) ?? outsideName(n.event);
};

// "amount must be at least 50 cents" from {"error":{"message":…}}, {"error":"…"} or {"message":…}.
export function refusalMessage(e: DebugEvent): string {
  const body = e.http?.resBody;
  if (!body) return "";
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const err = j.error as Record<string, unknown> | string | undefined;
    const m = (typeof err === "object" && err ? err.message : err) ?? j.message ?? j.detail;
    if (typeof m === "string") return trunc(m, 120);
  } catch {}
  return trunc(body, 120);
}

export const callPath = (e: DebugEvent): string => {
  try {
    const u = new URL(e.http?.url ?? "");
    return `${e.http?.method ?? "GET"} ${u.pathname}`;
  } catch {
    return e.name;
  }
};

export const errMsg = (e: DebugEvent): string => e.error?.message ?? (e.kind === "error" ? e.name : "");

// Status of an http_request; a browser request without one inherits it from its server child.
export function httpStatus(n: TimelineNode): number | undefined {
  if (n.event.http?.status !== undefined) return n.event.http.status;
  for (const c of n.children) if (c.event.kind === "http_request" && c.event.http?.status !== undefined) return c.event.http.status;
  return undefined;
}

// http_requests not nested under another http_request (browser fetches, or server requests sent from outside); data: also the page's data calls (Supabase).
export function topRequests(nodes: TimelineNode[], data = false): TimelineNode[] {
  const out: TimelineNode[] = [];
  const visit = (ns: TimelineNode[]) => {
    for (const n of ns) {
      if (n.event.kind === "http_request" || (data && n.event.http)) out.push(n);
      else visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

// Deepest failure along the first failing chain, so a rethrown error points at where it started.
export function firstFailure(nodes: TimelineNode[]): TimelineNode | undefined {
  for (const n of nodes) {
    const deeper = firstFailure(n.children);
    if (deeper) return deeper;
    if (isFailure(n.event)) return n;
  }
  return undefined;
}

export function hasFailedFnWithMessage(nodes: TimelineNode[], msg: string): boolean {
  return nodes.some(
    (n) => (n.event.kind === "function" && n.event.status === "error" && errMsg(n.event) === msg) || hasFailedFnWithMessage(n.children, msg),
  );
}
