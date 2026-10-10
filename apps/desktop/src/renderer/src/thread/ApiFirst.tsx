import { useEffect, useState } from "react";
import type { ShrikeEvents } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { useSystem } from "../system/store.ts";

// AP-first: [Request Saved] and [Assertion Passed], the System's window the first time each happens in a project (main keeps it to once).

type First = ShrikeEvents["api:first"];
const SHOW_MS = 3200;
const COPY = {
  saved: { tag: "Request Saved", line: "Your first saved request in this project. Your flows replay it." },
  passed: { tag: "Assertion Passed", line: "Your first API check passed. It runs again with your flows." },
} as const;

export function ApiFirstLayer() {
  const [queue, setQueue] = useState<First[]>([]);
  const busy = useSystem((s) => !!s.current);
  const calm = useCalm();
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  const u = queue[0];
  useEffect(() => api().on("api:first", (p) => setQueue((q) => [...q, p as First])), []);
  useEffect(() => {
    if (!u || held || busy) return;
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), SHOW_MS);
    return () => clearTimeout(t);
  }, [u, held, busy]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => (setLeaving(false), setHeld(false), setQueue((q) => q.slice(1))), calm ? 0 : 220);
    return () => clearTimeout(t);
  }, [leaving, calm]);
  if (!u || busy || !COPY[u.kind]) return null;
  const c = COPY[u.kind];
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-[min(520px,100%)]">
        <SystemFrame calm={calm} leaving={leaving} label={`${c.tag}: ${u.name}`} pad="px-6 pt-3 pb-3.5" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onClick={() => setLeaving(true)}>
          <SystemTag>{c.tag}</SystemTag>
          <p className="mt-1 text-[15px] text-ink">{u.name}</p>
          <p className="mt-px text-[12.5px] text-dim">{c.line}</p>
        </SystemFrame>
      </div>
    </div>
  );
}
