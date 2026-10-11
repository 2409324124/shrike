import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { keys } from "../lib/platform.ts";

export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(" ");

export function Spinner({ size = 12, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cx("spin", className)} aria-hidden />;
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={keys(label)}
      title={keys(label)}
      className={cx("no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-dim transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx("inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-[3px] border border-hair px-1 font-mono text-[9.5px] leading-none text-dim", className)}>
      {typeof children === "string" ? keys(children) : children}
    </kbd>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="max-w-[340px] text-[13px] text-ink">{title}</p>
      {children && <div className="max-w-[380px] text-[12px] text-dim">{children}</div>}
    </div>
  );
}

const methodTone: Record<string, string> = { GET: "text-ok", POST: "text-signal", PUT: "text-slow", PATCH: "text-slow", DELETE: "text-fail" };

export function MethodTag({ method, className }: { method: string; className?: string }) {
  const m = method.toUpperCase();
  return <span className={cx("inline-block w-[44px] shrink-0 font-mono text-[10.5px] font-semibold", methodTone[m] ?? "text-dim", className)}>{m === "DELETE" ? "DEL" : m}</span>;
}

export function Tabs<const T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: NoInfer<T>; onChange(v: NoInfer<T>): void; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-0.5">
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={value === t.id} aria-pressed={value === t.id} onClick={() => onChange(t.id)} className="hud-btn">
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CodeBlock({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={cx("selectable overflow-auto rounded-[6px] border border-hair bg-black/30 p-2.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap break-all text-ink", className)}>
      {children}
    </pre>
  );
}

export function Pairs({ data }: { data?: Record<string, string> }) {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) return <p className="text-[12px] text-dim">None recorded.</p>;
  return (
    <dl className="selectable grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1 font-mono text-[11.5px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-dim">{k}</dt>
          <dd className="break-all text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("micro text-dim", className)}>{children}</span>;
}
