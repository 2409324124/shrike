import { useMemo } from "react";
import { palette, themes } from "@shrike/design";
import data from "@shrike/design/brand/portrait.json" with { type: "json" };
import { useCalm } from "../system/System.tsx";
import { useTheme } from "../themes/store.ts";
import { mix, portraitDots, rgba, useBrandCanvas, type PortraitData } from "./sparkle.ts";

// B-brand1: the dot portrait, no frame or captions. The bird keeps its photo colours; the field follows the theme.
const P = data as PortraitData;
const dots = portraitDots(P);

export function ShrikeBust({ width = 360, drawIn = false, still, className }: { width?: number; drawIn?: boolean; still?: boolean; className?: string }) {
  const theme = useTheme((s) => s.active);
  const calm = useCalm();
  const c = palette(theme).color;
  const light = themes[theme].scheme === "light";
  const F = P.frame;
  const k = width / F.size[0];
  const height = Math.round(F.size[1] * k);
  const pitch = P.s0 * k;
  const [dx, dy] = [F.dots[0] * k, F.dots[1] * k];
  const bake = useMemo(
    () => (ctx: CanvasRenderingContext2D) => {
      const grow = pitch < 2.5 ? 1.4 : 1; // tiny dots fade out when anti-aliased
      const dot = (x: number, y: number, r: number, fill: string) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(dx + (x + 0.5) * pitch, dy + (y + 0.5) * pitch, r * grow * pitch, 0, 2 * Math.PI);
        ctx.fill();
      };
      // ponytail: Daylight darkens the bird so its pale throat still reads on paper
      for (const [x, y, col] of dots.bird) dot(x, y, P.r.bird, light ? mix(col, c.ink, 0.45) : col);
      for (const [x, y] of dots.field) dot(x, y, P.r.field, light ? rgba(c.inkFaint, 0.55) : rgba(mix(c.teal, c.blue, y / P.h), 0.42));
    },
    [theme, width],
  );
  const ref = useBrandCanvas({
    width,
    height,
    bake,
    reveal: [dy, dy + P.h * pitch],
    eye: [dx + P.eye[0] * pitch, dy + P.eye[1] * pitch, k],
    glow: mix(c.cyan, c.core, 0.3), // the GIF's pale cyan (120,230,255) in Abyss
    core: c.core,
    still: still ?? calm,
    drawIn,
    sparkle: true,
    deps: [bake],
  });
  return <canvas ref={ref} role="img" aria-label="Shrike: a long-tailed shrike drawn in dots" className={className} style={{ width, height }} />;
}
