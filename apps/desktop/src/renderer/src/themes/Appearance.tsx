import { useEffect } from "react";
import { Check, X } from "lucide-react";
import { palette, THEME_IDS, themes, type ThemeId } from "@shrike/design";
import { cx, IconButton } from "../components/ui.tsx";
import { useTheme } from "./store.ts";

// Z7: Appearance. Each card draws a tiny Thread in its own theme's tokens, so you see the look before you pick it.

/** One trip through three lanes, a broken step and the Ask pill, in theme `id`'s colours. */
export function MiniThread({ id }: { id: ThemeId }) {
  const { color: c, code: k } = palette(id);
  const glow = themes[id].glow;
  const lanes = [34, 96, 158];
  const g = `mt-${id}`;
  return (
    <svg viewBox="0 0 200 116" className="block h-auto w-full" aria-hidden>
      <defs>
        <radialGradient id={`${g}-bg`} cx="55%" cy="30%" r="80%">
          <stop offset="0" stopColor={c.navy} />
          <stop offset="0.75" stopColor={c.void} />
        </radialGradient>
        <linearGradient id={`${g}-sp`} x1="0" x2="1">
          <stop offset="0" stopColor={c.violet} />
          <stop offset=".5" stopColor={c.blue} />
          <stop offset="1" stopColor={c.cyan} />
        </linearGradient>
        <filter id={`${g}-gl`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={glow ? 2.2 : 0} />
        </filter>
      </defs>
      <rect width="200" height="116" fill={`url(#${g}-bg)`} />
      {lanes.map((x, i) => (
        <g key={x}>
          <line x1={x} x2={x} y1="16" y2="92" stroke={c.hair} />
          <text x={x} y="11" textAnchor="middle" fontSize="5.5" letterSpacing=".9" fontFamily="JetBrains Mono, monospace" fill={c.inkDim}>
            {["SCREEN", "SERVER", "DATABASE"][i]}
          </text>
        </g>
      ))}
      {glow && <path d="M34 24 H96 V40 H158 V54 H96 V64 H34" fill="none" stroke={c.cyan} strokeWidth="3" opacity=".45" filter={`url(#${g}-gl)`} />}
      <path d="M34 24 H96 V40 H158 V54 H96 V64 H34" fill="none" stroke={`url(#${g}-sp)`} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="34" cy="24" r="3" fill={c.ok} />
      <circle cx="96" cy="40" r="3" fill={c.ok} />
      {glow && <circle cx="158" cy="54" r="6" fill={c.fail} opacity=".5" filter={`url(#${g}-gl)`} />}
      <circle cx="158" cy="54" r="3.4" fill={c.fail} stroke={c.core} strokeWidth=".8" />
      <circle cx="34" cy="64" r="2.4" fill={c.core} />
      <rect x="112" y="64" width="80" height="16" rx="3" fill={k.bg} stroke={c.hair} />
      <text x="116" y="74.5" fontSize="5.6" fontFamily="JetBrains Mono, monospace">
        <tspan fill={k.keyword}>const</tspan>
        <tspan fill={k.fg}> id </tspan>
        <tspan fill={k.punct}>=</tspan>
        <tspan fill={k.fn}> body</tspan>
        <tspan fill={k.punct}>.</tspan>
        <tspan fill={k.prop}>user</tspan>
      </text>
      <text x="10" y="84" fontSize="7.4" fontWeight="500" fontFamily="Space Grotesk, sans-serif" fill={c.ink}>
        Line 18 saved no user
      </text>
      <rect x="10" y="94" width="180" height="14" rx="7" fill={c.abyss} stroke={c.violet} strokeOpacity=".7" />
      <text x="18" y="103.5" fontSize="6" fontFamily="Space Grotesk, sans-serif" fill={c.inkDim}>
        <tspan fill={c.violet}>✦ </tspan>Ask Claude anything about your app
      </text>
    </svg>
  );
}

function Card({ id, on, onPick }: { id: ThemeId; on: boolean; onPick(): void }) {
  const t = themes[id];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={`${t.label} theme`}
      onClick={onPick}
      className={cx("group flex flex-col overflow-hidden rounded-[var(--r-card)] border text-left transition-[border-color,box-shadow] duration-150", on ? "border-signal" : "border-hair hover:border-hair-strong")}
      style={on ? { boxShadow: "0 0 0 1px var(--signal), 0 0 18px color-mix(in srgb, var(--signal) 30%, transparent)" } : undefined}
    >
      <MiniThread id={id} />
      <span className="flex items-start gap-2 border-t border-hair px-3 pt-2 pb-2.5">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            {t.label}
            <span className="micro text-[9px] text-faint">{t.scheme}</span>
          </span>
          <span className="block text-[11.5px] leading-snug text-dim">{t.blurb}</span>
        </span>
        {on && <Check size={14} className="mt-0.5 shrink-0 text-signal" aria-hidden />}
      </span>
    </button>
  );
}

/** The Appearance dialog: theme cards and Match system. Opened from the top bar's palette button. */
export function Appearance() {
  const open = useTheme((s) => s.open);
  const pref = useTheme((s) => s.pref);
  const active = useTheme((s) => s.active);
  const close = () => useTheme.getState().setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div className="no-drag fixed inset-0 z-50 bg-void/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-label="Appearance" className="glass solid rise absolute top-14 left-1/2 flex max-h-[calc(100%-80px)] w-[min(760px,94%)] -translate-x-1/2 flex-col rounded-[var(--r-card)] shadow-[0_30px_80px_var(--shade)]">
        <header className="flex items-center gap-3 py-3.5 pr-2 pl-5">
          <span className="lbl text-ink">Appearance</span>
          <span className="text-[12.5px] text-dim">Pick how Shrike looks. Your app and its mockups keep their own look.</span>
          <span className="flex-1" />
          <IconButton label="Close appearance" onClick={close}>
            <X size={13} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-[var(--r-control)] border border-hair px-3 py-2">
            <input type="checkbox" checked={pref.matchSystem} onChange={(e) => useTheme.getState().setMatchSystem(e.target.checked)} className="accent-[var(--signal)]" />
            <span className="text-[13px] text-ink">Match system</span>
            <span className="text-[12px] text-dim">
              Daylight when your Mac is light, {themes[pref.dark].label} when it is dark.
            </span>
          </label>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            {THEME_IDS.map((id) => (
              <Card key={id} id={id} on={active === id} onPick={() => useTheme.getState().choose(id)} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
