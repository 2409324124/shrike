import type { ActionView, DebugEvent, Status, TimelineNode } from "@shrike/schema";
import { findFlags } from "./flags.ts";
import { summarize } from "./summary.ts";
import { allEvents, endOf, walk } from "./util.ts";

const mark = (e: DebugEvent): DebugEvent => (e.source?.file.includes("node_modules") && !e.framework ? { ...e, framework: true } : e);

// Parent id if it resolves to a real, non-root event without a cycle; otherwise undefined (attach to root).
function parentOf(e: DebugEvent, byId: Map<string, DebugEvent>, rootId: string): string | undefined {
  const pid = e.parentId;
  if (!pid || pid === rootId || !byId.has(pid)) return undefined;
  const seen = new Set<string>();
  for (let cur: string | undefined = pid; cur && cur !== rootId && byId.has(cur); cur = byId.get(cur)?.parentId) {
    if (cur === e.id) return undefined;
    if (seen.has(cur)) break;
    seen.add(cur);
  }
  return pid;
}

export function buildActionView(rootEvent: DebugEvent, events: DebugEvent[], complete: boolean): ActionView {
  const root = mark(rootEvent);
  const byId = new Map<string, DebugEvent>();
  for (const e of events) if (e.id !== root.id) byId.set(e.id, mark(e));
  // The page cancelled the request (it navigated away): the server seeing the connection close is not a break.
  for (const [id, e] of byId) {
    if (e.kind === "http_request" && e.origin === "server" && e.status === "error" && (e.http?.status ?? 0) < 500 && byId.get(e.parentId ?? "")?.error?.type === "AbortError") byId.set(id, { ...e, status: "ok" });
  }

  const nodes = new Map<string, TimelineNode>();
  for (const [id, e] of byId) nodes.set(id, { event: e, children: [] });
  const tree: TimelineNode[] = [];
  for (const node of nodes.values()) {
    const p = parentOf(node.event, byId, root.id);
    (p ? nodes.get(p)!.children : tree).push(node);
  }
  const byStart = (a: TimelineNode, b: TimelineNode) => a.event.startMs - b.event.startMs;
  tree.sort(byStart);
  walk(tree, (n) => n.children.sort(byStart));

  let end = endOf(root);
  for (const e of byId.values()) end = Math.max(end, endOf(e));

  const all = allEvents(tree);
  const failed =
    root.status === "error" ||
    all.some((e) => e.kind === "error" || (e.kind === "http_request" && (e.status === "error" || (e.http?.status ?? 0) >= 500))) ||
    // A 4xx that a refused query or outside call caused (Stripe said no, a UNIQUE index said no) is a break, not a validation answer.
    (all.some((e) => (e.kind === "db_query" || e.kind === "external_call") && e.status === "error") && all.some((e) => e.kind === "http_request" && (e.http?.status ?? 0) >= 400));

  const base = {
    id: root.id,
    traceId: root.traceId,
    trigger: root.trigger ?? "click",
    label: root.name,
    startMs: root.startMs,
    durationMs: Math.max(0, end - root.startMs),
    status: (failed ? "error" : "ok") as Status,
    complete,
    tree,
    root,
  };
  const flags = findFlags(base);
  if (!failed && flags.some((f) => f.kind === "slow" || f.kind === "slow_outside")) base.status = "slow";
  return { ...base, summary: summarize(base), flags };
}
