import type { AgentStep, Finding } from "@shrike/schema";

export type StepInput = Omit<AgentStep, "id" | "runId" | "createdAt">;

const PREFIX = "mcp__shrike__";

export function toolName(name: string) {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

export function toolUseStep(rawName: string, input: unknown): StepInput {
  const tool = toolName(rawName);
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "report_findings") {
    const summary = typeof args.summary === "string" ? args.summary : "";
    const findings = Array.isArray(args.findings) ? (args.findings as Finding[]) : [];
    return { kind: "findings", tool, text: summary || "Found it", findings, summary, detail: JSON.stringify(input) };
  }
  // Plan, playbook and memory calls are narration, not probing: "message" steps so the probe doesn't advance.
  if (tool === "plan") {
    const plan = Array.isArray(args.checks) ? args.checks.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim()) : [];
    return { kind: "message", tool, text: plan.length ? `My plan: ${plan.join(", then ")}` : "Making a plan", plan, detail: JSON.stringify(input) };
  }
  if (tool === "load_skill") {
    const id = typeof args.skill === "string" ? args.skill.trim().toLowerCase() : "";
    return { kind: "message", tool, text: `Using the ${id.replace(/-/g, " ") || "matching"} playbook`, ...(id ? { skill: id } : {}), detail: JSON.stringify(input) };
  }
  if (tool === "remember") {
    return { kind: "message", tool, text: `Noting for next time: ${typeof args.text === "string" ? args.text : "a fact about this project"}`, detail: JSON.stringify(input) };
  }
  if (tool === "ask_options") { // M1: narration, and the mockups stay out of the step (the cards hold them)
    const opts = Array.isArray(args.options) ? (args.options as Record<string, unknown>[]) : [];
    const lean = { ...args, options: opts.map(({ mockupHtml, preview, ...o }) => ({ ...o, ...(mockupHtml ? { mockupHtml: "[mockup]" } : {}), ...(preview ? { preview: "[preview]" } : {}) })) };
    const q = typeof args.question === "string" && args.question.trim() ? `: ${args.question.trim()}` : "";
    return { kind: "message", tool, text: opts.length ? `Showing you ${opts.length} option${opts.length === 1 ? "" : "s"}${q}` : "Waiting for your pick", detail: JSON.stringify(lean) };
  }
  if (tool === "propose_skill_update") { // S4 (skills engineer)
    return { kind: "message", tool, text: `Suggesting a better playbook: ${typeof args.reason === "string" ? args.reason : "something it learned"}`, detail: JSON.stringify(input) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool); // MCP5: one of the user's own servers
  if (mcp) return { kind: "tool_call", tool, text: `Using ${mcp[1]}: ${mcp[2]!.replace(/[_-]+/g, " ")}`, activity: `Using ${mcp[1]}: ${mcp[2]!.replace(/[_-]+/g, " ")}`, detail: JSON.stringify(input) };
  const files = tool === "propose_patch" && Array.isArray(args.files) ? patchFiles(args.files) : undefined;
  return { kind: "tool_call", tool, text: friendly(tool, args), activity: activity(tool, args), ...(files?.length ? { files } : {}), detail: JSON.stringify(input) };
}

type FileTouch = NonNullable<AgentStep["files"]>[number];
const base = (p: unknown) => String(p ?? "").split("/").pop() || String(p ?? "");

function patchFiles(list: unknown[]): FileTouch[] {
  const paths = list.map((f) => (f && typeof f === "object" ? (f as { path?: unknown }).path : undefined)).filter((p): p is string => typeof p === "string" && !!p);
  return [...new Set(paths)].map((path) => ({ path, action: "edit" }));
}

