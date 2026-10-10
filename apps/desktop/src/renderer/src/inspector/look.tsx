import { useEffect, useRef, useState } from "react";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { Spinner } from "../components/ui.tsx";

type Of<K extends InspectResult["op"]> = Extract<InspectResult, { op: K }>;

/** One read-only look through main; keeps the last answer on screen while the next one loads. */
export function useLook<K extends InspectResult["op"]>(req: (InspectRequest & { op: InspectRequest["op"] }) | null, deps: unknown[]): { data?: Of<K>; error?: string; loading: boolean; again(): void } {
  const [state, setState] = useState<{ data?: Of<K>; error?: string; loading: boolean }>({ loading: !!req });
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!req) return setState({ loading: false });
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api()
      .inspect(req)
      .then(
        (data) => mine === seq.current && setState({ data: data as Of<K>, loading: false }),
        (e) => mine === seq.current && setState({ error: errorMessage(e), loading: false }),
      );
  }, [...deps, n]);
  return { ...state, again: () => setN((x) => x + 1) };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A calm line in the middle of the view: what's going on, or why there's nothing to show. */
export function Quiet({ text, sub, busy }: { text: string; sub?: string; busy?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="flex max-w-[320px] items-center gap-2 text-[13px] text-ink">
        {busy && <Spinner size={11} className="text-signal" />}
        {text}
      </p>
      {sub && <p className="lbl text-faint" style={{ textTransform: "none", letterSpacing: "0.04em" }}>{sub}</p>}
    </div>
  );
}

/** I7: a lane whose data can't be read says why in plain words. */
export function Problem({ text, again }: { text: string; again(): void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-[320px] text-[13px] text-ink">{text}</p>
      <button type="button" className="btn" onClick={again}>
        Look again
      </button>
    </div>
  );
}
