import { stripAnsi } from "./ansi.ts";
import type { ActionView, DebugEvent, Place, SourceLocation, Status, TimelineNode } from "@shrike/schema";

// One stop of the "flight" through the code. Shared contract between the 3D space and the HUD.
export interface PlayStep {
  id: string; // event id
  index: number;
  event: DebugEvent;
  depth: number;
  realm: "browser" | "server";
  at?: SourceLocation; // where the camera goes; undefined = a gate between realms (e.g. server receiving a request)
  caption: string; // one plain-English sentence for the HUD
  tag?: string; // short value shown next to the line: args, returned value, or error
  status: Status;
  startMs: number;
  durationMs: number;
}

const STATUS_WORDS: Record<number, string> = {
  200: "OK", 201: "Created", 204: "No content", 400: "Bad request", 401: "Not signed in", 402: "Payment refused",
  403: "Not allowed", 404: "Not found", 409: "Conflict", 422: "Invalid data", 500: "Server error",
  502: "Bad gateway", 503: "Unavailable",
};

export function statusWords(code: number): string {
  const w = STATUS_WORDS[code] ?? (code >= 500 ? "Server error" : code >= 400 ? "Request refused" : "OK");
  return `${w} (${code})`;
}

const clip = (raw: string, n: number) => {
  const s = raw.replace(/\s+/g, " ").trim(); // one line: captions and value tags never wrap
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const singular = (w: string) => w.replace(/ies$/, "y").replace(/s$/, "");

/** A database error in plain words: "NOT NULL constraint failed: todos.user_id" -> "NOT NULL constraint failed. The todo had no user." */
export function dbRefusal(message: string): string {
  const m = /^(NOT NULL|UNIQUE|FOREIGN KEY|CHECK) constraint failed(?::\s*(\w+)\.(\w+))?/i.exec(message.trim());
  if (!m) return clip(message, 90);
  const [, kind, table = "", col = ""] = m;
  const thing = singular(table) || "row";
  const field = col.replace(/_id$/, "").replace(/_/g, " ");
  const why = {
    "NOT NULL": `The ${thing} had no ${field || "value"}.`,
    UNIQUE: `A ${thing} with that ${field || "value"} already exists.`,
    "FOREIGN KEY": `The ${thing} points at something that doesn't exist.`,
    CHECK: `The ${thing} broke one of the table's rules.`,
  }[kind!.toUpperCase() as "NOT NULL"];
  return `${kind!.toUpperCase()} constraint failed. ${why}`;
}

/** A place in prose: "STRIPE · api.stripe.com" -> "Stripe"; declared names ("Stripe (test double)") stay as written. */
export function placeWords(p: Place): string {
  const n = p.name.split(" · ")[0]!.trim();
  return n === n.toUpperCase() ? n.charAt(0) + n.slice(1).toLowerCase() : n;
}

/** "the auth service" for a service place. */
export const serviceWords = (p: Place): string => `the ${placeWords(p).toLowerCase()} service`;

/** What an outside service said when it refused: the error, else a message in its JSON body. */
export function refusal(e: DebugEvent): string | undefined {
  if (e.error?.message) return clip(e.error.message, 90);
  if (!e.http?.status || e.http.status < 400 || !e.http.resBody) return undefined;
  try {
    const b = JSON.parse(e.http.resBody) as { error?: string | { message?: string }; message?: string };
    const m = typeof b.error === "string" ? b.error : (b.error?.message ?? b.message);
    return typeof m === "string" ? clip(m, 90) : undefined;
  } catch {
    return undefined;
  }
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

function caption(e: DebugEvent): string {
  const failed = e.status === "error";
  switch (e.kind) {
    case "user_action":
      return e.trigger === "navigation" ? `You ${e.name.replace(/^Opened/, "opened")}` : `You ${e.name.replace(/^Clicked/, "clicked").replace(/^Sent/, "sent")}`;
    case "http_request": {
      const req = `${e.http?.method ?? ""} ${e.http?.url ?? e.name}`.trim();
      const res = e.http?.status ? `: ${statusWords(e.http.status)}` : "";
      return e.origin === "server" ? `The server got ${req}${res}` : `Your page called the server, ${req}${res}`;
    }
    case "function":
      return failed ? `${e.name} failed: ${clip(e.error?.message ?? "error", 90)}` : `${e.name} ran`;
    case "db_query":
      return failed ? `The database refused: ${dbRefusal(e.error?.message ?? "error")}` : `Asked the database: ${clip(e.db?.statement ?? e.name, 60)}`;
    case "log":
      return `It logged "${clip(e.log?.message ?? e.name, 80)}"`;
    case "error":
      return `Error: ${clip(e.error?.message ?? e.name, 100)}`;
    case "cache_op": {
      const key = e.cache?.key ?? "a key";
      if (failed) return `The cache failed: ${clip(e.error?.message ?? "error", 90)}`;
      if (e.cache?.hit === true) return `Asked the cache for ${key}. It had it.`;
      if (e.cache?.hit === false) return `The cache didn't have ${key}.`;
      if (/^(set|hset|setex|mset|put)$/i.test(e.cache?.op ?? "")) return `Saved ${key} in the cache.`;
      if (/^(del|delete|unlink)$/i.test(e.cache?.op ?? "")) return `Removed ${key} from the cache.`;
      return `Cache ${e.cache?.op ?? "call"} ${key}`;
    }
    case "external_call": {
      const who = e.place?.kind === "service" ? serviceWords(e.place) : e.place ? placeWords(e.place) : (hostOf(e.http?.url) ?? "another server");
      const res = e.http?.status ? `: ${statusWords(e.http.status)}` : "";
      const why = refusal(e);
      return `Called ${who}${res}${failed || (e.http?.status ?? 0) >= 400 ? (why ? `. ${sentence(why)}` : ".") : ""}`;
    }
  }
}

export function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

function tag(e: DebugEvent): string | undefined {
  // A failed call shows its arguments (the clue, e.g. userId: undefined); the caption carries the error.
  const args = e.kind === "function" ? (e.args ?? []).filter((a) => a !== "res" && !a.startsWith("[Function")).join(", ") : "";
  if (args) return clip(`${e.name.replace(/\(\)$/, "")}(${args})`, 90);
  if (e.status === "error" && e.error?.message) return `✕ ${clip(e.error.message, 70)}`;
  if (e.kind === "function" && e.returned && e.returned !== "undefined") return clip(`→ ${e.returned}`, 90);
  if (e.kind === "log") return clip(e.log?.message ?? "", 70);
  if ((e.kind === "http_request" || e.kind === "external_call") && e.http?.status) return statusWords(e.http.status);
  if (e.kind === "cache_op" && e.cache?.key) return `${e.cache.op} ${e.cache.key}${e.cache.hit === undefined ? "" : e.cache.hit ? " (hit)" : " (miss)"}`;
  return undefined;
}

/** Depth-first, start-time order. Framework events are skipped but their children kept. */
// ponytail: known framework dev-server endpoints (Next's overlay and HMR, Vite's ping); a project-level ignore list is the upgrade path.
const DEV_PATH = /^\/(__nextjs_|_next\/webpack-hmr|__webpack_hmr|__vite_ping)/;
const pathOf = (url = "") => {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url;
  }
};
/** A request the framework's dev tooling made on its own: not part of what the click did. */
export const devNoise = (e: DebugEvent): boolean => (e.kind === "http_request" || e.kind === "external_call") && DEV_PATH.test(pathOf(e.http?.url));

export function toSteps(view: ActionView): PlayStep[] {
  const out: PlayStep[] = [];
  const push = (raw: DebugEvent, depth: number) => {
    const e = raw.kind === "log" && raw.log && raw.log.message.includes("\u001b") ? { ...raw, log: { ...raw.log, message: stripAnsi(raw.log.message) } } : raw; // a coloured logger's escapes are not words
    out.push({
      id: e.id,
      index: out.length,
      event: e,
      depth,
      realm: e.origin === "browser" || e.kind === "user_action" ? "browser" : "server",
      at: e.source,
      caption: caption(e),
      tag: tag(e),
      status: e.status,
      startMs: e.startMs,
      durationMs: e.durationMs ?? 0,
    });
  };
  const walk = (nodes: TimelineNode[], depth: number) => {
    for (const n of [...nodes].sort((a, b) => a.event.startMs - b.event.startMs)) {
      if (devNoise(n.event)) continue;
      if (n.event.framework) walk(n.children ?? [], depth);
      else {
        push(n.event, depth);
        walk(n.children ?? [], depth + 1);
      }
    }
  };
  push(view.root, 0);
  walk(view.tree ?? [], 1);
  return out;
}

/** The step to land on first: the deepest failing function under the first failure (where the clue is), else the last step. */
export function focusIndex(steps: PlayStep[]): number {
  const first = steps.findIndex((s) => s.status === "error" && s.event.kind !== "user_action" && s.event.kind !== "http_request");
  if (first < 0) return Math.max(0, steps.length - 1);
  let best = first;
  for (let j = first + 1; j < steps.length && steps[j]!.depth > steps[first]!.depth; j++) {
    const s = steps[j]!;
    if (s.status === "error" && s.event.kind === "function" && s.depth > steps[best]!.depth) best = j;
  }
  return best;
}
