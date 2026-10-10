// Collection scripts in a locked node:vm context inside a worker thread. Nothing from the host realm goes in: inputs
// cross as one JSON string, the bru/req/res objects are built inside the context, and only a JSON string comes back.
// No require, process, timers or network; string code generation is off. Main kills the worker after 2s, so a loop
// in a promise callback can't hang or corrupt main (vm's own timeout can, with microtasks).
import { Worker } from "node:worker_threads";

export interface ScriptReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}
export interface ScriptIn {
  code: string;
  req: ScriptReq;
  res?: { status: number; statusText: string; headers: Record<string, string>; body: unknown; responseTime: number };
  vars: Record<string, string>;
  env: Record<string, string>;
}
export interface ScriptOut {
  req: ScriptReq;
  setVars: Record<string, string>;
  setEnv: Record<string, string>;
  logs: string[];
  tests: { name: string; ok: boolean; error?: string }[];
  error?: string;
}

const PRELUDE = String.raw`
"use strict";
const __in = JSON.parse(__input);
const __out = { req: __in.req, setVars: {}, setEnv: {}, logs: [], tests: [], done: false };
const __str = (v) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
const __fmt = (a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 2000);
const console = { log: (...a) => { if (__out.logs.length < 200) __out.logs.push(__fmt(a)); } };
console.info = console.warn = console.error = console.debug = console.log;
const bru = {
  setVar: (k, v) => { __out.setVars[String(k)] = __str(v); __in.vars[String(k)] = __str(v); },
  getVar: (k) => __in.vars[String(k)],
  getEnvVar: (k) => __in.env[String(k)],
  setEnvVar: (k, v) => { __out.setEnv[String(k)] = __str(v); __in.env[String(k)] = __str(v); },
  interpolate: (s) => String(s).replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, n) => (n in __in.vars ? __in.vars[n] : n in __in.env ? __in.env[n] : m)),
};
const __h = (name) => Object.keys(__out.req.headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
const req = {
  getUrl: () => __out.req.url, setUrl: (u) => { __out.req.url = String(u); },
  getMethod: () => __out.req.method, setMethod: (m) => { __out.req.method = String(m).toUpperCase(); },
  getHeader: (n) => __out.req.headers[__h(n)], getHeaders: () => ({ ...__out.req.headers }),
  setHeader: (n, v) => { const k = __h(n); if (k) delete __out.req.headers[k]; __out.req.headers[String(n)] = String(v); },
  deleteHeader: (n) => { const k = __h(n); if (k) delete __out.req.headers[k]; },
  getBody: () => { try { return JSON.parse(__out.req.body); } catch { return __out.req.body; } },
  setBody: (b) => { __out.req.body = typeof b === "string" ? b : JSON.stringify(b); },
};
const res = __in.res && Object.assign({}, __in.res, {
  getStatus: () => __in.res.status, getStatusText: () => __in.res.statusText, getBody: () => __in.res.body,
  getHeader: (n) => { const k = Object.keys(__in.res.headers).find((x) => x.toLowerCase() === String(n).toLowerCase()); return k && __in.res.headers[k]; },
  getHeaders: () => __in.res.headers, getResponseTime: () => __in.res.responseTime,
});
const __deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expect = (v) => {
  const fail = (m) => { throw new Error(m); };
  const to = {
    equal: (x) => v === x || fail("expected " + __str(v) + " to equal " + __str(x)),
    eql: (x) => __deq(v, x) || fail("expected " + __str(v) + " to deeply equal " + __str(x)),
    include: (x) => (__str(v).includes(__str(x)) || (Array.isArray(v) && v.some((y) => __deq(y, x)))) || fail("expected " + __str(v) + " to include " + __str(x)),
    above: (x) => v > x || fail("expected " + __str(v) + " to be above " + x),
    below: (x) => v < x || fail("expected " + __str(v) + " to be below " + x),
    a: (t) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v) === t || fail("expected " + __str(v) + " to be a " + t),
    exist: () => (v !== null && v !== undefined) || fail("expected a value"),
  };
  to.be = to; to.have = to; to.an = to.a;
  return { to };
};
const test = (name, fn) => {
  try { const r = fn(); __out.tests.push({ name: String(name), ok: true }); if (r && typeof r.then === "function") r.then(null, (e) => { const t = __out.tests.find((x) => x.name === String(name)); t.ok = false; t.error = String(e && e.message || e); }); }
  catch (e) { __out.tests.push({ name: String(name), ok: false, error: String(e && e.message || e) }); }
};
`;

