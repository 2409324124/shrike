// Places (docs/12-feature-map.md D1, D3, D7): who this process is, who called it, where it calls out to.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function packageName(file) {
  try {
    for (let dir = path.dirname(realpathSync(file)); ; dir = path.dirname(dir)) {
      try {
        const name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
        if (typeof name === "string" && name) return name;
      } catch {}
      if (path.dirname(dir) === dir) return undefined;
    }
  } catch {
    return undefined;
  }
}

export function serviceName(env = process.env, argv1 = process.argv[1]) {
  // A framework CLI (next, remix-serve) runs from node_modules: name the app the CLI was started in, not the CLI.
  const from = argv1 && !argv1.split(/[\\/]/).includes("node_modules") ? argv1 : path.join(process.cwd(), "package.json");
  const raw = env.SHRIKE_SERVICE?.trim() || packageName(from) || "app";
  return raw.replace(/^@[^/]+\//, "");
}

export function makeServicePlace(name) {
  return { kind: "service", id: `service:${name.toLowerCase()}`, name: name.toUpperCase() };
}

// Shared by every event this process emits; detail is filled in once the server listens.
export const servicePlace = makeServicePlace(serviceName());

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "localhost"]);

// "localhost:4101" for loopback (matches a service's detail), else host[:port] as given.
export function hostKey(hostname, port, defaultPort) {
  const h = LOOPBACK.has(hostname) ? "localhost" : hostname;
  return port && String(port) !== String(defaultPort) ? `${h}:${port}` : h;
}

// api.stripe.com -> STRIPE, hooks.slack.com -> SLACK, localhost:4199 -> LOCALHOST:4199
export function hostLabel(host) {
  const [name] = host.split(":");
  if (!name || /^[\d.]+$/.test(name) || !name.includes(".")) return host.toUpperCase();
  const parts = name.split(".");
  return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]).toUpperCase();
}

export function outsidePlace(url) {
  const host = hostKey(url.hostname, url.port, url.protocol === "https:" ? 443 : 80);
  return { kind: "outside", id: `outside:${host}`, name: hostLabel(host), detail: host };
}

const CALLER_KINDS = new Set(["browser", "curl", "postman", "explorer", "agent", "cron", "test", "service", "other"]);

// The process itself is a caller (a cron or test script) when SHRIKE_CALLER is set.
export function processCaller(env = process.env) {
  const v = env.SHRIKE_CALLER?.trim();
  if (!v) return undefined;
  let script;
  try {
    if (process.argv[1] && env.SHRIKE_PROJECT_ROOT) script = path.relative(env.SHRIKE_PROJECT_ROOT, process.argv[1]).split(path.sep).join("/");
  } catch {}
  return { kind: CALLER_KINDS.has(v) ? v : "other", label: v, ...(script && !script.startsWith("..") ? { command: `node ${script}` } : {}) };
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Who sent a request that is not part of a browser trip, from its user-agent.
export function callerFromRequest(headers, method, url, body) {
  const ua = String(headers["user-agent"] ?? "");
  if (/^curl\//i.test(ua)) {
    const host = headers.host ? `http://${headers.host}` : "";
    let command = `curl${method === "GET" ? "" : ` -X ${method}`} ${shellQuote(host + url)}`;
    if (headers["content-type"] && body) command += ` -H ${shellQuote(`content-type: ${headers["content-type"]}`)}`;
    if (body) command += ` -d ${shellQuote(body.length > 500 ? body.slice(0, 500) + "…" : body)}`;
    return { kind: "curl", label: "curl", command };
  }
  if (/PostmanRuntime/i.test(ua)) return { kind: "postman", label: "Postman" };
  if (/shrike-explorer/i.test(ua)) return { kind: "explorer", label: "API explorer" };
  if (/shrike-agent/i.test(ua)) return { kind: "agent", label: "agent" };
  if (/^Mozilla\//.test(ua)) return { kind: "browser", label: "browser" };
  // ponytail: an uninstrumented node process (undici, node-fetch, axios) can't be told apart from a script; "other".
  const product = /^([\w.-]+)/.exec(ua)?.[1]?.toLowerCase();
  if (!product) return { kind: "other", label: "unknown" };
  return { kind: "other", label: product === "undici" ? "node" : product };
}
