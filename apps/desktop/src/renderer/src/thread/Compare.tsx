import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActionView, Place } from "@shrike/schema";
import { compareLocalLive } from "@shrike/correlator/compare";
import { useActions } from "../stores/actions.ts";
import { useThread } from "../stores/thread.ts";
import { buildTrip, layoutTrip, tripLanes } from "../lib/thread-layout.ts";
import { TripView } from "./TripView.tsx";

const GAP = 12; // px between the panes (design-system space 3)
const PAD = 40; // the trip's title clears the lane header, as in the feed
const noop = () => {};

/** T23 (#62): the same click on local and on live, side by side, with the first differing request bracketed. */
export function Compare({ local, live, known }: { local: string; live: string; known: readonly Place[] }) {
  const a = useActions((s) => s.byId[local]);
  const b = useActions((s) => s.byId[live]);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const d = useMemo(() => (a && b ? compareLocalLive(a, b) : null), [a, b]);
  const pw = Math.max(0, Math.floor((width - GAP) / 2));

  return (
    <div className="th-stage th-split" aria-label="Local and live, side by side">
      <div className="th-split-head">
        <div>
          <p className="th-split-verdict" aria-live="polite">{d?.verdict ?? "One of these trips isn't in this session anymore."}</p>
          {d?.caption && <p className="th-split-cap">{d.caption}</p>}
          {d?.note && <p className="th-split-note">{d.note}</p>}
        </div>
        <button type="button" className="fv-btn" onClick={() => useThread.getState().setCompare(null)}>
          Close
        </button>
      </div>
      <div ref={ref} className="th-split-panes">
        {a && b && d && pw > 0 && (
          <>
            <Pane view={a} name="Local" diffId={d.localId} width={pw} known={known} />
            <Pane view={b} name="Live" diffId={d.liveId} width={pw} known={known} />
          </>
        )}
      </div>
    </div>
  );
}

function Pane({ view, name, diffId, width, known }: { view: ActionView; name: string; diffId?: string; width: number; known: readonly Place[] }) {
  const expanded = useThread((s) => s.expanded);
  const trip = useMemo(() => buildTrip(view, expanded, known), [view, expanded, known]);
  const lanes = useMemo(() => tripLanes(trip, width), [trip, width]);
  const g = useMemo(() => layoutTrip(trip, width, false, lanes), [trip, width, lanes]);
  const diff = diffId ? g.stations.findIndex((s) => s.eventIds.includes(diffId)) : -1;
  return (
    <section className="th-pane" aria-label={name} style={{ width }}>
      <b className={name === "Live" ? "live" : undefined}>{name}</b>
      <div className="th-pane-body">
        <div className="th-lanes" aria-hidden>
          {lanes.cols.map((c) => (
            <div key={c.key} className={`th-lane${c.mode === "sliver" ? " dim" : ""}`} style={{ left: c.x }} />
          ))}
        </div>
        <div className="th-lanehead" aria-hidden>
          {lanes.cols.map((c) => (
            <span key={c.key} className={c.mode === "sliver" ? "sliver" : "hot"} style={{ left: c.x }}>
              {c.head}
            </span>
          ))}
        </div>
        <div className="th-feed">
          <div style={{ height: PAD }} />
          <TripView view={view} trip={trip} g={g} width={width} focused station={-1} dived={false} pending={false} timeMode={false} play={null} probe={null} diff={diff >= 0 ? diff : undefined} onPlayed={noop} onStation={noop} />
          <div style={{ height: PAD }} />
        </div>
      </div>
    </section>
  );
}
