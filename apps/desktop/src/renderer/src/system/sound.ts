import type { SkillEvent } from "@shrike/schema";

// A short synthesized chime: soft sine notes, rising. No audio files.
const NOTES: Record<SkillEvent["kind"], number[]> = {
  used: [1318.5],
  acquired: [987.8, 1318.5],
  leveled: [880, 1174.7, 1568],
  quest_complete: [659.3, 987.8, 1318.5, 1975.5],
  not_learned: [], // quiet
};

let ctx: AudioContext | undefined;

export function chime(kind: SkillEvent["kind"]): void {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime + 0.02;
    NOTES[kind].forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const t = t0 + i * 0.085;
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.045, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
  } catch {
    // no audio device: stay quiet
  }
}

/** XP3: a soft tick per score line, and a low thud under the rank letter. */
export function blip(kind: "tick" | "slam"): void {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = kind === "tick" ? "triangle" : "sine";
    o.frequency.setValueAtTime(kind === "tick" ? 2200 : 140, t);
    if (kind === "slam") o.frequency.exponentialRampToValueAtTime(55, t + 0.28);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(kind === "tick" ? 0.03 : 0.12, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "tick" ? 0.05 : 0.34));
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.4);
  } catch {
    // no audio device: stay quiet
  }
}
