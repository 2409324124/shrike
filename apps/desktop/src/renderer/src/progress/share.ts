import type { Progress, SkillRank } from "@shrike/schema";
import { color, font } from "@shrike/design";
import { fmtXp } from "./parts.tsx";

// XP7 Share as image: the profile card drawn on an offscreen canvas, 1200×630 (the size link previews use).

const W = 1200;
const H = 630;
const METAL = { gold: ["#fff2c4", "#e9b23c", "#8f5a0b"], silver: ["#ffffff", "#a9b6c8", "#5d6a7e"], bronze: ["#ffd9b5", "#c27a3a", "#6b3a14"], golden: ["#fff2c4", "#e9b23c", "#8f5a0b"] } as const;

export async function renderProfilePng(p: Progress, byRank: Map<SkillRank, string[]>): Promise<Blob> {
  await document.fonts?.ready;
  const cv = new OffscreenCanvas(W, H);
  const g = cv.getContext("2d")!;
  const bg = g.createRadialGradient(W / 2, H * 0.3, 40, W / 2, H * 0.4, W * 0.75);
  bg.addColorStop(0, color.navy);
  bg.addColorStop(1, color.void);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // frame and bracket corners
  g.strokeStyle = "rgba(63,231,255,0.6)";
  g.lineWidth = 1.5;
  g.shadowColor = color.cyan;
  g.shadowBlur = 16;
  g.strokeRect(40, 40, W - 80, H - 80);
  g.shadowBlur = 6;
  g.strokeStyle = color.core;
  g.lineWidth = 3;
  for (const [x, y, dx, dy] of [[34, 34, 1, 1], [W - 34, 34, -1, 1], [34, H - 34, 1, -1], [W - 34, H - 34, -1, -1]] as const) {
    g.beginPath();
    g.moveTo(x, y + dy * 24);
    g.lineTo(x, y);
    g.lineTo(x + dx * 24, y);
    g.stroke();
  }
  g.shadowBlur = 0;

  const text = (s: string, x: number, y: number, f: string, c: string, align: CanvasTextAlign = "left", glow = 0) => {
    g.font = f;
    g.fillStyle = c;
    g.textAlign = align;
    g.shadowColor = color.cyan;
    g.shadowBlur = glow;
    g.fillText(s, x, y);
    g.shadowBlur = 0;
  };
  const mono = (px: number, w = 500) => `${w} ${px}px ${font.mono}`;
  const disp = (px: number, w = 600) => `${w} ${px}px ${font.display}`;

  text("[ HUNTER PROFILE ]", W / 2, 92, mono(16, 600), color.cyan, "center", 10);
  text("SHRIKE", 80, 92, mono(13, 600), color.inkDim);
  text("TITLE", 80, 150, mono(13), color.inkDim);
  text(p.title, 80, 222, disp(72, 700), color.core, "left", 22);
  text(`${fmtXp(p.xp)} XP`, 80, 268, mono(22, 600), color.ink);
  if (p.nextTitle) text(`${fmtXp((p.nextAt ?? 0) - p.xp)} to ${p.nextTitle}`, 640, 268, mono(15), color.inkDim, "right");
  // XP bar
  const k = p.nextAt ? Math.max(0, Math.min(1, (p.xp - p.titleFrom) / (p.nextAt - p.titleFrom))) : 1;
  g.fillStyle = "rgba(63,231,255,0.12)";
  g.fillRect(80, 286, 560, 8);
  const bar = g.createLinearGradient(80, 0, 640, 0);
  bar.addColorStop(0, color.blue);
  bar.addColorStop(0.7, color.cyan);
  bar.addColorStop(1, color.core);
  g.fillStyle = bar;
  g.shadowColor = color.cyan;
  g.shadowBlur = 12;
  g.fillRect(80, 286, 560 * k, 8);
  g.shadowBlur = 0;

  // stats
  const stats: [string, number][] = [["QUESTS", p.quests], ["BUGS FIXED", p.bugsFixed], ["PROJECTS", p.projectsStarted], ["PRS SHIPPED", p.prsShipped]];
  stats.forEach(([label, v], i) => {
    const x = 80 + i * 145;
    g.strokeStyle = "rgba(63,231,255,0.25)";
    g.lineWidth = 1;
    g.strokeRect(x, 330, 130, 84);
    text(label, x + 14, 356, mono(11), color.inkDim);
    text(String(v), x + 14, 398, disp(34), color.core);
  });

  // medals
  (["gold", "silver", "bronze"] as const).forEach((m, i) => {
    const cx = 790 + i * 120;
    const cy = 190;
    const mg = g.createLinearGradient(cx - 40, cy - 40, cx + 40, cy + 40);
    METAL[m].forEach((c, j) => mg.addColorStop(j / 2, c));
    g.globalAlpha = p.medals[m] ? 1 : 0.3;
    g.fillStyle = mg;
    g.shadowColor = METAL[m][1];
    g.shadowBlur = 20;
    g.beginPath();
    g.arc(cx, cy, 40, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    text("★", cx, cy + 13, disp(36, 700), "rgba(40,22,0,0.55)", "center");
    g.globalAlpha = 1;
    text(String(p.medals[m]), cx, cy + 78, mono(20, 600), color.ink, "center");
  });

  // cards and ranks
  const owned = p.cards.filter((c) => c.at);
  text(`CARDS ${owned.length}/${p.cards.length}`, 740, 330, mono(13), color.inkDim);
  p.cards.forEach((c, i) => {
    const x = 740 + (i % 7) * 52;
    const y = 346 + Math.floor(i / 7) * 70;
    if (c.at) {
      const cg = g.createLinearGradient(x, y, x + 44, y + 60);
      METAL[c.rarity].forEach((col, j) => cg.addColorStop(j / 2, col));
      g.fillStyle = cg;
    } else g.fillStyle = "#1a2133";
    g.fillRect(x, y, 44, 60);
    if (c.rarity === "golden" && c.at) {
      const holo = g.createLinearGradient(x, y, x + 44, y + 60);
      ["rgba(255,0,132,0.4)", "rgba(0,255,170,0.4)", "rgba(0,170,255,0.4)"].forEach((col, j) => holo.addColorStop(j / 2, col));
      g.fillStyle = holo;
      g.fillRect(x, y, 44, 60);
    }
  });
  const ranks = (["S", "A", "B", "C"] as const).map((r) => `${r} ${byRank.get(r)?.length ?? 0}`).join("   ");
  text(`SKILLS   ${ranks}`, 80, 470, mono(16, 600), color.ink);
  const top = [...(byRank.get("S") ?? []), ...(byRank.get("A") ?? []), ...(byRank.get("B") ?? [])].slice(0, 3);
  if (top.length) text(top.join(" · "), 80, 500, disp(18, 500), color.inkDim);
  text("Every action is a skill.", W - 80, H - 66, disp(16, 500), color.inkDim, "right");
  return cv.convertToBlob({ type: "image/png" });
}
