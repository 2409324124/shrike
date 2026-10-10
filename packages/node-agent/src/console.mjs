import { format } from "node:util";
import { cut } from "./preview.mjs";
import { captureStack, userFrame } from "./stack.mjs";
import { ZERO_TRACE, als, emit, isBusy, newId, now, quietly } from "./runtime.mjs";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const LEVELS = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
const MAX_MESSAGE = 8 * 1024;

export function patchConsole() {
  for (const [method, level] of Object.entries(LEVELS)) {
    const orig = console[method];
    if (typeof orig !== "function") continue;
    const patched = {
      [method](...args) {
        if (!isBusy()) quietly(() => record(level, args, patched));
        return orig.apply(this, args);
      },
    }[method];
    console[method] = patched;
  }
}

function record(level, args, fn) {
  const parent = als.getStore();
  const message = cut(format(...args).replace(ANSI, ""), MAX_MESSAGE); // a coloured logger (hono, morgan) writes escapes, not words
  const event = {
    id: newId(),
    traceId: parent?.traceId ?? ZERO_TRACE,
    origin: "server",
    kind: "log",
    name: message.split("\n")[0].slice(0, 120),
    startMs: now(),
    status: "ok",
    log: { level, message },
  };
  if (parent) event.parentId = parent.eventId;
  const source = userFrame(captureStack(fn).stack);
  if (source) event.source = source;
  emit(event);
}
