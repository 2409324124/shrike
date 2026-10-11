import type { ActionView, DebugEvent, SourceLocation, TimelineNode } from "@shrike/schema";

export function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const STATUS_WORDS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No content",
  301: "Moved",
  302: "Redirected",
  304: "Not modified",
  400: "Bad request",
  401: "The server said no",
  403: "Not allowed",
  404: "Not found",
  405: "Method not allowed",
  409: "Conflict",
  413: "Too large",
  422: "Invalid data",
  429: "Too many requests",
  500: "Server error",
  501: "Not implemented",
  502: "Bad gateway",
  503: "Unavailable",
  504: "Timed out",
};

export function statusWord(code: number): string {
  return STATUS_WORDS[code] ?? (code >= 500 ? "Server error" : code >= 400 ? "Request problem" : code >= 300 ? "Redirected" : "OK");
}

/** "Server error (500)" */
export function statusWords(code: number | undefined): string {
  if (code == null) return "No response";
  if (code === 0) return "Failed to connect";
  return `${statusWord(code)} (${code})`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const byteLength = (s: string | undefined): number => (s ? new TextEncoder().encode(s).length : 0);

export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export const isUserLoc = (loc: SourceLocation | undefined): loc is SourceLocation =>
  !!loc && loc.precision !== "unavailable" && !!loc.file && !loc.file.includes("node_modules");

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return clockTime(ms);
}

export function prettyBody(body: string | undefined): string {
  if (!body) return "";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

export const ZERO_TRACE = "0".repeat(32);
export const isBackgroundAction = (a: ActionView): boolean => a.traceId === ZERO_TRACE;

export function walk(nodes: TimelineNode[], fn: (n: TimelineNode, depth: number, parent?: TimelineNode) => void, depth = 0, parent?: TimelineNode): void {
  for (const n of nodes) {
    fn(n, depth, parent);
    walk(n.children ?? [], fn, depth + 1, n);
  }
}

export function allEvents(a: ActionView): DebugEvent[] {
  const out: DebugEvent[] = [a.root];
  walk(a.tree ?? [], (n) => out.push(n.event));
  return out;
}

export function findNode(nodes: TimelineNode[], id: string): TimelineNode | undefined {
  for (const n of nodes) {
    if (n.event.id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}

export function errorText(e: DebugEvent): string | undefined {
  return e.error?.message ?? (e.kind === "error" ? e.log?.message ?? e.name : undefined);
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function httpPath(url: string): string {
  try {
    const u = new URL(url, "http://x");
    return url.startsWith("http") ? `${u.host}${u.pathname}${u.search}` : `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
