import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionView, DebugEvent } from "@shrike/schema";
import { useActions } from "../stores/actions.ts";
import { tripFor, useThread } from "../stores/thread.ts";
import { clockTime, errorText, isBackgroundAction } from "../lib/format.ts";
import { focusEvent } from "../hud/commands.ts";
import { cx, Empty, Tabs } from "./ui.tsx";

interface LogRow {
  event: DebugEvent;
  action: ActionView;
}

const MAX = 2000;
type Level = "all" | "error" | "warn";
const levelOf = (e: DebugEvent): "error" | "warn" | "info" | "debug" => (e.kind === "error" ? "error" : (e.log?.level ?? "info"));

function useLogRows(): LogRow[] {
  const byId = useActions((s) => s.byId);
  const order = useActions((s) => s.order);
  return useMemo(() => {
    const out: LogRow[] = [];
    for (const id of order) {
      const a = byId[id];
      if (!a) continue;
      const visit = (nodes: ActionView["tree"]) => {
        for (const n of nodes) {
          if (n.event.kind === "log" || n.event.kind === "error") out.push({ event: n.event, action: a });
          visit(n.children ?? []);
        }
      };
      visit(a.tree ?? []);
    }
    return out.sort((x, y) => x.event.startMs - y.event.startMs);
  }, [byId, order]);
}

export function LogsSheet() {
  const rows = useLogRows();
  const [level, setLevel] = useState<Level>("all");
  const [q, setQ] = useState("");
  const focus = useThread((s) => s.focus);
  const current = useMemo(() => new Set(focus.actionId ? (tripFor(focus.actionId)?.stations[focus.station]?.eventIds ?? []) : []), [focus, rows]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = rows.filter((r) => {
      const lv = levelOf(r.event);
      if (level === "error" && lv !== "error") return false;
      if (level === "warn" && lv !== "warn" && lv !== "error") return false;
      return !s || `${r.event.log?.message ?? ""} ${errorText(r.event) ?? ""} ${r.event.source?.file ?? ""}`.toLowerCase().includes(s);
    });
    // ponytail: newest MAX rows only; virtualise if logs get much bigger
    return list.length > MAX ? list.slice(-MAX) : list;
  }, [rows, level, q]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <Tabs label="Log level" value={level} onChange={setLevel} tabs={[{ id: "all", label: "All" }, { id: "warn", label: "Warnings" }, { id: "error", label: "Errors" }]} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter logs" className="field ml-auto h-6 w-[200px] text-[11.5px]" />
      </div>
      {rows.length === 0 ? (
        <Empty title="No logs yet.">Anything your app prints with console.log shows up here, next to the click that caused it.</Empty>
      ) : (
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="min-h-0 flex-1 overflow-auto px-1.5 pb-2"
          role="log"
        >
          {shown.map(({ event: e, action: a }) => {
            const lv = levelOf(e);
            const bg = isBackgroundAction(a);
            return (
              <div
                key={e.id}
                onClick={() => !bg && focusEvent(a.id, e.id)}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData("application/x-shrike-log", JSON.stringify({ actionId: a.id, eventId: e.id }));
                  ev.dataTransfer.setData("text/plain", e.log?.message ?? errorText(e) ?? e.name);
                  ev.dataTransfer.effectAllowed = "copy";
                }}
                className={cx("flex items-baseline gap-3 rounded-[6px] px-2 py-[3px] font-mono text-[11.5px] leading-[18px]", !bg && "cursor-pointer hover:bg-white/[0.04]", current.has(e.id) && "bg-signal/[0.07]")}
              >
                <span className="shrink-0 text-faint tabular-nums">{clockTime(e.startMs)}</span>
                <span className={cx("selectable min-w-0 flex-1 break-words whitespace-pre-wrap", lv === "error" ? "text-fail" : lv === "warn" ? "text-slow" : "text-ink/90")}>
                  {e.log?.message ?? errorText(e) ?? e.name}
                </span>
                {e.source && <span className="shrink-0 text-[10.5px] text-faint">{e.source.file.split("/").pop()}:{e.source.line}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
