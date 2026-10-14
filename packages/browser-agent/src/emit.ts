import type { DebugEvent, FlowStep, IngestMessage, PointPick } from "@shrike/schema";

// O1: the page answers point mode on the same binding; main handles it before ingest parsing.
export type PointMessage = { type: "point"; pick?: PointPick; cancelled?: boolean };
// B1: a recorded user step; main listens for these only while it records a flow.
export type FlowStepMessage = { type: "flow_step"; step: FlowStep };

type Binding = (payload: string) => void;

const MAX_QUEUE = 500;
const queue: string[] = [];
let retrying = false;
const setT = window.setTimeout.bind(window);

// #54: taken once at document start, then removed before any page script runs (this script runs in every frame, so iframes too).
// A page that loaded before the binding existed records nothing rather than trusting whatever sits there later.
const w = window as unknown as { __shrikeEmit?: unknown };
const bound = typeof w.__shrikeEmit === "function" ? (w.__shrikeEmit as Binding) : undefined;
try {
  delete w.__shrikeEmit;
} catch {}

function flush(): boolean {
  const b = bound;
  if (!b) return false;
  while (queue.length) {
    try {
      b(queue[0]!);
    } catch {
      return false;
    }
    queue.shift();
  }
  return true;
}

function retry(): void {
  if (retrying) return;
  retrying = true;
  setT(function tick() {
    if (flush()) retrying = false;
    else setT(tick, 200);
  }, 200);
}

export function send(msg: IngestMessage | PointMessage | FlowStepMessage): void {
  if (!bound) return;
  try {
    queue.push(JSON.stringify(msg));
    if (queue.length > MAX_QUEUE) queue.shift();
    if (!flush()) retry();
  } catch {
    // never throw into the page
  }
}

export function emitEvent(e: DebugEvent): void {
  send({ type: "events", events: [e] });
}
