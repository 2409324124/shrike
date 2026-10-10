import type { CardRarity, Medal, QuestGrade, QuestKind, QuestLine, StartReward } from "@shrike/schema";

// XP1–XP8 math. Pure: main/progress.ts and the renderer both use it. Every number lives in XP_TABLE (shown in the profile, XP8).
// Real events only, never tokens or clicks; nothing is ever taken away.

export const XP_TABLE = {
  clear: { start: 50, fix: 80, ship: 100, build: 120 } as Record<QuestKind, number>, // finishing the quest
  par: { start: 5 * 60_000, fix: 4 * 60_000, ship: 2 * 60_000, build: 30 * 60_000 } as Record<QuestKind, number>, // "fast" is at or under par
  fast: 30,
  onPace: 15, // under 2× par, or no clock
  slow: 5,
  firstTry: 30,
  noFixes: 20,
  oneFix: 10,
  skillUsed: 10, // each, up to 3
  verified: 40,
  acquired: 25, // each new skill, up to 3
  leveled: 35, // each kept improvement, up to 3
  flowGreen: 15, // a flow you ran passed, once per flow per day
  raceWon: 60,
  lessonMastered: 50, // RL9: a review lesson not flagged in 5 reviewed PRs since Shrike learned it, once each
  toolUnlocked: 20, // MCP8: the first time your agent uses one of your own MCP servers and it works, once per server
} as const;

/** Grade points (0–100) per line; the rank letter and the medal come from the total. */
export const SCORE = { clear: 35, fast: 15, onPace: 8, slow: 3, firstTry: 15, noFixes: 10, oneFix: 6, manyFixes: 2, skill: 5, verified: 15, bonus: 5 } as const;
export const GRADES: readonly { grade: QuestGrade; at: number }[] = [
  { grade: "S", at: 90 },
  { grade: "A", at: 75 },
  { grade: "B", at: 60 },
  { grade: "C", at: 45 },
  { grade: "D", at: 0 },
];
export const MEDALS: readonly { medal: Medal; at: number }[] = [
  { medal: "gold", at: 90 },
  { medal: "silver", at: 75 },
  { medal: "bronze", at: 55 },
];

// XP2: a normal first day (one start, a few fixes, one ship, about 1,000 XP) promotes twice; later titles take weeks.
export const TITLES: readonly { title: string; xp: number }[] = [
  { title: "Intern", xp: 0 },
  { title: "Junior Dev", xp: 250 },
  { title: "SDE1", xp: 700 },
  { title: "SDE2", xp: 1200 },
  { title: "SDE3", xp: 2500 },
  { title: "Senior SDE", xp: 4500 },
  { title: "Staff Engineer", xp: 8000 },
  { title: "Senior Staff", xp: 13000 },
  { title: "Principal Engineer", xp: 20000 },
  { title: "Principal Architect", xp: 30000 },
  { title: "Distinguished Engineer", xp: 45000 },
  { title: "Fellow", xp: 70000 },
];

export interface TitleInfo {
  index: number;
  title: string;
  from: number; // XP where this title began
  next?: string;
  nextAt?: number;
  progress: number; // 0–1 toward the next title; 1 at Fellow
}

export function titleOf(xp: number): TitleInfo {
  const x = Math.max(0, Math.floor(xp || 0));
  let i = 0;
  while (i + 1 < TITLES.length && x >= TITLES[i + 1]!.xp) i++;
  const cur = TITLES[i]!;
  const nxt = TITLES[i + 1];
  if (!nxt) return { index: i, title: cur.title, from: cur.xp, progress: 1 };
  return { index: i, title: cur.title, from: cur.xp, next: nxt.title, nextAt: nxt.xp, progress: (x - cur.xp) / (nxt.xp - cur.xp) };
}

export interface QuestFacts {
  kind: QuestKind;
  ms?: number; // how long it took; unknown for a ship
  firstTry: boolean;
  fixes: number; // things that had to be fixed on the way
  skillsUsed: number;
  verified?: boolean; // left out (a ship: CI hasn't run yet) drops the line
  rewards: StartReward[]; // acquired and leveled ones are the bonus
}

export const gradeOf = (score: number): QuestGrade => GRADES.find((g) => score >= g.at)!.grade;
export const medalOf = (score: number): Medal | undefined => MEDALS.find((m) => score >= m.at)?.medal;

