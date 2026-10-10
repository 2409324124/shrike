import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BrowserWindow } from "electron";
import type { Medal, Progress, ProgressCard, PullRequest, QuestResult, Race, ShrikeEvents, SkillEvent, StartPlan } from "@shrike/schema";
import { CARDS, newCards, scoreQuest, titleOf, XP_TABLE, type CardTallies, type QuestFacts } from "../renderer/src/progress/xp.ts";

// XP1–XP8: the XP ledger in userData/progress.json, per user with per-project tallies. Electron-free so it tests with node:test.
// XP comes only from real events: quests finished (start, verified fix, ship), skills acquired or leveled, flows you ran passing, fix races won.

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;
type Medals = Record<Medal, number>;

export interface Ledger {
  xp: number;
  quests: number;
  starts: number;
  fixes: number;
  ships: number;
  sGrades: number;
  medals: Medals;
  cards: Record<string, number>; // card id → unlocked at
  skills: string[]; // distinct skills acquired
  sRank: string[]; // skills that reached S
  races: string[]; // fix races won
  flowStreak: number;
  flowDay: Record<string, string>; // flow id → the day it last earned XP
  shipped: string[]; // "<root>#<pr>"
  credited: Record<string, number>; // "acquired:<skill>:<level>" → XP it earned on its own (a quest's bonus takes it over)
  projects: Record<string, { name: string; xp: number; quests: number; medals: Medals; started?: boolean; startDay?: string }>;
  recent: QuestResult[];
}

export interface QuestInput extends QuestFacts {
  quest: string;
  root?: string;
  project?: string;
  key?: string; // one result per key (the run id)
}

const MAX_RECENT = 20;
const today = () => new Date().toISOString().slice(0, 10);
const noMedals = (): Medals => ({ bronze: 0, silver: 0, gold: 0 });
const file = (dir: string) => join(dir, "progress.json");

export const emptyLedger = (): Ledger => ({ xp: 0, quests: 0, starts: 0, fixes: 0, ships: 0, sGrades: 0, medals: noMedals(), cards: {}, skills: [], sRank: [], races: [], flowStreak: 0, flowDay: {}, shipped: [], credited: {}, projects: {}, recent: [] });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const rec = <T>(v: unknown): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
const medals = (v: unknown): Medals => ({ bronze: num(rec(v).bronze), silver: num(rec(v).silver), gold: num(rec(v).gold) });

export async function readLedger(dir: string): Promise<Ledger> {
  try {
    const v = rec<unknown>(JSON.parse(await readFile(file(dir), "utf8")));
    const projects = Object.fromEntries(Object.entries(rec<Record<string, unknown>>(v.projects)).map(([k, p]) => [k, { name: typeof p.name === "string" ? p.name : basename(k), xp: num(p.xp), quests: num(p.quests), medals: medals(p.medals), ...(p.started === true ? { started: true } : {}), ...(typeof p.startDay === "string" ? { startDay: p.startDay } : {}) }]));
    return {
      xp: num(v.xp), quests: num(v.quests), starts: num(v.starts), fixes: num(v.fixes), ships: num(v.ships), sGrades: num(v.sGrades), medals: medals(v.medals),
      cards: Object.fromEntries(Object.entries(rec<unknown>(v.cards)).filter(([, at]) => num(at) > 0)) as Record<string, number>,
      skills: strs(v.skills), sRank: strs(v.sRank), races: strs(v.races), flowStreak: num(v.flowStreak),
      flowDay: Object.fromEntries(Object.entries(rec<unknown>(v.flowDay)).filter(([, d]) => typeof d === "string")) as Record<string, string>,
      shipped: strs(v.shipped), credited: Object.fromEntries(Object.entries(rec<unknown>(v.credited)).map(([k, x]) => [k, num(x)])), projects,
      recent: Array.isArray(v.recent) ? (v.recent as QuestResult[]).filter((r) => r && typeof r === "object" && typeof r.id === "string" && Array.isArray(r.lines)).slice(-MAX_RECENT) : [],
    };
  } catch {
    return emptyLedger();
  }
}

