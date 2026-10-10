import http from "node:http";
import { inspect, types } from "node:util";

export const SECRET = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session/i;
const OPTS = { depth: 2, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 200 };
const MAX = 2048;

export function cut(s, max = MAX) {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

function isPlain(v) {
  if (v === null || typeof v !== "object" || types.isProxy(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null || Array.isArray(v);
}

// Returns a redacted copy only when something sensitive was found, else the value itself.
function redact(v, depth) {
  if (depth > 3 || !isPlain(v)) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const r = redact(x, depth + 1);
      if (r !== x) changed = true;
      return r;
    });
    return changed ? out : v;
  }
  let out;
  for (const key of Object.keys(v)) {
    const x = v[key];
    const r = SECRET.test(key) && x !== undefined ? "[redacted]" : redact(x, depth + 1);
    if (r !== x) {
      out ??= Object.assign(Object.create(Object.getPrototypeOf(v)), v);
      out[key] = r;
    }
  }
  return out ?? v;
}

// Rows from node:sqlite and the like have no prototype; that label is noise to the reader.
const show = (v) => inspect(redact(v, 0), OPTS).replaceAll("[Object: null prototype] ", "");

export function preview(v) {
  try {
    if (v instanceof http.IncomingMessage) {
      const body = v.body === undefined ? "" : ` body: ${show(v.body)}`;
      return cut(`req { ${v.method} ${v.originalUrl ?? v.url}${body} }`);
    }
    if (v instanceof http.ServerResponse) return "res";
    return cut(show(v));
  } catch {
    return "[unavailable]";
  }
}