// Runs in the worker (CommonJS eval). Posts one JSON string or a syntax error message.
const WORKER = String.raw`
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");
const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false }, name: "shrike-script" });
vm.runInContext("var __input = " + JSON.stringify(workerData.input) + ";", ctx);
let script;
try {
  script = new vm.Script("(function(){" + workerData.body + "\nglobalThis.__result = () => JSON.stringify(__out);})()", { filename: "script.js" });
} catch (err) {
  parentPort.postMessage({ syntax: err instanceof Error ? err.message : "check the brackets and quotes" });
}
if (script) {
  let threw = false;
  try { script.runInContext(ctx); } catch { threw = true; }
  setImmediate(() => setImmediate(() => {
    let raw = "";
    try { raw = vm.runInContext("typeof __result === 'function' ? __result() : ''", ctx); } catch {}
    parentPort.postMessage({ raw: typeof raw === "string" ? raw : "", threw });
  }));
}
`;

export async function runScript(input: ScriptIn, timeoutMs = 2000): Promise<ScriptOut> {
  const fallback: ScriptOut = { req: input.req, setVars: {}, setEnv: {}, logs: [], tests: [] };
  const body = `${PRELUDE}
(async function (bru, req, res, test, expect, console) {
${input.code}
})(bru, req, res, test, expect, console).then(() => { __out.done = true; }, (e) => { __out.error = String((e && e.message) || e); __out.done = true; });
`;
  const json = JSON.stringify({ req: input.req, res: input.res, vars: { ...input.vars }, env: { ...input.env } });
  const msg = await new Promise<{ raw?: unknown; threw?: unknown; syntax?: unknown; timedOut?: true; failed?: true }>((resolve) => {
    const w = new Worker(WORKER, { eval: true, workerData: { input: json, body }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }, env: {}, stdout: true, stderr: true });
    const timer = setTimeout(() => {
      resolve({ timedOut: true });
      void w.terminate();
    }, timeoutMs);
    w.once("message", (m: unknown) => {
      clearTimeout(timer);
      resolve(m && typeof m === "object" ? (m as { raw?: unknown }) : { failed: true });
      void w.terminate();
    });
    w.once("error", () => (clearTimeout(timer), resolve({ failed: true })));
    w.once("exit", () => (clearTimeout(timer), resolve({ failed: true })));
  });
  if (msg.timedOut) return { ...fallback, error: `The script took longer than ${timeoutMs / 1000}s and was stopped.` };
  if (typeof msg.syntax === "string") return { ...fallback, error: `The script has a syntax error: ${msg.syntax}` };
  const raw = msg.raw;
  const error = msg.threw === true ? "The script stopped with an error." : undefined;
  if (typeof raw !== "string" || !raw) return { ...fallback, error: error ?? "The script didn't run." };
  let out: Partial<ScriptOut> & { done?: boolean };
  try {
    out = JSON.parse(raw) as typeof out;
  } catch {
    return { ...fallback, error: "The script returned something Shrike can't read." };
  }
  const strs = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const r = (out.req ?? {}) as Partial<ScriptReq>;
  return {
    req: { method: typeof r.method === "string" ? r.method : input.req.method, url: typeof r.url === "string" ? r.url : input.req.url, headers: strs(r.headers), body: typeof r.body === "string" ? r.body : input.req.body },
    setVars: strs(out.setVars),
    setEnv: strs(out.setEnv),
    logs: Array.isArray(out.logs) ? out.logs.filter((l): l is string => typeof l === "string") : [],
    tests: Array.isArray(out.tests) ? out.tests.filter((t) => t && typeof t.name === "string").map((t) => ({ name: t.name, ok: t.ok === true, ...(typeof t.error === "string" ? { error: t.error } : {}) })) : [],
    ...(error ? { error } : typeof out.error === "string" ? { error: out.error } : out.done ? {} : { error: "The script didn't finish (it waited on something that never came)." }),
  };
}