let chain: Promise<unknown> = Promise.resolve();
/** Read, change and write the ledger, one at a time; the temp file and rename mean a crash never leaves half a ledger. */
function update<T>(dir: string, fn: (l: Ledger) => T): Promise<{ ledger: Ledger; out: T }> {
  const run = async () => {
    const ledger = await readLedger(dir);
    const out = fn(ledger);
    await mkdir(dir, { recursive: true });
    const tmp = `${file(dir)}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger));
    await rename(tmp, file(dir));
    return { ledger, out };
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

const tallies = (l: Ledger): CardTallies => ({
  starts: l.starts, fixes: l.fixes, ships: l.ships, skills: l.skills.length, sRank: l.sRank.length, racesWon: l.races.length, flowStreak: l.flowStreak,
  golds: l.medals.gold, sGrades: l.sGrades, projects: Object.values(l.projects).filter((p) => p.started).length, titleIndex: titleOf(l.xp).index,
});

const cardOf = (id: string, at?: number): ProgressCard => {
  const c = CARDS.find((x) => x.id === id)!;
  return { id, name: c.name, rarity: c.rarity, desc: c.desc, ...(at ? { at } : {}) };
};

/** Adds XP, then unlocks whatever cards the new tallies earn. Returns the promotion and the new cards. */
function grant(l: Ledger, xp: number, root?: string, name?: string): { promoted?: { from: string; to: string }; cards: ProgressCard[] } {
  const from = titleOf(l.xp).title;
  l.xp += Math.max(0, xp);
  if (root) {
    const p = (l.projects[root] ??= { name: name ?? basename(root), xp: 0, quests: 0, medals: noMedals() });
    p.xp += Math.max(0, xp);
    if (name) p.name = name;
  }
  const to = titleOf(l.xp).title;
  const at = Date.now();
  const ids = newCards(tallies(l), l.cards);
  for (const id of ids) l.cards[id] = at;
  return { ...(from !== to ? { promoted: { from, to } } : {}), cards: ids.map((id) => cardOf(id, at)) };
}

const skillKey = (kind: "acquired" | "leveled", skillId: string, level?: number) => `${kind}:${skillId}:${level ?? 1}`;

/** XP3: score a finished quest and bank it. A key seen before returns null (one result per run). */
export async function recordQuest(dir: string, q: QuestInput): Promise<QuestResult | null> {
  const { out } = await update(dir, (l): QuestResult | null => {
    const id = q.key ?? `${q.kind}-${Date.now()}`;
    if (l.recent.some((r) => r.id === id)) return null;
    // XP8 no farming: restarting a known app scores once per project a day, unless the run grew a skill
    const grew = q.rewards.some((r) => r.kind === "acquired" || r.kind === "leveled");
    if (q.kind === "start" && q.root && !grew && l.projects[q.root]?.startDay === today()) return null;
    const s = scoreQuest(q);
    // A skill acquired or leveled during the quest may already have earned XP on its own: the bonus line takes over the ones it counts (3 per kind).
    let already = 0;
    const taken = { acquired: 0, leveled: 0 };
    for (const r of q.rewards) {
      if (r.kind !== "acquired" && r.kind !== "leveled") continue;
      if (r.kind === "acquired" && !l.skills.includes(r.skillId)) l.skills.push(r.skillId);
      if (++taken[r.kind] > 3) continue;
      const k = skillKey(r.kind, r.skillId, r.level);
      already += l.credited[k] ?? 0;
      l.credited[k] = 0;
    }
    already = Math.min(already, s.xp);
    l.quests++;
    if (q.kind === "start") l.starts++;
    else if (q.kind === "fix") l.fixes++;
    else if (q.kind === "ship") l.ships++;
    if (s.medal) l.medals[s.medal]++;
    if (s.grade === "S") l.sGrades++;
    if (q.root) {
      const p = (l.projects[q.root] ??= { name: q.project ?? basename(q.root), xp: 0, quests: 0, medals: noMedals() });
      p.quests++;
      if (s.medal) p.medals[s.medal]++;
      if (q.kind === "start") (p.started = true), (p.startDay = today());
    }
    const before = l.xp; // what the top bar shows now: XP never seems to go back, and a promotion a skill already caused isn't shown twice
    const g = grant(l, s.xp - already, q.root, q.project);
    const result: QuestResult = {
      id, kind: q.kind, quest: q.quest, ...(q.project ? { project: q.project } : q.root ? { project: basename(q.root) } : {}), at: Date.now(),
      lines: s.lines, xp: s.xp, score: s.score, grade: s.grade, ...(s.medal ? { medal: s.medal } : {}), rewards: q.rewards, cards: g.cards,
      before, after: l.xp, ...(titleOf(before).title !== titleOf(l.xp).title ? { promoted: { from: titleOf(before).title, to: titleOf(l.xp).title } } : {}),
    };
    l.recent = [...l.recent, result].slice(-MAX_RECENT);
    return result;
  });
  return out;
}

/** XP outside a quest. A key counts once ever. apply changes the tallies and returns the XP to grant, or null to change nothing. */
export async function credit(dir: string, o: { key?: string; root?: string; apply(l: Ledger): number | null }): Promise<{ ledger: Ledger; promoted?: { from: string; to: string }; cards: ProgressCard[] } | null> {
  const { ledger, out } = await update(dir, (l) => {
    if (o.key && o.key in l.credited) return null;
    const xp = o.apply(l);
    if (xp === null) return null;
    if (o.key) l.credited[o.key] = xp;
    return grant(l, xp, o.root);
  });
  return out ? { ledger, ...out } : null;
}

export function progressOf(l: Ledger, root?: string): Progress {
  const t = titleOf(l.xp);
  const p = root ? l.projects[root] : undefined;
  const T = XP_TABLE;
  return {
    xp: l.xp, title: t.title, titleIndex: t.index, titleFrom: t.from, ...(t.next ? { nextTitle: t.next, nextAt: t.nextAt } : {}),
    medals: { ...l.medals }, cards: CARDS.map((c) => cardOf(c.id, l.cards[c.id])), quests: l.quests, bugsFixed: l.fixes,
    projectsStarted: Object.values(l.projects).filter((x) => x.started).length, prsShipped: l.ships,
    ...(p ? { project: { name: p.name, xp: p.xp, quests: p.quests, medals: { ...p.medals } } } : {}),
    recent: l.recent,
    formula: [
      { label: "Get an app running (once a day each project)", xp: T.clear.start },
      { label: "Fix a bug and verify it", xp: T.clear.fix },
      { label: "Ship a pull request", xp: T.clear.ship },
      { label: "Complete a feature quest", xp: T.clear.build },
      { label: "Fast (under par)", xp: T.fast },
      { label: "First try", xp: T.firstTry },
      { label: "No fixes needed", xp: T.noFixes },
      { label: "Each skill used (up to 3)", xp: T.skillUsed },
      { label: "Verified", xp: T.verified },
      { label: "New skill", xp: T.acquired },
      { label: "Skill leveled up", xp: T.leveled },
      { label: "A flow you ran passed (once a day each)", xp: T.flowGreen },
      { label: "Won a fix race", xp: T.raceWon },
      { label: "A review lesson mastered (not flagged in 5 PRs)", xp: T.lessonMastered },
      { label: "A new tool server worked for your agent (once each)", xp: T.toolUnlocked },
    ],
  };
}

// ---- wiring (ipc.ts configures and calls observe and shipped; skills.ts calls questDone) ----

let cfg: { dir(): string; root(): string | undefined } | undefined;
let emit: Emit = () => {};

export function configureProgress(c: { dir(): string; root(): string | undefined }, send: Emit): void {
  cfg = c;
  emit = send;
}

export const getProgress = async (): Promise<Progress> => (cfg ? progressOf(await readLedger(cfg.dir()), cfg.root()) : progressOf(emptyLedger()));

const push = (ledger: Ledger, extra: { result?: QuestResult; promoted?: { from: string; to: string }; cards?: ProgressCard[] } = {}) =>
  emit("progress:update", { progress: progressOf(ledger, cfg?.root()), ...extra });

/** A finished quest: bank it and open the results screen. */
export async function questDone(q: Omit<QuestInput, "firstTry"> & { firstTry?: boolean }): Promise<void> {
  if (!cfg) return;
  try {
    const firstTry = q.firstTry ?? !(q.root && failedAt.get(q.root) && Date.now() - failedAt.get(q.root)! < 3600_000);
    const result = await recordQuest(cfg.dir(), { ...q, firstTry });
    if (result) push(await readLedger(cfg.dir()), { result });
  } catch {
    // progress never breaks the quest it scores
  }
}

async function creditNow(o: Parameters<typeof credit>[1]): Promise<boolean> {
  const r = await credit(cfg!.dir(), o);
  if (r) push(r.ledger, { ...(r.promoted ? { promoted: r.promoted } : {}), ...(r.cards.length ? { cards: r.cards } : {}) });
  return !!r;
}

/** XP outside these events, once per key (RL9 a review lesson mastered, MCP8 a tool unlocked). True the first time. */
export const earn = (key: string, xp: number): Promise<boolean> => (cfg ? creditNow({ key, root: cfg.root(), apply: () => xp }).catch(() => false) : Promise.resolve(false));

const failedAt = new Map<string, number>(); // project root → a start that failed, so the next one isn't a first try

export async function observe(channel: string, payload: unknown): Promise<void> {
  if (!cfg || !payload || typeof payload !== "object") return;
  try {
    if (channel === "skill:event") {
      const e = payload as SkillEvent;
      if (e.rank === "S" && e.skillId) await creditNow({ apply: (l) => (l.sRank.includes(e.skillId) ? null : (l.sRank.push(e.skillId), 0)) });
      if (e.kind !== "acquired" && e.kind !== "leveled") return;
      const kind = e.kind;
      await creditNow({
        key: skillKey(kind, e.skillId, e.level),
        root: cfg.root(),
        apply: (l) => {
          if (kind === "acquired" && !l.skills.includes(e.skillId)) l.skills.push(e.skillId);
          return kind === "acquired" ? XP_TABLE.acquired : XP_TABLE.leveled;
        },
      });
    } else if (channel === "start:plan") {
      const p = payload as StartPlan;
      if (p.state === "failed") failedAt.set(p.projectRoot, Date.now());
    } else if (channel === "flow:result") {
      const r = payload as ShrikeEvents["flow:result"];
      if (!r.ok) return void (await credit(cfg.dir(), { apply: (l) => (l.flowStreak ? ((l.flowStreak = 0), 0) : null) }));
      const day = today();
      // a watched flow re-running by itself keeps the streak but earns nothing, and each flow pays once a day: no farming
      await creditNow({
        root: cfg.root(),
        apply: (l) => {
          l.flowStreak++;
          if (r.watched || l.flowDay[r.flowId] === day) return 0;
          l.flowDay[r.flowId] = day;
          return XP_TABLE.flowGreen;
        },
      });
    } else if (channel === "race:update") {
      const r = payload as Race;
      if (r.kind === "sandbox" || !r.adopted || r.candidates.find((c) => c.worktree === r.adopted)?.state !== "green") return;
      await creditNow({ key: `race:${r.id}`, root: cfg.root(), apply: (l) => (l.races.push(r.id), XP_TABLE.raceWon) });
    }
  } catch {
    // progress never breaks the event it watches
  }
}

/** git.shipFix opened or updated a pull request: the first time a PR lands from Shrike it's a ship quest. */
export async function shipped(pr: PullRequest): Promise<void> {
  const root = cfg?.root();
  if (!cfg || !root || pr.state !== "open") return;
  try {
    const key = `${root}#${pr.number}`;
    if (!(await credit(cfg.dir(), { apply: (l) => (l.shipped.includes(key) ? null : (l.shipped.push(key), 0)) }))) return;
    await questDone({ kind: "ship", quest: `Ship: ${pr.title.slice(0, 60)}`, root, key: `ship-${key}`, firstTry: true, fixes: 0, skillsUsed: 0, rewards: [] }); // no Verified line: CI is still pending when the PR opens
  } catch {
    // progress never breaks the ship it scores
  }
}

/** XP7 Share as image: a save dialog for the profile card PNG. */
export async function saveImage(win: BrowserWindow | undefined, bytes: Uint8Array, name: string): Promise<string | null> {
  const { app, dialog } = await import("electron");
  const safe = `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "shrike-profile"}.png`;
  let path: string;
  if (process.env.SHRIKE_SAVE_DIR) path = join(process.env.SHRIKE_SAVE_DIR, safe); // ponytail: test-only bypass, like saveClip
  else {
    const opts = { title: "Save image", defaultPath: join(app.getPath("pictures"), safe), filters: [{ name: "Image", extensions: ["png"] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    path = r.filePath;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

