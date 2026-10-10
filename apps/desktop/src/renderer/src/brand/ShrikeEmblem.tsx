import { useMemo } from "react";
import { palette } from "@shrike/design";
import data from "@shrike/design/brand/emblem.json" with { type: "json" };
import { useCalm } from "../system/System.tsx";
import { useTheme } from "../themes/store.ts";
import { emblemDots, mix, useBrandCanvas, type EmblemGrid } from "./sparkle.ts";

// B-brand2: the cyan to blue to violet dot bust. Under 140px tall it uses the 28-column grid.
const G = data as Record<"40" | "28", EmblemGrid>;
const DOTS = { "40": emblemDots(G["40"]), "28": emblemDots(G["28"]) };

export function ShrikeEmblem({ size = 120, sparkle = true, drawIn = false, still, label = "Shrike", className }: { size?: number; sparkle?: boolean; drawIn?: boolean; still?: boolean; label?: string; className?: string }) {
  const theme = useTheme((s) => s.active);
  const calm = useCalm();
  const c = palette(theme).color;
  const id = size < 140 ? "28" : "40";
  const g = G[id];
  const pitch = size / g.h;
  const width = Math.round(g.w * pitch);
  const bake = useMemo(
    () => (ctx: CanvasRenderingContext2D) => {
      const r = pitch < 2.5 ? 0.5 : g.r; // tiny dots fade out when anti-aliased
      for (const [x, y] of DOTS[id]) {
        const t = y / g.h;
        ctx.fillStyle = t < 0.55 ? mix(c.cyan, c.blue, t / 0.55) : mix(c.blue, c.violet, (t - 0.55) / 0.45); // the Thread's spectrum
        if (pitch < 1.5) {
          ctx.fillRect(x * pitch, y * pitch, pitch, pitch); // below 1.5px a dot is a pixel: a solid silhouette reads better
          continue;
        }
        ctx.beginPath();
        ctx.arc((x + 0.5) * pitch, (y + 0.5) * pitch, r * pitch, 0, 2 * Math.PI);
        ctx.fill();
      }
    },
    [theme, size],
  );
  const ref = useBrandCanvas({
    width,
    height: size,
    bake,
    reveal: [0, size],
    eye: [g.eye[0] * pitch, g.eye[1] * pitch, size / (G["40"].h * G["40"].s0)], // sparkle sized to the bird, as in the 40-column GIF
    glow: c.cyan,
    core: c.core,
    still: still ?? calm,
    drawIn,
    sparkle,
    deps: [bake],
  });
  return <canvas ref={ref} role="img" aria-label={label} className={className} style={{ width, height: size }} />;
}
