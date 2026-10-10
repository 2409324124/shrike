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

function binding(): Binding | undefined {
  const b = (window as unknown as { __shrikeEmit?: unknown }).__shrikeEmit;
  return typeof b === "function" ? (b as Binding) : undefined;
}

function flush(): boolean {
  const b = binding();
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
