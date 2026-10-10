import { useState, useSyncExternalStore } from "react";
import { cx } from "./ui.tsx";

// Activity (H14): steady state, never a loop. A filled dot is busy, a hollow one idle; time in plain text.

const subs = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(f: () => void): () => void {
  subs.add(f);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => ((now = Date.now()), subs.forEach((s) => s())), 1000);
  }
  return () => {
    subs.delete(f);
    if (!subs.size) (clearInterval(timer), (timer = undefined));
  };
}
const off = () => () => {};

/** One shared 1s clock; only ticks while something is listening. */
export function useNow(on = true): number {
  return useSyncExternalStore(on ? subscribe : off, () => now);
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return m < 60 ? `${m}:${ss}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${ss}`;
}

/** Time since `on` turned true, or since `since` (epoch ms). */
// ponytail: without `since` the clock starts at mount, so a remount restarts it; pass `since` once runs carry a start time.
export function Elapsed({ on = true, since, className }: { on?: boolean; since?: number; className?: string }) {
  const [s, setS] = useState(() => ({ on, start: Date.now() }));
  if (s.on !== on) setS({ on, start: Date.now() });
  useNow(on);
  if (!on) return null;
  return <span className={cx("font-mono text-[10.5px] text-faint tabular-nums", className)}>{clock(Date.now() - (since ?? s.start))}</span>;
}

export function Dot({ on, tone = "var(--violet)", size = 6, className }: { on: boolean; tone?: string; size?: number; className?: string }) {
  return (
    <i
      aria-hidden
      className={cx("inline-block shrink-0 rounded-full border transition-colors duration-200", className)}
      style={{ width: size, height: size, borderColor: on ? tone : "var(--ink-faint)", background: on ? tone : "transparent" }}
    />
  );
}

/** Dot, label and, while on, " · 0:42". */
export function Activity({ on, label, tone, since, timer: showTimer = true, className }: { on: boolean; label: string; tone?: string; since?: number; timer?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Dot on={on} tone={tone} />
      <span className="truncate">{label}</span>
      {on && showTimer && (
        <>
          <span aria-hidden className="text-faint">·</span>
          <Elapsed since={since} />
        </>
      )}
    </span>
  );
}
