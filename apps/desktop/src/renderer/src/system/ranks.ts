import type { SkillRank } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";

// SL4 levels and ranks. Pure: main/skills.ts and the renderer both use it.
//   Level       = the skill's version (v1 = Lv.1). Every kept improvement is a level.
//   Proficiency = successful uses (a run that ended done, a git skill that worked, a flow that passed).
//   XP          = proficiency + LEVEL_XP × (level − 1), so improving a skill counts as much as using it 5 times.
//   Rank        = the highest rank whose XP the skill has reached:
//                 E 0 · D 3 · C 10 · B 25 · A 50 · S 100
// A new skill starts at Lv.1 Rank E. Three good uses make it D; a skill used 10 times and improved twice (20 XP) is C.
export const LEVEL_XP = 5;
export const RANKS: readonly { rank: SkillRank; xp: number }[] = [
  { rank: "E", xp: 0 },
  { rank: "D", xp: 3 },
  { rank: "C", xp: 10 },
  { rank: "B", xp: 25 },
  { rank: "A", xp: 50 },
  { rank: "S", xp: 100 },
];

/** Rank colours on the System's cyan glass: low ranks stay quiet, S burns white-hot. */
export const RANK_COLOR: Record<SkillRank, string> = {
  E: color.inkDim,
  D: color.teal,
  C: color.blue,
  B: color.violet,
  A: color.amber,
  S: color.core,
};

export interface RankInfo {
  level: number;
  proficiency: number;
  rank: SkillRank;
  nextRank?: SkillRank;
  nextRankAt?: number; // proficiency that reaches the next rank at this level
  rankFrom: number; // proficiency where this rank began at this level (can be below 0: levels carry it)
  progress: number; // 0–1 toward the next rank; 1 at S
}

export function rankOf(level: number | undefined, proficiency: number | undefined): RankInfo {
  const lv = Math.max(1, Math.floor(level ?? 1));
  const p = Math.max(0, Math.floor(proficiency ?? 0));
  const bonus = LEVEL_XP * (lv - 1);
  const xp = p + bonus;
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1]!.xp) i++;
  const cur = RANKS[i]!;
  const next = RANKS[i + 1];
  const rankFrom = cur.xp - bonus;
  if (!next) return { level: lv, proficiency: p, rank: cur.rank, rankFrom, progress: 1 };
  const nextRankAt = next.xp - bonus;
  const from = Math.max(0, rankFrom);
  return { level: lv, proficiency: p, rank: cur.rank, nextRank: next.rank, nextRankAt, rankFrom, progress: Math.min(1, Math.max(0, (p - from) / Math.max(1, nextRankAt - from))) };
}
