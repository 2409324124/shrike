// Outgoing HTTP (D7, D13): global fetch and http(s).request get a traceparent and an external_call event.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { cut } from "./preview.mjs";
import { outsidePlace, processCaller } from "./place.mjs";
import { als, emit as emitEvent, errorInfo, newId, newTraceId, now, quietly } from "./runtime.mjs";
import { reclassify } from "./drivers/http.mjs";
import { captureStack, userFrame } from "./stack.mjs";

const BODY_LIMIT = 64 * 1024;
const emit = (event) => emitEvent(reclassify(event)); // Supabase, Upstash, Neon, libSQL over HTTP land on their database's lane
const caller = processCaller();
let ingest = "";

// Inside a trip: continue it. Outside one, only a SHRIKE_CALLER script (cron, test) starts a new trip per call.
// Callers run this inside quietly(), so a call Shrike itself makes never gets here.
function context() {
  const parent = als.getStore();
  if (parent) return parent.lib ? undefined : { traceId: parent.traceId, parentId: parent.eventId };
  return caller ? { traceId: newTraceId(), caller } : undefined;
}

function start(ctx, method, url, stackFn) {
  if (ingest && (url.href + "/").startsWith(ingest)) return undefined;
  const place = outsidePlace(url);
  const event = {
    id: newId(),
    traceId: ctx.traceId,
    origin: "server",
    kind: "external_call",
    name: `${method} ${place.detail}${url.pathname}`,
    startMs: now(),
    status: "ok",
    http: { method, url: url.href },
    place,
  };
  if (ctx.parentId) event.parentId = ctx.parentId;
  if (ctx.caller) event.caller = ctx.caller;
  const source = userFrame(captureStack(stackFn).stack);
  if (source) event.source = source;
  return event;
}

const traceparent = (event) => `00-${event.traceId}-${event.id}-01`;

function gotResponse(event, status, resHeaders) {
  event.durationMs = Math.round((now() - event.startMs) * 100) / 100;
  event.http.status = status;
  event.http.resHeaders = resHeaders;
  // ponytail: any 4xx counts as an error (the outside service refused); the trip's own status decides the verdict.
  if (status >= 400) event.status = "error";
}

function failed(event, e) {
  event.durationMs ??= Math.round((now() - event.startMs) * 100) / 100;
  event.status = "error";
  event.error = errorInfo(e);
}

const readable = (type) => /json|text\/(?!event-stream)|xml|x-www-form-urlencoded/i.test(type ?? "");

// ---- fetch

function patchFetch() {
  const orig = globalThis.fetch;
  if (typeof orig !== "function") return;
  globalThis.fetch = function fetch(input, init) {
    const rec = quietly(() => {
      const ctx = context();
      if (!ctx) return undefined;
      const isReq = typeof Request === "function" && input instanceof Request;
      const url = new URL(isReq ? input.url : input instanceof URL ? input.href : String(input));
      const method = String(init?.method ?? (isReq ? input.method : "GET")).toUpperCase();
      const event = start(ctx, method, url, fetch);
      if (!event) return undefined;
      const headers = new Headers(init?.headers ?? (isReq ? input.headers : undefined));
      if (!headers.has("traceparent")) headers.set("traceparent", traceparent(event));
      event.http.reqHeaders = Object.fromEntries(headers);
      if (typeof init?.body === "string") event.http.reqBody = cut(init.body, BODY_LIMIT);
      return { event, init: { ...init, headers } };
    });
    if (!rec) return orig.apply(this, arguments);
    const { event } = rec;
    return orig.call(this, input, rec.init).then(
      (res) => {
        quietly(() => {
          gotResponse(event, res.status, Object.fromEntries(res.headers));
          if (!readable(res.headers.get("content-type"))) return emit(event);
          let sent = false;
          const send = () => {
            if (!sent) emit(event);
            sent = true;
          };
          // ponytail: a body still streaming after 2s is left out rather than holding the event.
          setTimeout(send, 2000).unref();
          res
            .clone()
            .text()
            .then(
              (t) => {
                if (t) event.http.resBody = cut(t, BODY_LIMIT);
                send();
              },
              send,
            );
        });
        return res;
      },
      (e) => {
        quietly(() => {
          failed(event, e);
          emit(event);
        });
        throw e;
      },
    );
  };
}

// ---- http(s).request

function track(req, stackFn) {
  const ctx = context();
  if (!ctx) return;
  const url = new URL(`${req.protocol ?? "http:"}//${req.getHeader("host") ?? req.host}${req.path ?? "/"}`);
  const event = start(ctx, String(req.method ?? "GET"), url, stackFn);
  if (!event) return;
  if (!req.headersSent && req.getHeader("traceparent") === undefined) req.setHeader("traceparent", traceparent(event));
  event.http.reqHeaders = Object.fromEntries(Object.entries(req.getHeaders()).map(([k, v]) => [k, String(v)]));

  let done = false;
  const finish = (e) => {
    if (done) return;
    done = true;
    if (e !== undefined || event.http.status === undefined) failed(event, e ?? new Error("The connection closed before a response arrived"));
    emit(event);
  };
  const chunks = [];
  let size = 0;
  // Wrap emit instead of adding listeners: a 'response' listener would stop Node from draining unread responses.
  const reqEmit = req.emit;
  req.emit = function emit(type, arg) {
    quietly(() => {
      if (type === "error") finish(arg);
      else if (type === "close") finish();
      else if (type === "response") {
        const res = arg;
        gotResponse(event, res.statusCode, Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])));
        const resEmit = res.emit;
        res.emit = function emit(t, chunk) {
          quietly(() => {
            if (t === "data" && size <= BODY_LIMIT && chunk != null) {
              const buf = Buffer.from(chunk);
              chunks.push(buf);
              size += buf.length;
            } else if (t === "end" || t === "close") {
              if (size) event.http.resBody = cut(Buffer.concat(chunks).toString(), BODY_LIMIT);
              finish();
            }
          });
          return resEmit.apply(this, arguments);
        };
      }
    });
    return reqEmit.apply(this, arguments);
  };
}

function patchModule(mod) {
  const orig = mod.request;
  mod.request = function request(...args) {
    const req = orig.apply(this, args);
    quietly(() => track(req, request));
    return req;
  };
  // Same as Node's own get(): request() then end(), so it goes through the patched request.
  mod.get = function get(...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

export function patchOutgoing(ingestUrl) {
  ingest = ingestUrl ? String(ingestUrl).replace(/\/+$/, "") + "/" : "";
  patchFetch();
  patchModule(http);
  patchModule(https);
  syncBuiltinESMExports(); // so `import { request } from "node:http"` sees the patch too
}
