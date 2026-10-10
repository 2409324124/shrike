import "./inspector.css";
import { useEffect, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "../components/ui.tsx";
import { isTyping } from "../hud/commands.ts";
import { useActions } from "../stores/actions.ts";
import { tripFor, tripOrder, useThread } from "../stores/thread.ts";
import { CacheView } from "./CacheView.tsx";
import { DataView } from "./DataView.tsx";
import { titleParts } from "./logic.ts";
import { Quiet } from "./look.tsx";
import { OutsideView } from "./OutsideView.tsx";
import { ServiceView } from "./ServiceView.tsx";
import { useInspector } from "./store.ts";

// I1-I7 place inspector: the left dock shows inside a lane instead of the app. Spec: docs/13-skills-worktrees-sdlc.md "I".

const useLane = () => useInspector((s) => (s.placeId ? s.lanes.find((l) => l.id === s.placeId) : undefined));

/** I1: "YOUR APP", or the lane's name with a way back. */
export function DockTitle() {
  const lane = useLane();
  if (!lane) return <span className="lbl shrink-0">Your app</span>;
  const t = titleParts(lane.name);
  return (
    <>
      <IconButton label="Back to your app (0)" className="-ml-1 size-5 text-ink" onClick={() => useInspector.getState().open(null)}>
        <ArrowLeft size={12} />
      </IconButton>
      <span className="lbl shrink-0 text-ink">{t.head}</span>
      {t.sub && (
        <span className="lbl min-w-0 truncate" style={{ textTransform: "none", letterSpacing: "0.06em" }}>
          · {t.sub}
        </span>
      )}
    </>
  );
}

/** Covers the app while a lane is open; the app's webview stays mounted underneath, so it keeps running and recording. */
export function InspectorPanel() {
  const lane = useLane();
  const focusId = useThread((s) => s.focus.actionId);
  const station = useThread((s) => s.focus.station);
  const byId = useActions((s) => s.byId);
  const tick = useActions((s) => Object.values(s.byId).filter((a) => a.complete).length); // refresh when a trip completes
  const actionId = focusId ?? tripOrder().at(-1);
  const view = actionId ? byId[actionId] : undefined;
  const stationIds = useMemo(() => (actionId ? (tripFor(actionId)?.stations[station]?.eventIds ?? []) : []), [actionId, station, view]);
  if (!lane) return null;
  const place = { id: lane.id, kind: lane.kind, name: lane.name };
  return (
    <div className="insp absolute inset-0 z-20 flex flex-col bg-void" role="region" aria-label={`Inside ${lane.name}`}>
      {lane.kind === "data" ? (
        <DataView key={lane.id} placeId={lane.id} view={view} stationIds={stationIds} tick={tick} />
      ) : lane.kind === "cache" ? (
        <CacheView key={lane.id} placeId={lane.id} view={view} tick={tick} />
      ) : lane.kind === "service" ? (
        <ServiceView key={lane.id} place={place} view={view} />
      ) : lane.kind === "outside" ? (
        <OutsideView key={lane.id} place={{ ...place, detail: lane.detail }} actionId={actionId} />
      ) : (
        <Quiet text="Shrike can't look inside this lane yet." />
      )}
    </div>
  );
}

/** I1 keys: 1-9 open the lanes in header order, 0 returns to your app. Never while typing. */
export function useInspectorKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || !/^[0-9]$/.test(e.key) || isTyping(e.target)) return;
      const ins = useInspector.getState();
      const lane = ins.lanes[Number(e.key) - 1];
      if (e.key !== "0" && !lane) return;
      e.preventDefault();
      ins.open(e.key === "0" ? null : lane!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
