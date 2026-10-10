import { useEffect, useMemo, useRef } from "react";
import type { ActionView, Place } from "@shrike/schema";
import { Send } from "lucide-react";
import { cx, MethodTag } from "../components/ui.tsx";
import { openRoute } from "../api/store.ts"; // AP2
import { allEvents, basename } from "../lib/format.ts";
import { useProject } from "../stores/project.ts";
import { useRun } from "../stores/run.ts";
import { outputLines, processFor, routesFor } from "./logic.ts";
import { Quiet } from "./look.tsx";

const STATE_WORD = { starting: "Starting", running: "Running", stopped: "Stopped", error: "Stopped with an error" } as const;

/** I5: that process's output (its terminal tab), its routes (AP2: a click sends one), status and port; this click's lines lit. */
export function ServiceView({ place, view }: { place: Place; view?: ActionView }) {
  const project = useProject((s) => s.project);
  const status = useRun((s) => s.status);
  const processes = project?.processes ?? [];
  const name = processFor(place.id, processes);
  const proc = status.processes?.find((p) => p.name === name);
  const output = useRun((s) => (name ? s.byProcess[name] : undefined) ?? (processes.length <= 1 ? s.output : ""));
  const messages = useMemo(
    () => (view ? allEvents(view).filter((e) => e.place?.id === place.id && (e.kind === "log" || e.error)).map((e) => e.log?.message ?? e.error!.message) : []),
    [view, place.id],
  );
  const lines = useMemo(() => outputLines(output, messages), [output, messages]);
  const routes = routesFor(project?.routes ?? [], name, processes.length);
  const box = useRef<HTMLDivElement>(null);
  const firstHit = lines.findIndex((l) => l.hit);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const hit = el.querySelector<HTMLElement>("div.hit");
    if (hit) hit.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
  }, [firstHit, lines.length]);

  const state = proc?.state ?? (status.state === "running" ? "running" : status.state === "starting" ? "starting" : status.state === "error" ? "error" : "stopped");
  const where = proc?.url ?? place.detail;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="insp-bar">
        <i className={`insp-dot ${state}`} aria-hidden />
        <span className="text-[12px] text-ink">{STATE_WORD[state]}</span>
        {where && <span className="font-mono text-[11px] text-dim">{where.replace(/^https?:\/\//, "")}</span>}
        {name && <span className="lbl ml-auto text-faint">process {name}</span>}
      </div>
      {proc?.error && <p className="px-2.5 pt-2 text-[12px] text-fail">{proc.error}</p>}
      {routes.length > 0 && (
        <details open className="border-b border-hair px-2.5 py-1.5">
          <summary className="lbl cursor-pointer py-1">
            {routes.length} routes <span className="normal-case tracking-normal text-faint">· click one to send it</span>
          </summary>
          <ul className="max-h-[40vh] overflow-auto pb-1">
            {routes.map((r) => (
              <li key={`${r.method} ${r.path}`}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-2 rounded-[5px] px-1 py-0.5 text-left font-mono text-[11px] text-dim hover:bg-white/[0.04]"
                  title={`Send ${r.method.toUpperCase()} ${r.path} from the API client`}
                  onClick={() => openRoute(r)}
                >
                  <MethodTag method={r.method} />
                  <span className="truncate text-ink">{r.path}</span>
                  {r.handler && <span className="ml-auto shrink-0 text-faint">{basename(r.handler.file)}:{r.handler.line}</span>}
                  <Send size={11} className={cx("shrink-0 text-signal opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100", !r.handler && "ml-auto")} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {lines.length ? (
        <div ref={box} className="insp-out min-h-0 flex-1 overflow-auto px-2.5 py-2" aria-label={`Output of ${name ?? place.name}`}>
          {lines.map((l, i) => (
            <div key={i} className={l.hit ? "hit" : undefined}>
              {l.text || " "}
            </div>
          ))}
        </div>
      ) : (
        <Quiet text={name ? `The ${name} process hasn't printed anything yet.` : "Shrike doesn't know which process this is."} />
      )}
    </div>
  );
}