/** X1: the live action in plain words with its target. */
function activity(tool: string, a: Record<string, unknown>): string {
  const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 60) : "an element";
  switch (tool) {
    case "read_file": {
      const s = Number(a.startLine) || 0;
      const e = Number(a.endLine) || 0;
      return `Reading ${base(a.path)}${s && e ? ` lines ${s}-${e}` : s ? ` from line ${s}` : e ? ` lines 1-${e}` : ""}`;
    }
    case "search_code": return `Searching for ${String(a.query ?? "").slice(0, 60)}`;
    case "search_events": return `Searching the recording for ${String(a.query ?? "").slice(0, 60)}`;
    case "app_click": return `Clicking ${name}`;
    case "app_type": return `Typing into ${name}`;
    case "propose_patch": {
      const files = Array.isArray(a.files) ? patchFiles(a.files) : [];
      const more = files.length > 1 ? ` and ${files.length - 1} other file${files.length > 2 ? "s" : ""}` : "";
      return files.length ? `Proposing a change to ${base(files[0]!.path)}${more}` : "Proposing a change";
    }
    default: return friendly(tool, a);
  }
}

/** X2: files a tool result shows the agent looked at. */
function resultFiles(tool: string | undefined, text: string): FileTouch[] {
  if (tool === "read_file") {
    const m = /^(.+?) lines (\d+)-(\d+)\s*$/.exec(text.split("\n")[0] ?? "");
    return m ? [{ path: m[1]!, action: "read", lines: [Number(m[2]), Number(m[3])] }] : [];
  }
  if (tool !== "search_code") return [];
  const hits = new Map<string, [number, number]>();
  for (const m of text.matchAll(/^([^\s:][^:\n]*):(\d+): /gm)) {
    const n = Number(m[2]);
    const r = hits.get(m[1]!);
    hits.set(m[1]!, r ? [Math.min(r[0], n), Math.max(r[1], n)] : [n, n]);
  }
  return [...hits].map(([path, lines]) => ({ path, action: "search", lines }));
}

export type TurnUsage = NonNullable<AgentStep["usage"]>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** X6: one assistant message's usage from stream-json (Anthropic usage fields). */
export function turnUsage(u: Record<string, unknown> | undefined): TurnUsage {
  return { input: num(u?.input_tokens), output: num(u?.output_tokens), cacheRead: num(u?.cache_read_input_tokens), cacheWrite: num(u?.cache_creation_input_tokens) };
}

/** What a repeated line of the same message adds, so per-step usage sums to the run's total. Undefined when nothing new. */
export function usageDelta(prev: TurnUsage | undefined, next: TurnUsage): TurnUsage | undefined {
  const d = (k: "input" | "output" | "cacheRead" | "cacheWrite") => Math.max(0, next[k] - (prev?.[k] ?? 0));
  const out = { input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheWrite: d("cacheWrite") };
  return out.input || out.output || out.cacheRead || out.cacheWrite ? out : undefined;
}

export const addUsage = (a: TurnUsage | undefined, b: TurnUsage): TurnUsage => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
  ...(a?.costUsd != null || b.costUsd != null ? { costUsd: (a?.costUsd ?? 0) + (b.costUsd ?? 0) } : {}),
});

const MAX_THINKING = 1200;
/** X3: the latest reasoning, trimmed (keeps the end: it's the freshest thought). */
export function thinkingText(t: unknown): string | undefined {
  const s = typeof t === "string" ? t.trim().replace(/\n{3,}/g, "\n\n") : "";
  if (!s) return undefined;
  return s.length > MAX_THINKING ? `…${s.slice(-(MAX_THINKING - 1))}` : s;
}

export function toolResultStep(rawName: string | undefined, text: string, isError: boolean): StepInput {
  const tool = rawName ? toolName(rawName) : undefined;
  const actionIds = [...new Set([...text.matchAll(/\bAction ([0-9a-f]{16})\b/g)].map((m) => m[1]!))];
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const line = first.length > 140 ? `${first.slice(0, 139)}…` : first;
  if (tool === "propose_patch" && !isError) {
    const m = /Patch (\S+) (applied|rejected)/.exec(text);
    if (m) return { kind: "patch", tool, text: m[2] === "applied" ? "Fix applied" : "Fix rejected", patchId: m[1], detail: text };
  }
  const files = isError ? [] : resultFiles(tool, text);
  return {
    kind: "tool_result",
    tool,
    ...(files.length ? { files } : {}),
    text: isError ? `Problem: ${line || "the tool failed"}` : (tool && friendlyResult(tool, text)) || line || "Done",
    detail: text,
    ...(actionIds.length ? { actionIds } : {}),
  };
}

