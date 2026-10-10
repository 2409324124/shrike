import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { preview } from "./preview.mjs";
import { servicePlace } from "./place.mjs";
import { captureStack, userFrame } from "./stack.mjs";

export const als = new AsyncLocalStorage();
export const ZERO_TRACE = "0".repeat(32);
export const newId = () => randomBytes(8).toString("hex");
export const newTraceId = () => randomBytes(16).toString("hex");
export const now = () => performance.timeOrigin + performance.now();

let sink = () => {};
let busy = false; // true while Shrike itself runs code that may call back into user code

export function setSink(fn) {
  sink = fn;
}

// Runs `fn` with re-entry into Shrike disabled. Never throws.
export function quietly(fn) {
  if (busy) return undefined;
  busy = true;
  try {
    return fn();
  } catch {
    return undefined;
  } finally {
    busy = false;
  }
}

export const isBusy = () => busy;

export function emit(event) {
  try {
    event.place ??= servicePlace;
    sink(event);
  } catch {}
}

export function errorInfo(e) {
  try {
    if (e instanceof Error) return { message: String(e.message), type: e.name, stack: e.stack };
    return { message: preview(e), type: typeof e };
  } catch {
    return { message: "unknown error" };
  }
}

const round = (ms) => Math.round(ms * 100) / 100;

// One library call (database, cache) as a child of the current context. `build()` returns the event's
// kind/name/origin/place/payload (given the caller's source); `settle(event, value)` adds result details. Calls the library made
// on its own behalf (lib context) are not recorded. `observe`: watch the original promise instead of
// returning a derived one, for libraries that also take callbacks (a derived promise would go unhandled).
export function libCall(stackFn, build, call, settle, observe = false) {
  const parent = als.getStore();
  if (!parent || parent.lib || busy) return call();
  const event = quietly(() => {
    // Lazy query builders (Drizzle, Prisma) start the query from a then() job with no user frame on the stack;
    // the enclosing function step's location stands in.
    const source = userFrame(captureStack(stackFn).stack) ?? (parent.source && { ...parent.source, precision: "approximate" });
    const e = { id: newId(), traceId: parent.traceId, parentId: parent.eventId, startMs: now(), status: "ok", ...build(source) };
    if (source) e.source = source;
    return e;
  });
  if (!event) return call();
  const end = (failed, value) =>
    quietly(() => {
      event.durationMs = round(now() - event.startMs);
      if (failed) {
        event.status = "error";
        event.error = errorInfo(value);
      } else settle?.(event, value);
      emit(event);
    });
  let result;
  try {
    result = als.run({ traceId: parent.traceId, eventId: event.id, lib: true }, call);
  } catch (e) {
    end(true, e);
    throw e;
  }
  if (!(result instanceof Promise)) {
    end(false, result);
    return result;
  }
  if (observe) {
    result.then(
      (v) => end(false, v),
      (e) => end(true, e),
    );
    return result;
  }
  return result.then(
    (v) => {
      end(false, v);
      return v;
    },
    (e) => {
      end(true, e);
      throw e;
    },
  );
}

const defs = new Map();

function def(_fileIndex, entries) {
  try {
    for (const e of entries) defs.set(e.id, e);
  } catch {}
}

function start(id, args) {
  const parent = als.getStore();
  const d = defs.get(id);
  if (!parent || !d) return undefined;
  const ctx = { traceId: parent.traceId, eventId: newId(), source: { file: d.file, line: d.line, column: d.column } };
  const event = {
    id: ctx.eventId,
    traceId: ctx.traceId,
    parentId: parent.eventId,
    origin: "server",
    kind: "function",
    name: `${d.name}()`,
    startMs: now(),
    status: "ok",
    source: { file: d.file, line: d.line, column: d.column, functionName: d.name, precision: "exact" },
    args: Array.from(args ?? [], (a, i) => (d.secret?.includes(i) ? "[redacted]" : preview(a))),
  };
  return { ctx, event, holder: captureStack(run), t0: now() };
}

function finish(rec, failed, value) {
  quietly(() => {
    const { event } = rec;
    event.durationMs = Math.round((now() - rec.t0) * 100) / 100;
    // Frame 0 is the wrapped function itself; the call site is the next user frame.
    const callSite = userFrame(rec.holder.stack, 1);
    if (callSite) event.callSite = callSite;
    if (failed) {
      event.status = "error";
      event.error = errorInfo(value);
    } else {
      event.returned = preview(value);
    }
    emit(event);
  });
}

function run(id, args, fn) {
  const rec = als.getStore() && !busy ? quietly(() => start(id, args)) : undefined;
  if (!rec) return fn();
  let result;
  try {
    result = als.run(rec.ctx, fn);
  } catch (e) {
    finish(rec, true, e);
    throw e;
  }
  // ponytail: native promises only (calling .then on other thenables can run queries); returns a derived promise, so identity differs.
  if (result instanceof Promise) {
    return result.then(
      (v) => {
        finish(rec, false, v);
        return v;
      },
      (e) => {
        finish(rec, true, e);
        throw e;
      },
    );
  }
  finish(rec, false, result);
  return result;
}

export function installRuntime() {
  Object.defineProperty(globalThis, "__shrike", {
    value: Object.freeze({ def, run }),
    enumerable: false,
    configurable: true,
    writable: false,
  });
}
