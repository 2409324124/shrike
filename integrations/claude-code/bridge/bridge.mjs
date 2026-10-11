#!/usr/bin/env node
// Shrike's MCP server for Claude Code: a stdio bridge to the running Shrike app's Streamable HTTP server on 127.0.0.1.
// The address and token are read from Shrike's own mcp.json, never stored in the plugin. A new session re-reads it,
// so Shrike restarting (new port or token) needs no reconfiguring.
// ponytail: no GET stream, so Shrike's own server-initiated notifications aren't forwarded; none are sent today.
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const DOWN = "Shrike isn't running. Open Shrike, then run /mcp in Claude Code and reconnect plugin:shrike:shrike.";
const URL_OK = /^http:\/\/127\.0\.0\.1:\d{2,5}\/mcp$/;
const AUTH_OK = /^Bearer [0-9a-f]{64}$/;

/** Where Shrike keeps mcp.json: its userData folder, packaged ("Shrike") or from source ("@shrike/desktop"). */
export function configPaths(env = process.env, platform = process.platform, home = homedir()) {
  if (env.SHRIKE_MCP_CONFIG) return [env.SHRIKE_MCP_CONFIG];
  const base = platform === "darwin" ? join(home, "Library", "Application Support") : platform === "win32" ? (env.APPDATA ?? join(home, "AppData", "Roaming")) : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return [join(base, "Shrike", "mcp.json"), join(base, "@shrike", "desktop", "mcp.json")];
}

/** The newest valid saved config (Shrike rewrites it on each launch), or undefined. Only a 127.0.0.1 address is accepted. */
export async function readShrike(paths) {
  let best;
  for (const p of paths) {
    const got = await Promise.all([readFile(p, "utf8"), stat(p)]).catch(() => undefined);
    if (!got) continue;
    let s;
    try {
      s = JSON.parse(got[0])?.mcpServers?.shrike;
    } catch {
      continue;
    }
    if (typeof s?.url !== "string" || !URL_OK.test(s.url) || typeof s.headers?.Authorization !== "string" || !AUTH_OK.test(s.headers.Authorization)) continue;
    if (!best || got[1].mtimeMs > best.mtime) best = { url: s.url, auth: s.headers.Authorization, mtime: got[1].mtimeMs };
  }
  return best;
}

/** POST one JSON-RPC message; calls onMessage for each message in the reply (JSON or an SSE stream). Resolves to the status and session. */
function post(conf, session, msg, onMessage, onSession = () => {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(msg);
    const req = http.request(conf.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: conf.auth, "content-length": Buffer.byteLength(body), ...(session ? { "mcp-session-id": session } : {}) },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      onSession(res.headers["mcp-session-id"]); // before any reply reaches Claude Code, which may answer at once
      const sse = String(res.headers["content-type"] ?? "").includes("text/event-stream");
      const deliver = (text) => {
        try {
          onMessage(JSON.parse(text));
        } catch {}
      };
      let buf = "";
      let data = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        if (!sse) return;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line === "" && data.length) (deliver(data.join("\n")), (data = []));
        }
      });
      res.on("end", () => {
        if (!sse && res.statusCode === 200 && buf.trim()) {
          try {
            const parsed = JSON.parse(buf);
            for (const m of Array.isArray(parsed) ? parsed : [parsed]) onMessage(m);
          } catch {}
        }
        resolve({ status: res.statusCode ?? 0, session: res.headers["mcp-session-id"] });
      });
      res.on("error", reject);
    });
    req.end(body);
  });
}

/** Runs the bridge on newline-delimited JSON-RPC: lines from input, replies to write(message). Requests run side by side, so a propose_patch waiting on the user doesn't hold up other calls. */
export function startBridge({ paths = configPaths(), input = process.stdin, write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`), log = (s) => process.stderr.write(`shrike: ${s}\n`) } = {}) {
  let conf;
  let session;
  let init; // the client's initialize request, replayed when Shrike restarts
  let reopening;

  const reply = (msg, message) => msg.id !== undefined && msg.method && write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });

  // A fresh session against whatever mcp.json says now. The replayed initialize's reply isn't forwarded.
  const reopen = () =>
    (reopening ??= (async () => {
      conf = await readShrike(paths);
      session = undefined;
      if (!conf || !init) return false;
      const r = await post(conf, undefined, init, () => {}).catch(() => undefined);
      if (r?.status !== 200 || typeof r.session !== "string") return false;
      session = r.session;
      await post(conf, session, { jsonrpc: "2.0", method: "notifications/initialized" }, () => {}).catch(() => {});
      return true;
    })().finally(() => (reopening = undefined)));

  const handle = async (msg) => {
    if (msg.method === "initialize") {
      init = msg;
      conf = await readShrike(paths);
      session = undefined;
    }
    const keep = (s) => typeof s === "string" && (session = s);
    const send = async () => (conf ? post(conf, session, msg, write, keep).catch(() => undefined) : undefined);
    let r = await send();
    // Shrike restarted (refused, unknown session) or got a new token: start over once from its current mcp.json.
    if ((!r || r.status === 401 || r.status === 404) && msg.method !== "initialize" && init && (await reopen())) r = await send();
    if (!r) return (log(DOWN), reply(msg, DOWN));
    if (r.status === 401) return reply(msg, "Shrike refused the saved token. Open Shrike, then run /mcp in Claude Code and reconnect plugin:shrike:shrike.");
    if (r.status >= 400) reply(msg, `Shrike answered ${r.status}.`);
  };

  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = handle(msg).catch((err) => log(String(err)));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  // Resolves once input has ended and every reply is written.
  const closed = new Promise((resolve) => rl.on("close", resolve)).then(() => Promise.allSettled([...pending]));
  return { close: () => rl.close(), closed };
}

const isMain = () => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
};
if (isMain()) void startBridge().closed.then(() => process.exit(0));
