import type { DebugEvent, SourceLocation } from "@shrike/schema";
import { emitEvent, send } from "./emit.ts";
import { newEventId, newTraceId } from "./ids.ts";

export interface Action {
  root: DebugEvent;
  pending: number;
  failed: boolean;
  lastActivity: number;
  closed: boolean;
  timer?: number;
}

const CLOSE_DELAY = 400;
const setT = window.setTimeout.bind(window);
const clearT = window.clearTimeout.bind(window);

let current: Action | null = null;
let lastOpened: Action | null = null;

export const currentAction = (): Action | null => current;
export const lastOpenedId = (): string | null => lastOpened?.root.id ?? null;

export function openAction(
  trigger: NonNullable<DebugEvent["trigger"]>,
  name: string,
  source?: SourceLocation,
  startMs = Date.now(),
  target?: Element | null,
): Action {
  const root: DebugEvent = {
    id: newEventId(),
    traceId: newTraceId(),
    origin: "browser",
    kind: "user_action",
    name,
    startMs,
    status: "ok",
    trigger,
  };
  if (source) root.source = source;
  if (target) {
    const r = target.getBoundingClientRect();
    root.target = { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  }
  const a: Action = { root, pending: 0, failed: false, lastActivity: startMs, closed: false };
  current = a;
  lastOpened = a;
  emitEvent(root);
  // Count the click handler's own synchronous run as activity.
  setT(() => (a.lastActivity = Math.max(a.lastActivity, Date.now())), 0);
  scheduleClose(a);
  return a;
}

function scheduleClose(a: Action): void {
  if (a.timer !== undefined) clearT(a.timer);
  a.timer = undefined;
  if (a.pending > 0 || a.closed) return;
  a.timer = setT(() => closeAction(a), CLOSE_DELAY);
}

function closeAction(a: Action): void {
  if (a.closed || a.pending > 0) return;
  a.closed = true;
  if (current === a) current = null;
  const at = Date.now();
  send({ type: "action_end", actionId: a.root.id, at });
  emitEvent({ ...a.root, durationMs: Math.max(0, a.lastActivity - a.root.startMs), status: a.failed ? "error" : "ok" });
}

// Joins the open action, or opens an implicit one. Returns the action and a settle callback (idempotent).
export function beginWork(implicitName: string): { action: Action; settle(failed: boolean): void } {
  const a = current ?? openAction("click", implicitName);
  a.pending++;
  if (a.timer !== undefined) clearT(a.timer);
  a.timer = undefined;
  let done = false;
  return {
    action: a,
    settle(failed) {
      if (done) return;
      done = true;
      a.pending--;
      if (failed) a.failed = true;
      a.lastActivity = Math.max(a.lastActivity, Date.now());
      scheduleClose(a);
    },
  };
}

export function markFailed(a: Action): void {
  a.failed = true;
}
