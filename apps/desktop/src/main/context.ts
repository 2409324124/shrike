import type { AgentRunInfo, AgentStep, ContextMap, ContextSegment, ShrikeEvents } from "@shrike/schema";

// X5: what fills the agent's context window, built from per-turn usage deltas.
// Each turn's new prompt tokens go to what was added since the last turn; splits inside one turn go by character share (estimated).

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;
type Seg = ContextSegment;
interface Item { kind: Seg["kind"]; label: string; chars: number; stepId?: string }
interface RunCtx { goal: string; memory: string; segs: Seg[]; prompt: number; outSince: number; pending: Item[]; limit?: number; started: boolean; earlier?: string; fromDelta: { seg: Seg; tokens: number }[] }

const INSTRUCTIONS = "Shrike's instructions and tools";
const prompt = (u: NonNullable<AgentStep["usage"]>) => u.input + u.cacheRead + u.cacheWrite;
const short = (p: string) => p.split(/[\\/]/).pop() || p;

function add(segs: Seg[], s: Seg): Seg | undefined {
  if (s.tokens <= 0) return undefined;
  const hit = segs.find((x) => x.kind === s.kind && x.label === s.label);
  if (!hit) return segs.push(s), s;
  hit.tokens += s.tokens;
  hit.estimated ||= s.estimated;
  return hit;
}

const TOOL_WORDS: Record<string, string> = {
  list_actions: "Recent activity",
  get_action: "What happened in the trip",
  get_event: "Event details",
  search_events: "Recording search results",
  get_logs: "Logs",
  compare_actions: "Before and after",
  app_snapshot: "The page",
  app_click: "The page after a click",
  app_type: "The page after typing",
  app_navigate: "The page it opened",
  run_scenario: "Re-run result",
  list_routes: "API routes",
  send_request: "API response",
  read_file: "Code",
  search_code: "Code search results",
  list_files: "File list",
  propose_patch: "Proposed fix",
  plan: "Plan",
  remember: "Memory notes",
  report_findings: "Findings",
};
const toolWords = (t: string | undefined) => (t ? (TOOL_WORDS[t] ?? `${t.replace(/^mcp__\w+?__/, "").replace(/_/g, " ")} results`) : "Tool results");

/** Splits `tokens` over items by character share; the last item takes the rounding remainder. */
function split(r: RunCtx, tokens: number, items: Item[]): void {
  const total = items.reduce((a, i) => a + i.chars, 0) || items.length;
  let left = tokens;
  items.forEach((it, i) => {
    const t = i === items.length - 1 ? left : Math.round((tokens * (it.chars || 1)) / total);
    left -= t;
    const seg = add(r.segs, { kind: it.kind, label: it.label, tokens: t, estimated: items.length > 1, ...(it.stepId ? { stepId: it.stepId } : {}) });
    if (seg) r.fromDelta.push({ seg, tokens: t });
  });
}

function resultItem(s: AgentStep): Item | undefined {
  if (s.kind !== "tool_result" && s.kind !== "patch") return undefined;
  const chars = (s.detail ?? s.text).length;
  if (s.tool === "load_skill") return { kind: "skill", label: /^Playbook: (.+)$/m.exec(s.detail ?? "")?.[1] ?? s.skill ?? "Playbook", chars, stepId: s.id };
  const read = s.tool === "read_file" ? s.files?.find((f) => f.action === "read") : undefined;
  if (read) return { kind: "file", label: short(read.path), chars, stepId: s.id };
  return { kind: "tool_result", label: toolWords(s.tool), chars, stepId: s.id };
}