function quote(v: unknown, max = 40) {
  const s = String(v);
  return `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
}

function friendly(tool: string, a: Record<string, unknown>): string {
  const target = a.name ? quote(a.name) : "an element"; // never the raw snapshot ref ("e2")
  switch (tool) {
    case "list_actions": return "Looking at recent activity";
    case "get_action": return "Reading what happened";
    case "get_event": return "Looking at the details";
    case "search_events": return `Searching the recording for ${quote(a.query)}`;
    case "get_logs": return "Reading the logs";
    case "compare_actions": return "Comparing before and after";
    case "app_snapshot": return "Looking at the page";
    case "app_click": return `Clicking ${target}`;
    case "app_type": return `Typing ${quote(a.text ?? "")} into ${target}`;
    case "app_navigate": return `Opening ${a.url}`;
    case "run_scenario": return "Re-running the steps to check";
    case "list_routes": return "Listing the API routes";
    case "send_request": return `Sending ${String(a.method ?? "GET").toUpperCase()} ${a.url}`;
    case "read_file": return `Reading ${a.path}`;
    case "search_code": return `Searching the code for ${quote(a.query)}`;
    case "list_files": return "Listing the project's files";
    case "propose_patch": return "Proposing a fix";
    default: return `Using ${tool}`;
  }
}

// Tool output is written for the model; the panel shows a plain one-line outcome (the full text stays in detail).
function friendlyResult(tool: string, text: string): string | undefined {
  const head = /^Action [0-9a-f]{16} · (.+?) · (ok|slow|error)\b/m.exec(text);
  const outcome = head ? `${head[1]}: ${head[2] === "error" ? "something went wrong" : head[2] === "slow" ? "worked, but slowly" : "worked"}` : undefined;
  const n = (re: RegExp) => text.match(re)?.length ?? 0;
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : word.endsWith("h") ? "es" : "s"}`;
  switch (tool) {
    case "run_scenario": return /Result: PASS/.test(text) ? "It worked. No errors this time." : "It still fails.";
    case "compare_actions": {
      const v = /^Verdict: (.+)$/m.exec(text)?.[1];
      return v ? `Before and after: ${v}` : undefined;
    }
    case "list_actions": return /^Action /m.test(text) ? `Found ${plural(n(/^Action /gm), "recording")}` : "Nothing recorded yet";
    case "get_action": return outcome;
    case "app_click": return outcome ?? "Clicked it, but nothing happened";
    case "app_type": return outcome ?? "Typed it in";
    case "app_navigate": return outcome ?? "Opened the page";
    case "send_request": {
      const code = Number(/^HTTP (\d{3})/.exec(text)?.[1]);
      return code ? `The server answered: ${code >= 500 ? "server error" : code >= 400 ? "refused" : "OK"} (${code})` : undefined;
    }
    case "app_snapshot": return "Saw the page";
    case "get_event": return "Read the details";
    case "read_file": {
      const m = /^(.+?) lines (\d+)-(\d+)\s*$/.exec(text.split("\n")[0] ?? "");
      return m ? `Read ${base(m[1])} lines ${m[2]} to ${m[3]}` : undefined;
    }
    case "search_code":
    case "search_events": return /^No (matches|events match)/.test(text) ? "No matches" : `Found ${plural(n(/^.+$/gm), "match")}`;
    case "get_logs": return /^No logs/.test(text) ? "No logs" : `Read ${plural(n(/^\[/gm), "log line")}`;
    case "list_routes": return `Found ${plural(n(/^[A-Z]+ \//gm), "route")}`;
    case "list_files": return "Listed the files";
    case "report_findings": return "Shared what I found";
    case "ask_options": {
      let r: { action?: string; option?: string; options?: string[] } = {};
      try {
        r = JSON.parse(text.split("\n")[0] ?? "") as typeof r;
      } catch {} // an error text
      const cards = r.options?.join(" + ") ?? r.option ?? "";
      return r.action === "approve" ? `You approved ${cards}` : r.action === "vary" ? `You asked for more like ${cards}` : r.action === "tweak" ? `You asked to change ${cards}` : r.action === "combine" ? `You asked to combine ${cards}` : r.action === "other" ? "You answered in your own words" : "Still waiting for your pick";
    }
    default: return undefined;
  }
}
