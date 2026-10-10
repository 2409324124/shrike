import { useEffect, useRef, useState } from "react";
import { ArrowRight, Play, Trash2, X } from "lucide-react";
import type { Flow, HttpRequestSpec } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import { cx, IconButton, Kbd, Spinner } from "../components/ui.tsx";
import { Dot, Elapsed } from "../components/Activity.tsx";
import { connectFlows, stepText, useFlows, watchWords } from "../stores/flows.ts";
import { useProject } from "../stores/project.ts";
import { toast, useUi } from "../stores/ui.ts";

// B2 flows shelf (W), B1 recording bar, B3 Keep watching, "Pick up where you left off", "Save as flow".
// Shell mounts FlowsShelf as the "flows" panel and FlowRecordingOverlay over the Thread; Welcome mounts PickUpCard.

const WATCH: { label: string; value: Flow["watch"] | null }[] = [
  { label: "Off", value: null },
  { label: "On every save", value: { mode: "save" } },
  { label: "Every 5 min", value: { mode: "interval", minutes: 5 } },
  { label: "Every 15 min", value: { mode: "interval", minutes: 15 } },
  { label: "Every hour", value: { mode: "interval", minutes: 60 } },
];

export function FlowsShelf({ open, onClose }: { open: boolean; onClose(): void }) {
  const flows = useUi((s) => s.flows);
  const hasPage = useProject((s) => !!s.project?.appUrl);
  useEffect(connectFlows, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <section aria-label="Flows" className="glass solid @container sheet-in absolute inset-x-2 bottom-0 z-30 flex h-[48%] min-h-[260px] flex-col rounded-t-[var(--r-card)] border-b-0 shadow-[0_-20px_60px_var(--void)]">
      <div className="flex h-10 shrink-0 items-center gap-2.5 pr-2 pl-4">
        <span className="lbl text-ink">Flows</span>
        <Kbd>W</Kbd>
        <div className="flex-1" />
        <span className="micro hidden text-[9.5px] whitespace-nowrap text-faint @sm:inline">Esc closes</span>
        <button type="button" className="hud-btn solid" onClick={() => void useFlows.getState().start()}>
          <span className="size-[7px] rounded-full bg-fail" aria-hidden />
          Record a flow
        </button>
        <IconButton label="Close flows" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {flows.length ? (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-2.5 p-0">
            {flows.map((f) => (
              <FlowCard key={f.id} f={f} />
            ))}
          </ul>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="m-0 text-[13px] text-ink">No flows yet.</p>
            <p className="m-0 max-w-[380px] text-[12px] text-dim">
              Press Record a flow, {hasPage ? "click through your app" : "send requests in the API explorer"}, then give it a name. Run replays it, and Keep watching re-runs it for you.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function FlowCard({ f }: { f: Flow }) {
  const running = useFlows((s) => !!s.running[f.id]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const shown = f.steps.filter((s) => s.type !== "navigate");
  const last = f.lastRun;
  const watchIndex = Math.max(0, WATCH.findIndex((w) => watchWords(w.value ?? undefined) === watchWords(f.watch)));

  return (
    <li data-flow={f.id} className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-hair bg-[color-mix(in_srgb,var(--void)_35%,transparent)] px-3 py-2.5 transition-colors hover:border-[var(--glass-edge)]">
      <div className="flex items-center gap-2">
        <span
          role="img"
          aria-label={!last ? "Not run yet" : last.ok ? "Worked last time" : "Broke last time"}
          title={!last ? "Not run yet" : `${last.ok ? "Worked" : "Broke"} ${relativeTime(last.at)}`}
          className={cx("size-[7px] shrink-0 rounded-full", !last ? "border border-hair-strong" : last.ok ? "bg-ok" : "bg-fail shadow-[0_0_8px_var(--fail)]")}
        />
        <b className="truncate text-[13.5px] font-medium text-ink">{f.name}</b>
        <span className="flex-1" />
        <span className="lbl shrink-0 text-[8.5px] text-faint">
          {shown.length} step{shown.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="m-0 truncate font-mono text-[11px] text-dim" title={f.steps.map(stepText).join("\n")}>
        {(shown.length ? shown : f.steps).slice(0, 3).map(stepText).join("  ›  ")}
      </p>
      <div className="mt-auto flex items-center gap-1.5 pt-1">
        <label className="flex min-w-0 items-center gap-1.5">
          <span className="lbl shrink-0 text-[8.5px] text-faint">Keep watching</span>
          <select
            aria-label={`Keep watching ${f.name}`}
            value={watchIndex}
            onChange={(e) => void useFlows.getState().watch(f.id, WATCH[Number(e.target.value)]?.value ?? null)}
            className={cx("field h-6 min-w-0 px-1 text-[10.5px]", f.watch && "text-signal")}
          >
            {WATCH.map((w, i) => (
              <option key={w.label} value={i}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <button type="button" className={cx("hud-btn", confirm && "text-fail")} aria-label={confirm ? `Really delete ${f.name}` : `Delete ${f.name}`} onClick={() => (confirm ? void useFlows.getState().remove(f.id) : setConfirm(true))}>
          <Trash2 size={10} />
          {confirm && "Delete?"}
        </button>
        <button type="button" className="hud-btn solid" disabled={running} onClick={() => void useFlows.getState().run(f)}>
          {running ? <Spinner size={10} /> : <Play size={10} />}
          {running ? "Running" : "Run"}
        </button>
      </div>
    </li>
  );
}

/** B1: while recording, one quiet bar over the Thread; Stop asks for a name. */
export function FlowRecordingOverlay() {
  const steps = useFlows((s) => s.recording);
  const naming = useFlows((s) => s.naming);
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(connectFlows, []);
  useEffect(() => {
    if (naming) input.current?.focus();
    else setName("");
  }, [naming]);
  if (!steps) return null;
  const last = steps.filter((s) => s.type !== "navigate").at(-1);
  const count = steps.filter((s) => s.type !== "navigate").length;

  return (
    <div className="pointer-events-none! absolute inset-x-0 top-3 z-40 flex justify-center">
      <div role="status" aria-label="Recording a flow" className="glass solid rise pointer-events-auto flex max-w-[620px] items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-[13px]">
        <Dot on tone="var(--fail)" size={8} />
        <Elapsed />
        {naming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void useFlows.getState().stop(name);
            }}
          >
            <input
              ref={input}
              aria-label="Name this flow"
              placeholder="Name this flow, e.g. Add a todo"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), useFlows.setState({ naming: false }))}
              className="field w-[240px]"
            />
            <button type="submit" className="btn go" disabled={!name.trim()}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => void useFlows.getState().stop("")}>
              Discard
            </button>
          </form>
        ) : (
          <>
            <span className="lbl shrink-0 text-ink">Recording a flow</span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-dim">{last ? stepText(last) : "Click through your app, or send a request in the API explorer"}</span>
            <span className="lbl shrink-0 text-faint">
              {count} step{count === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn" onClick={() => useFlows.setState({ naming: true })}>
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ago(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Welcome: "Pick up where you left off: <project> · <n> trips · <time ago>". */
export function PickUpCard() {
  const [last, setLast] = useState<{ project: string; actionIds: string[]; at: number } | null>(null);
  const opening = useProject((s) => s.opening);
  useEffect(connectFlows, []);
  useEffect(() => {
    void call((a) => a.lastSession(), "Couldn't read your last session").then((s) => setLast(s ?? null));
  }, []);
  if (!last) return null;
  const name = last.project.split(/[\\/]/).filter(Boolean).pop() ?? last.project;
  const n = last.actionIds.length;
  return (
    <button type="button" disabled={opening} onClick={() => void useProject.getState().openRoot(last.project)} className="btn h-auto w-full justify-between px-4 py-2.5 normal-case tracking-normal">
      <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
        <span className="lbl text-[9.5px] text-signal">Pick up where you left off</span>
        <span className="truncate font-sans text-[13.5px] text-ink">
          {name} <span className="text-dim">· {n} trip{n === 1 ? "" : "s"} · {ago(last.at)}</span>
        </span>
      </span>
      {opening ? <Spinner size={13} /> : <ArrowRight size={14} className="shrink-0 text-dim" />}
    </button>
  );
}

/** API explorer: keep this request as a flow (a "request" flow replays it). The explorer's owner mounts it next to Send. */
export function SaveAsFlow({ request }: { request: HttpRequestSpec }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (!naming) {
    return (
      <button type="button" className="hud-btn" disabled={!request.url.trim()} onClick={() => (setName(`${request.method.toUpperCase()} ${request.url}`.slice(0, 80)), setNaming(true))}>
        Save as flow
      </button>
    );
  }
  const save = async () => {
    const f = await call((a) => a.saveFlow(name, [{ type: "request", request }]), "Couldn't save the flow");
    if (f) toast(`Saved "${f.name}". Press W to run it.`, "ok");
    setNaming(false);
  };
  return (
    <form className="flex items-center gap-1.5" onSubmit={(e) => (e.preventDefault(), name.trim() && void save())}>
      <input aria-label="Flow name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNaming(false))} className="field h-6 w-[180px] text-[11px]" />
      <button type="submit" className="hud-btn solid" disabled={!name.trim()}>
        Save
      </button>
    </form>
  );
}