export function createContextTracker() {
  const runs = new Map<string, RunCtx>();
  const ctx = (id: string) => {
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { goal: "", memory: "", segs: [], prompt: 0, outSince: 0, pending: [], started: false, fromDelta: [] }));
    return r;
  };
  let lastInstructions: number | undefined; // a fresh run's instructions, to size a continued run's
  const instructionsOf = (id: string | undefined) => runs.get(id ?? "")?.segs.find((x) => x.kind === "instructions" && x.label === INSTRUCTIONS)?.tokens;
  const map = (id: string, r: RunCtx): ContextMap => ({ runId: id, totalTokens: r.segs.reduce((a, s) => a + s.tokens, 0), ...(r.limit ? { limit: r.limit } : {}), segments: r.segs.map((s) => ({ ...s })) });

  return {
    noteRun(info: Pick<AgentRunInfo, "id" | "goal" | "continues" | "parentRunId">, memory = ""): void {
      const r = ctx(info.id);
      r.goal = info.goal;
      r.memory = memory;
      const earlier = info.continues ?? info.parentRunId; // a resumed or forked session: its first turn already holds the earlier conversation
      if (earlier) r.earlier = earlier;
    },
    noteLimit(runId: string, limit: number | undefined): void {
      if (limit) ctx(runId).limit = limit;
    },
    /** Returns the updated map when this step changed it. */
    noteStep(s: AgentStep): ContextMap | undefined {
      const r = ctx(s.runId);
      const item = resultItem(s);
      if (item) r.pending.push(item);
      const u = s.usage;
      if (!u) return undefined;
      const p = prompt(u);
      if (p > 0 && !r.started) {
        // First turn: the question and context chips, project memory, the rest is Shrike's (and the brain's) instructions and tools.
        r.started = true;
        const [question = "", ...rest] = r.goal.split("\n");
        const items: Item[] = [{ kind: "question", label: "Your question", chars: question.length, stepId: s.id }];
        if (rest.join("").trim()) items.push({ kind: "context", label: "Context and options", chars: rest.join("\n").length, stepId: s.id });
        if (r.memory.trim() && !r.earlier) items.push({ kind: "memory", label: "Project memory", chars: r.memory.length, stepId: s.id });
        // ponytail: char/4 for the known parts; the remainder is instructions. Upgrade with the brain's real system prompt size.
        let known = 0;
        for (const it of items) known += Math.ceil(it.chars / 4);
        const scale = known > p ? p / known : 1;
        for (const it of items) add(r.segs, { kind: it.kind, label: it.label, tokens: Math.floor((Math.ceil(it.chars / 4) || 0) * scale), estimated: true, stepId: s.id });
        const restTokens = p - r.segs.reduce((a, x) => a + x.tokens, 0);
        if (!r.earlier) {
          add(r.segs, { kind: "instructions", label: INSTRUCTIONS, tokens: restTokens, estimated: true, stepId: s.id });
          lastInstructions = restTokens;
        } else {
          // ponytail: instructions sized from the earlier run (or the last fresh one); the rest is the earlier conversation.
          const ins = Math.min(restTokens, instructionsOf(r.earlier) ?? lastInstructions ?? 0);
          add(r.segs, { kind: "instructions", label: ins ? INSTRUCTIONS : "Shrike's instructions and your earlier conversation", tokens: ins || restTokens, estimated: true, stepId: s.id });
          if (ins) add(r.segs, { kind: "context", label: "Earlier conversation", tokens: restTokens - ins, estimated: true, stepId: s.id });
        }
        r.prompt = p;
        r.pending = [];
      } else if (p > 0) {
        const delta = p - r.prompt - r.outSince;
        if (delta < 0) {
          // Compacted, or old thinking dropped: shrink what is there to fit.
          const have = r.segs.reduce((a, x) => a + x.tokens, 0);
          for (const x of r.segs) (x.tokens = Math.round((x.tokens * p) / (have || 1))), (x.estimated = true);
        } else if (delta > 0) {
          split(r, delta, r.pending.length ? r.pending : [{ kind: "context", label: "Other", chars: 1, stepId: s.id }]);
        }
        r.prompt = p;
        r.outSince = 0;
        r.pending = [];
      }
      if (u.output > 0 && p === 0 && (s.kind === "done" || s.kind === "error")) {
        // The result line's own-words total: what the per-line counts missed went to tool results by mistake; move it back.
        const had = r.fromDelta.reduce((a, d) => a + d.tokens, 0);
        const take = Math.min(u.output, had);
        let left = take;
        r.fromDelta.forEach((d, i) => {
          const t = Math.min(d.seg.tokens, i === r.fromDelta.length - 1 ? left : Math.round((take * d.tokens) / (had || 1)));
          left -= t;
          d.seg.tokens -= t;
          d.seg.estimated = true;
        });
        r.segs = r.segs.filter((x) => x.tokens > 0);
        r.fromDelta = [];
      }
      if (u.output > 0) {
        add(r.segs, { kind: "agent", label: "Its own words", tokens: u.output, estimated: false, stepId: s.id });
        r.outSince += u.output;
      }
      return map(s.runId, r);
    },
    get(runId: string): ContextMap | null {
      const r = runs.get(runId);
      return r?.started ? map(runId, r) : null;
    },
    forget(runId: string): void {
      runs.delete(runId);
    },
  };
}

const MAX_RUNS = 50;
const tracker = createContextTracker();
const order: string[] = [];
let send: Emit | undefined;
let memoryText: () => Promise<string> = async () => "";

/** Main wiring: ipc's emit calls observe for agent events; maps go out as "agent:context". */
export const xray = {
  connect(o: { emit: Emit; memory?: () => Promise<string> }): void {
    send = o.emit;
    if (o.memory) memoryText = o.memory;
  },
  observe<K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]): void {
    if (channel === "agent:status") {
      const info = payload as AgentRunInfo;
      if (info.status !== "running" || order.includes(info.id)) return;
      order.push(info.id);
      while (order.length > MAX_RUNS) tracker.forget(order.shift()!);
      tracker.noteRun(info);
      void memoryText().then((m) => tracker.noteRun(info, m), () => {});
    } else if (channel === "agent:usage") {
      const u = payload as ShrikeEvents["agent:usage"];
      tracker.noteLimit(u.runId, u.contextLimit);
    } else if (channel === "agent:step") {
      const m = tracker.noteStep(payload as AgentStep);
      if (m) send?.("agent:context", m);
    }
  },
  get: (runId: string) => tracker.get(runId),
};