const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** XP3 score lines in tally order, plus the total XP, grade points, rank letter and medal. */
export function scoreQuest(f: QuestFacts): { lines: QuestLine[]; xp: number; score: number; grade: QuestGrade; medal?: Medal } {
  const T = XP_TABLE;
  const par = T.par[f.kind];
  const pace = f.ms === undefined ? "onPace" : f.ms <= par ? "fast" : f.ms <= 2 * par ? "onPace" : "slow";
  const used = Math.min(3, Math.max(0, f.skillsUsed));
  const acq = Math.min(3, f.rewards.filter((r) => r.kind === "acquired").length);
  const lev = Math.min(3, f.rewards.filter((r) => r.kind === "leveled").length);
  const fixes = Math.max(0, f.fixes);
  const lines: QuestLine[] = [
    { id: "clear", label: "Quest clear", value: "Done", xp: T.clear[f.kind], points: SCORE.clear },
    { id: "time", label: "Time", value: f.ms === undefined ? "-" : fmtTime(f.ms), xp: T[pace], points: SCORE[pace] },
    { id: "first_try", label: "First try", value: f.firstTry ? "Yes" : "No", xp: f.firstTry ? T.firstTry : 0, points: f.firstTry ? SCORE.firstTry : 0 },
    { id: "fixes", label: "Fixes", value: String(fixes), xp: fixes === 0 ? T.noFixes : fixes === 1 ? T.oneFix : 0, points: fixes === 0 ? SCORE.noFixes : fixes === 1 ? SCORE.oneFix : SCORE.manyFixes },
    { id: "skills", label: "Skills used", value: String(Math.max(0, f.skillsUsed)), xp: used * T.skillUsed, points: Math.min(10, used * SCORE.skill) },
    ...(f.verified === undefined ? [] : [{ id: "verified" as const, label: "Verified", value: f.verified ? "Yes" : "No", xp: f.verified ? T.verified : 0, points: f.verified ? SCORE.verified : 0 }]),
    { id: "bonus", label: "Bonus", value: acq + lev ? [acq && `${acq} new`, lev && `${lev} leveled`].filter(Boolean).join(", ") : "-", xp: acq * T.acquired + lev * T.leveled, points: Math.min(10, (acq + lev) * SCORE.bonus) },
  ];
  const xp = lines.reduce((n, l) => n + l.xp, 0);
  const score = Math.min(100, lines.reduce((n, l) => n + l.points, 0));
  const medal = medalOf(score);
  return { lines, xp, score, grade: gradeOf(score), ...(medal ? { medal } : {}) };
}

// XP6: collectible cards. `test` sees the tallies after the event that may unlock it.
export interface CardTallies {
  starts: number;
  fixes: number;
  ships: number;
  skills: number; // distinct skills acquired
  sRank: number; // skills that reached S
  racesWon: number;
  flowStreak: number; // green flow runs in a row
  golds: number;
  sGrades: number;
  projects: number;
  titleIndex: number;
}

export const CARDS: readonly { id: string; name: string; rarity: CardRarity; desc: string; test(t: CardTallies): boolean }[] = [
  { id: "first-start", name: "It's alive", rarity: "bronze", desc: "Got your first app running", test: (t) => t.starts >= 1 },
  { id: "first-fix", name: "Bug hunter", rarity: "bronze", desc: "Fixed and verified your first bug", test: (t) => t.fixes >= 1 },
  { id: "first-ship", name: "Shipped it", rarity: "silver", desc: "Opened your first pull request", test: (t) => t.ships >= 1 },
  { id: "first-gold", name: "Gold standard", rarity: "silver", desc: "Won a gold medal", test: (t) => t.golds >= 1 },
  { id: "projects-3", name: "Explorer", rarity: "silver", desc: "Started 3 different projects", test: (t) => t.projects >= 3 },
  { id: "skills-10", name: "Toolbelt", rarity: "silver", desc: "Collected 10 skills", test: (t) => t.skills >= 10 },
  { id: "flow-streak", name: "Green wave", rarity: "gold", desc: "5 flows passed in a row", test: (t) => t.flowStreak >= 5 },
  { id: "race-won", name: "Photo finish", rarity: "gold", desc: "Won a fix race", test: (t) => t.racesWon >= 1 },
  { id: "fixes-10", name: "Exterminator", rarity: "gold", desc: "Fixed 10 bugs", test: (t) => t.fixes >= 10 },
  { id: "first-s", name: "S rank clear", rarity: "gold", desc: "Cleared a quest with an S", test: (t) => t.sGrades >= 1 },
  { id: "senior", name: "Senior", rarity: "gold", desc: "Promoted to Senior SDE", test: (t) => t.titleIndex >= 5 },
  { id: "skill-s", name: "Monarch", rarity: "golden", desc: "A skill reached Rank S", test: (t) => t.sRank >= 1 },
  { id: "fellow", name: "Fellow", rarity: "golden", desc: "Reached the top of the ladder", test: (t) => t.titleIndex >= TITLES.length - 1 },
];

/** Cards the tallies unlock that aren't owned yet, in binder order. */
export const newCards = (t: CardTallies, owned: Readonly<Record<string, number>>): string[] => CARDS.filter((c) => !owned[c.id] && c.test(t)).map((c) => c.id);
