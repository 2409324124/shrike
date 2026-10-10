import { memo, useMemo } from "react";
import { Eye } from "lucide-react";
import type { MemoryNote } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";
import type { PlacedStation } from "../lib/thread-layout.ts";
import { planRoute, useAgent, usePlan } from "../stores/agent.ts";
import { useThread } from "../stores/thread.ts";
import { readPaths, wasRead } from "../hud/xray.ts";

// Per-trip decorations owned by the agent surface, drawn in the trip block's own coordinates (same as stations):
// A1 planned route (dotted), A5 memory pins, A11 watched-by eye, O9 unread dot, X2 "looked here" outlines.
export const TripDecor = memo(function TripDecor({ actionId, stations }: { actionId: string; stations: PlacedStation[]; width: number }) {
  const plan = usePlan();
  const onTrip = useThread((s) => (s.probe ? s.probe.actionId === actionId : s.focus.actionId === actionId));
  const memory = useAgent((s) => s.memory);
  const watched = useAgent((s) => s.watched);
  const unread = useAgent((s) => s.unread[actionId]);
  const steps = useAgent((s) => s.steps);
  const runId = useAgent((s) => s.run?.id);

  const route = useMemo(() => (plan && onTrip ? planRoute(stations, plan).map((i) => stations[i]!).filter(Boolean) : []), [plan, onTrip, stations]);
  const pins = useMemo(() => {
    const out: { st: PlacedStation; notes: MemoryNote[] }[] = [];
    for (const st of stations) {
      const notes = memory.filter((n) => n.file && n.line && st.file && st.line === n.line && (st.file === n.file || st.file.endsWith(`/${n.file}`) || n.file.endsWith(`/${st.file}`)));
      if (notes.length) out.push({ st, notes });
    }
    return out;
  }, [memory, stations]);
  const looked = useMemo(() => {
    const read = readPaths(steps.filter((x) => x.runId === runId));
    return read.length ? stations.filter((st) => wasRead(read, st.file)) : [];
  }, [steps, runId, stations]);
  const clients = useMemo(() => Object.entries(watched).filter(([, ids]) => ids.includes(actionId)).map(([c]) => c), [watched, actionId]);

  if (!route.length && !pins.length && !clients.length && !unread && !looked.length) return null;
  const d = route.map((st, i) => `${i ? "L" : "M"}${st.x} ${st.y}`).join(" ");

  return (
    <div className="td" aria-hidden={!pins.length && !clients.length} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}>
      {looked.length > 0 && (
        <svg className="td-looked" style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width="1" height="1">
          {looked.map((st) => (
            <circle key={st.id} cx={st.x} cy={st.y} r="14" fill="none" stroke={color.violet} strokeWidth="1" opacity=".5" />
          ))}
        </svg>
      )}
      {route.length > 1 && (
        <svg className="td-route" style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width="1" height="1">
          <path d={d} fill="none" stroke={color.violet} strokeWidth="1.6" strokeDasharray="1.5 6" strokeLinecap="round" strokeLinejoin="round" opacity=".75" style={{ filter: `drop-shadow(0 0 3px ${color.violet})` }} />
          {route.map((st, i) => (
            <circle key={i} cx={st.x} cy={st.y} r="11" fill="none" stroke={color.violet} strokeWidth="1" strokeDasharray="2 3" opacity=".55" />
          ))}
        </svg>
      )}
      {pins.map(({ st, notes }) => (
        <span key={st.id} className="td-pin group" style={{ position: "absolute", left: st.x - 13, top: st.y - 22, pointerEvents: "auto" }}>
          <svg width="12" height="16" viewBox="0 0 12 16" aria-label={`Note: ${notes.map((n) => n.text).join("; ")}`} role="img">
            <path d="M6 15.5 C6 15.5 1 9.6 1 6 a5 5 0 0 1 10 0 C11 9.6 6 15.5 6 15.5Z" fill={color.violet} stroke={color.core} strokeOpacity=".6" strokeWidth=".8" style={{ filter: `drop-shadow(0 0 4px ${color.violet})` }} />
            <circle cx="6" cy="6" r="1.8" fill={color.core} />
          </svg>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-[18px] left-1/2 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md px-2 py-1 text-[11.5px] leading-snug text-ink group-hover:block"
            style={{ background: `color-mix(in srgb, ${color.abyss} 90%, ${color.violet})`, border: `1px solid color-mix(in srgb, ${color.violet} 55%, transparent)` }}
          >
            {notes.map((n) => (
              <span key={n.id} className="block">
                {n.text}
              </span>
            ))}
          </span>
        </span>
      ))}
      {clients.length > 0 && (
        <span className="td-watch lbl" title={`${clients.join(", ")} read this trip through Shrike's tools`} style={{ position: "absolute", top: 16, right: 48, display: "flex", alignItems: "center", gap: 5, color: color.violet, pointerEvents: "auto", fontSize: 10, textTransform: "none", letterSpacing: "0.04em" }}>
          <Eye size={11} style={{ position: "static" }} />
          {clients.join(", ")}
        </span>
      )}
      {unread && (
        <span
          className="td-unread"
          title={unread === "agent" ? "Your agent's result, not seen yet" : "New since you last looked"}
          style={{ position: "absolute", top: 21, left: 5, width: 7, height: 7, borderRadius: 99, background: unread === "agent" ? color.violet : color.cyan, boxShadow: `0 0 8px ${unread === "agent" ? color.violet : color.cyan}`, pointerEvents: "auto" }}
        />
      )}
    </div>
  );
});
