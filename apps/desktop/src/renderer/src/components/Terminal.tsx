import { useEffect, useMemo, useRef, useState } from "react";
import type { RunStatus } from "@shrike/schema";
import { useRun } from "../stores/run.ts";
import { useProject } from "../stores/project.ts";
import { parseAnsi } from "../lib/ansi.ts";
import { cx, Empty } from "./ui.tsx";

type ProcState = NonNullable<RunStatus["processes"]>[number]["state"] | "idle";
const DOT: Record<ProcState, string | undefined> = { running: "var(--ok)", starting: "var(--slow)", error: "var(--fail)", stopped: undefined, idle: undefined };

/** O4: one tab per process (from the run status, the project and what printed), plus All. */
function useTabs(): { name: string; state: ProcState }[] {
  const status = useRun((s) => s.status);
  const seen = useRun((s) => s.byProcess);
  const declared = useProject((s) => s.project?.processes);
  return useMemo(() => {
    const names = [...(status.processes ?? []).map((p) => p.name), ...(declared ?? []).map((p) => p.name), ...Object.keys(seen)];
    const uniq = [...new Set(names)];
    if (uniq.length < 2) return [];
    return uniq.map((name) => ({ name, state: status.processes?.find((p) => p.name === name)?.state ?? "idle" }));
  }, [status, seen, declared]);
}

export function TerminalSheet() {
  const all = useRun((s) => s.output);
  const byProcess = useRun((s) => s.byProcess);
  const clear = useRun((s) => s.clearOutput);
  const cmd = useProject((s) => s.project?.devCommand);
  const tabs = useTabs();
  const [tab, setTab] = useState<string>("all");
  const current = tab !== "all" && tabs.some((t) => t.name === tab) ? tab : "all";
  const output = current === "all" ? all : (byProcess[current] ?? "");
  const spans = useMemo(() => parseAnsi(output), [output]);
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [spans]);

  return (
    <div className="relative flex h-full flex-col">
      {tabs.length > 0 && (
        <div role="tablist" aria-label="Processes" className="flex h-8 shrink-0 items-center gap-0.5 px-3">
          {[{ name: "all", state: "idle" as ProcState }, ...tabs].map((t) => {
            const dot = DOT[t.state];
            return (
              <button key={t.name} role="tab" type="button" aria-selected={current === t.name} aria-pressed={current === t.name} onClick={() => setTab(t.name)} className="hud-btn">
                {t.name !== "all" && <i className={cx("size-[6px] rounded-full", !dot && "border border-faint")} style={dot ? { background: dot, boxShadow: `0 0 8px ${dot}` } : undefined} aria-label={t.state} />}
                {t.name === "all" ? "All" : t.name}
              </button>
            );
          })}
        </div>
      )}
      {!output ? (
        <Empty title="Nothing here yet.">
          {current === "all" ? (
            <>
              When you press Run, the output of <code className="font-mono text-ink">{cmd ?? "your dev command"}</code> shows up here.
            </>
          ) : (
            <>
              <code className="font-mono text-ink">{current}</code> hasn't printed anything.
            </>
          )}
        </Empty>
      ) : (
        <>
          <button type="button" className="hud-btn absolute top-0 right-3 z-[1]" onClick={clear}>
            Clear
          </button>
          <pre
            ref={ref}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="selectable min-h-0 flex-1 overflow-auto px-4 pb-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-words text-ink/90"
          >
            {spans.map((s, i) => (
              <span key={i} style={{ color: s.color, fontWeight: s.bold ? 600 : undefined, opacity: s.dim ? 0.55 : undefined }}>
                {s.text}
              </span>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}
