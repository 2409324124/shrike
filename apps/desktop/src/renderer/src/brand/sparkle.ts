import { useEffect, useRef, type RefObject } from "react";

// B-brand3: the eye sparkle, ported from design-system/brand (the approved GIFs). Sizes are GIF px; `scale` maps them to CSS px.

export const LOOP_MS = 1800; // 36 frames x 50ms
export const DRAW_IN_MS = 900;

export interface PortraitData {
  w: number;
  h: number;
  s0: number;
  r: { bird: number; field: number };
  eye: [number, number];
  frame: { size: [number, number]; dots: [number, number]; rect: [number, number, number, number]; header: [string, number]; footer: [string, number]; font: number };
  rows: string[];
  colors: string;
}
export interface EmblemGrid {
  w: number;
  h: number;
  s0: number;
  r: number;
  eye: [number, number];
  rows: string[];
  braille: string[];
}

export type Dot = [x: number, y: number, color: string];

/** Portrait rows to dots: bird dots carry their photo colour, field dots carry "". */
export function portraitDots(p: PortraitData): { bird: Dot[]; field: Dot[] } {
  const bird: Dot[] = [];
  const field: Dot[] = [];
  let i = 0;
  p.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === "b") bird.push([x, y, `#${p.colors.slice(i * 6, ++i * 6)}`]);
      else if (row[x] === "f") field.push([x, y, ""]);
  });
  if (i * 6 !== p.colors.length) throw new Error("portrait.json: colours and bird dots disagree");
  return { bird, field };
}

export const emblemDots = (g: EmblemGrid): Dot[] => g.rows.flatMap((row, y) => [...row].flatMap((ch, x): Dot[] => (ch === "#" ? [[x, y, ""]] : [])));

/** What to paint at time `t`: how much has drawn in, and the eye ("hidden" while drawing, "steady" when still, else the loop phase). */
export function frameAt(t: number, still: boolean, drawIn: boolean): { rows: number; eye: "hidden" | "steady" | number } {
  if (still) return { rows: 1, eye: "steady" };
  if (drawIn && t < DRAW_IN_MS) return { rows: Math.max(0, t / DRAW_IN_MS), eye: "hidden" };
  return { rows: 1, eye: (((t - (drawIn ? DRAW_IN_MS : 0)) % LOOP_MS) / LOOP_MS) * 2 * Math.PI };
}

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
export const rgba = (c: string, a: number): string => `rgba(${hex(c).join(",")},${a})`;
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
};

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, fill: string, blur = 0): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.16 : r;
    ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.fillStyle = fill;
  ctx.shadowColor = blur ? fill : "transparent";
  ctx.shadowBlur = blur;
  ctx.fill();
  ctx.shadowBlur = 0;
}

/** Half the side of the square the sparkle can touch, in GIF px (the glow layer is 200px). */
export const SPARKLE_REACH = 102;

/** Glow, twinkling 4-point star, two satellite glints, bright core. `ph` null: the steady Calm eye. */
export function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, glow: string, core: string, ph: number | null): void {
  const pulse = 0.55 + 0.45 * (ph === null ? 0.5 : 0.5 + 0.5 * Math.sin(ph));
  const gr = (40 + 30 * pulse) * s;
  const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
  for (const t of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]) g.addColorStop(t, rgba(glow, (235 / 255) * (1 - t) ** 1.6));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, gr, 0, 2 * Math.PI);
  ctx.fill();
  if (ph !== null) {
    const tw = Math.max(0, Math.sin(ph * 2)) ** 3;
    if (tw > 0.02) star(ctx, x, y, (9 + 21 * tw) * s, ph * 0.5, rgba(core, tw), 8 * s);
    for (const [dx, dy, off] of [[22, -16, 1.3], [-18, 10, 2.6]] as const) {
      const t2 = Math.max(0, Math.sin(ph * 2 + off)) ** 4;
      if (t2 > 0.05) star(ctx, x + dx * s, y + dy * s, 9 * s * t2, 0.3, rgba(glow, (230 / 255) * t2));
    }
  }
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, 3.2 * s * (0.8 + 0.4 * pulse), 0, 2 * Math.PI);
  ctx.fill();
}

interface Opts {
  width: number; // CSS px
  height: number;
  bake(ctx: CanvasRenderingContext2D): void; // static dots, drawn once in CSS px
  reveal: [top: number, bottom: number]; // CSS px band the draw-in sweeps
  eye: [x: number, y: number, scale: number];
  glow: string;
  core: string;
  still: boolean;
  drawIn: boolean;
  sparkle: boolean;
  deps: unknown[]; // what changes the baked image (theme, size)
}

/** Static dots go to an offscreen canvas once; each frame only the eye square is restored and re-sparkled. Pauses offscreen and in hidden tabs. */
export function useBrandCanvas(o: Opts): RefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement>(null);
  const played = useRef(false); // the draw-in runs once per mount, not again on a theme change
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(o.width * dpr);
    const H = Math.round(o.height * dpr);
    c.width = W;
    c.height = H;
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d")!;
    octx.scale(dpr, dpr);
    o.bake(octx);

    const [ex, ey, s] = o.eye;
    const R = SPARKLE_REACH * s;
    const sx = Math.max(0, Math.floor((ex - R) * dpr));
    const sy = Math.max(0, Math.floor((ey - R) * dpr));
    const sw = Math.min(W, Math.ceil((ex + R) * dpr)) - sx;
    const sh = Math.min(H, Math.ceil((ey + R) * dpr)) - sy;
    const drawIn = o.drawIn && !played.current;
    let elapsed = 0;
    let since = performance.now();
    let full = false;
    let raf = 0;
    let seen = true;
    const live = (): boolean => !o.still && (o.sparkle || !full);

    const paint = (): void => {
      const f = frameAt(elapsed + performance.now() - since, o.still, drawIn);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (!full || f.rows < 1) {
        const [top, bottom] = o.reveal;
        const y = Math.min(H, Math.ceil((f.rows < 1 ? top + (bottom - top) * f.rows : o.height) * dpr));
        ctx.clearRect(0, 0, W, H);
        if (y > 0) ctx.drawImage(off, 0, 0, W, y, 0, 0, W, y);
        full = f.rows >= 1;
      } else if (sw > 0 && sh > 0) {
        ctx.clearRect(sx, sy, sw, sh);
        ctx.drawImage(off, sx, sy, sw, sh, sx, sy, sw, sh);
      }
      if (full) played.current = true;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (o.sparkle && f.eye !== "hidden") drawSparkle(ctx, ex, ey, s, o.glow, o.core, f.eye === "steady" ? null : f.eye);
      raf = live() ? requestAnimationFrame(paint) : 0;
    };
    const run = (): void => {
      const go = seen && !document.hidden;
      if (go && !raf && live()) {
        since = performance.now();
        raf = requestAnimationFrame(paint);
      } else if (!go && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        elapsed += performance.now() - since;
      }
    };
    paint();
    const io = new IntersectionObserver(([e]) => {
      seen = e?.isIntersecting ?? true;
      run();
    });
    io.observe(c);
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", run);
    };
  }, [o.width, o.height, o.still, o.sparkle, ...o.deps]);
  return ref;
}
