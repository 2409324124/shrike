import http from "node:http";
import https from "node:https";
import { callerFromRequest, servicePlace } from "./place.mjs";
import { cut } from "./preview.mjs";
import { als, emit, errorInfo, newId, newTraceId, now, quietly } from "./runtime.mjs";

const BODY_LIMIT = 64 * 1024;
const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/;

function bodyCollector() {
  const chunks = [];
  let size = 0;
  return {
    add(chunk, encoding) {
      if (size > BODY_LIMIT || chunk == null || typeof chunk === "function") return;
      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8")
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk) // copy: the caller may reuse its buffer
            : undefined;
      if (!buf) return;
      chunks.push(buf);
      size += buf.length;
    },
    text() {
      if (!size) return undefined;
      const all = Buffer.concat(chunks);
      return all.length > BODY_LIMIT ? all.subarray(0, BODY_LIMIT).toString() + "…[truncated]" : all.toString();
    },
  };
}

function flatHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

// The headers actually sent: writeHead(status, headers) bypasses getHeaders(), so read the raw head.
function sentHeaders(res) {
  if (typeof res._header !== "string") return flatHeaders(res.getHeaders());
  const out = {};
  for (const line of res._header.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return out;
}

function frameworkBody(body) {
  if (body === undefined) return undefined;
  try {
    const s = typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString() : JSON.stringify(body);
    return s === undefined ? undefined : cut(s, BODY_LIMIT);
  } catch {
    return undefined;
  }
}

function track(req, res) {
  const tp = TRACEPARENT.exec(String(req.headers.traceparent ?? "").trim().toLowerCase());
  const valid = tp && !/^0+$/.test(tp[1]) && !/^0+$/.test(tp[2]);
  const ctx = { traceId: valid ? tp[1] : newTraceId(), eventId: newId() };
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const startMs = now();
  const reqBody = bodyCollector();
  const resBody = bodyCollector();

  // Bind req/res event delivery to the request context so listeners like req.on("end") keep it.
  const reqEmit = req.emit;
  req.emit = function emit(type, chunk) {
    if (type === "data") quietly(() => reqBody.add(chunk));
    return als.run(ctx, () => reqEmit.apply(this, arguments));
  };
  const resEmit = res.emit;
  res.emit = function emit() {
    return als.run(ctx, () => resEmit.apply(this, arguments));
  };
  const resWrite = res.write;
  res.write = function write(chunk, encoding) {
    quietly(() => resBody.add(chunk, encoding));
    return resWrite.apply(this, arguments);
  };
  const resEnd = res.end;
  res.end = function end(chunk, encoding) {
    quietly(() => resBody.add(chunk, encoding));
    return resEnd.apply(this, arguments);
  };

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    quietly(() => {
      const status = res.statusCode;
      const event = {
        id: ctx.eventId,
        traceId: ctx.traceId,
        origin: "server",
        kind: "http_request",
        name: `${method} ${url.split("?")[0]}`,
        startMs,
        durationMs: Math.round((now() - startMs) * 100) / 100,
        status: status >= 500 ? "error" : "ok",
        http: {
          method,
          url,
          status,
          reqHeaders: flatHeaders(req.headers),
          resHeaders: sentHeaders(res),
          reqBody: frameworkBody(req.body) ?? reqBody.text(),
          resBody: resBody.text(),
        },
      };
      if (valid) event.parentId = tp[2];
      else event.caller = callerFromRequest(req.headers, method, url, event.http.reqBody);
      if (!res.writableFinished) {
        event.status = "error";
        event.error = errorInfo(new Error("The connection closed before the response finished"));
      }
      emit(event);
    });
  };
  res.once("finish", finish);
  res.once("close", finish);
  return ctx;
}

// The first server to listen names this service's address ("localhost:4100") and says hello again.
function listening(server, onListen) {
  if (servicePlace.detail) return;
  const a = server.address();
  if (!a || typeof a !== "object") return;
  servicePlace.detail = `localhost:${a.port}`;
  onListen?.(`http://localhost:${a.port}`);
}

const DEV_PATH = /^\/(__nextjs_|_next\/webpack-hmr|__webpack_hmr|__vite_ping)/; // the dev server's own endpoints (Next's error overlay, HMR), not the app's

export function patchHttp(onListen) {
  for (const proto of [http.Server.prototype, https.Server.prototype]) {
    const orig = proto.emit;
    proto.emit = function emit(type, req, res) {
      if (type === "listening") quietly(() => listening(this, onListen));
      if (type !== "request" || DEV_PATH.test(req?.url ?? "")) return orig.apply(this, arguments);
      const ctx = quietly(() => track(req, res));
      if (!ctx) return orig.apply(this, arguments);
      return als.run(ctx, () => orig.apply(this, arguments));
    };
  }
}
