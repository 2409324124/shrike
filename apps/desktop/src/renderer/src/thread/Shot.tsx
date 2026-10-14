import { useEffect, useState } from "react";
import type { ActionView } from "@shrike/schema";
import type { Trip, TripCaller } from "../lib/thread-layout.ts";

// T10 screen shots in the SCREEN lane: BEFORE is the real capture with a reticle on what was clicked; AFTER is words.
// T20: a trip that didn't start in a browser shows who started it (the command, or "cron · nightly") instead.

export const SHOT_W = 120;
const MAX_H = 78;
const shots = new Map<string, Promise<string | null>>();
const shotFor = (id: string) => {
  let p = shots.get(id);
  if (!p) {
    p = window.shrike.getActionShot(id).catch(() => null);
    shots.set(id, p);
  }
  return p;
};

export function BeforeShot({ view, x, y }: { view: ActionView; x: number; y: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let live = true;
    void shotFor(view.id).then((s) => live && setSrc(s));
    return () => { live = false; };
  }, [view.id]);

  const t = view.root.target;
  let body = (
    <div className="txt">
      <b>{view.label}</b>
    </div>
  );
  if (src && size) {
    const vw = t?.viewportWidth ?? size.w;
    const k = SHOT_W / vw;
    const imgH = (t?.viewportHeight ?? size.h * (vw / size.w)) * k;
    const h = Math.min(MAX_H, imgH);
    const cy = t ? (t.y + t.height / 2) * k : 0;
    const off = Math.max(0, Math.min(imgH - h, cy - h / 2));
    body = (
      <div className="crop" style={{ height: h }}>
        <img src={src} alt="" style={{ top: -off }} />
        {t && <i className="th-ret-mark" style={{ left: t.x * k - 3, top: t.y * k - off - 3, width: t.width * k + 6, height: t.height * k + 6 }} />}
      </div>
    );
  }
  return (
    <div className="th-shot" style={{ left: x, top: y }}>
      <span className="tag">BEFORE</span>
      {src && !size && <img src={src} alt="" hidden onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />}
      {body}
    </div>
  );
}

// ponytail: a true after-shot needs a second capture when the trip completes; for now it says what came back.
export function AfterShot({ trip, x, y }: { trip: Trip; x: number; y: number }) {
  const bad = trip.status === "error";
  return (
    <div className="th-shot th-after" style={{ left: x, top: y }}>
      <span className="tag">AFTER</span>
      <div className="txt">
        <b className={bad ? "e" : "ok"}>{trip.returned}</b>
        <span className={`v${trip.shape === "came_back_empty" ? " warn" : ""}`}>{trip.verdict}</span>
      </div>
    </div>
  );
}

export function TerminalCard({ caller, x, y }: { caller: TripCaller; x: number; y: number }) {
  return (
    <div className="th-shot th-term" style={{ left: x, top: y }} title={caller.text}>
      <span className="tag">{caller.place.name}</span>
      <div className="txt">{caller.text}</div>
    </div>
  );
}
