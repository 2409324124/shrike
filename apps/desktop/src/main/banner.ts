import { color } from "@shrike/design";
import emblem from "@shrike/design/brand/emblem.json" with { type: "json" };

// B-brand2 in the terminal: the 28-column braille bust in 24-bit cyan to blue to violet, a ✦ on the eye, then SHRIKE.
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const fg = (c: number[]) => `\x1b[38;2;${c.map(Math.round).join(";")}m`;
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);

export function banner(): string {
  const { braille, eye } = emblem["28"];
  const [cyan, blue, violet] = [color.cyan, color.blue, color.violet].map(rgb) as [number[], number[], number[]];
  const at = (t: number) => (t < 0.55 ? lerp(cyan, blue, t / 0.55) : lerp(blue, violet, (t - 0.55) / 0.45));
  const [ex, ey] = [Math.floor(eye[0]! / 2), Math.floor(eye[1]! / 4)];
  const lines = braille.map((row, y) => {
    const c = fg(at(y / braille.length));
    if (y !== ey) return c + row;
    const r = row.padEnd(ex + 1);
    return `${c}${r.slice(0, ex)}\x1b[1m${fg(rgb(color.core))}✦\x1b[22m${c}${r.slice(ex + 1)}`;
  });
  return `${lines.join("\n")}\n\n\x1b[1m${fg(cyan)}  S H R I K E\x1b[0m\n`;
}
