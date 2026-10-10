import fs from "node:fs/promises";
import path from "node:path";
import type { Skill, SkillOutcome } from "@shrike/schema";

export interface SkillDoc extends Skill {
  body: string;
  from?: "claude"; // an evolving copy of a Claude Code skill (S2/S4)
}

/** What load_skill and propose_skill_update need from the desktop (S1/S4). */
export interface SkillHost {
  list(): Promise<SkillDoc[]>;
  used?(id: string): void;
  propose(p: { skillId: string; reason: string; after: string }): Promise<string>; // a draft, kept once its outcome is verified
}

/** What each kind of skill-driven action must reach before its learnings are kept (drafts until then). */
export const OUTCOME: Record<SkillOutcome, { done: string; missed: string }> = {
  run: { done: "the app is verified ready (app_ready and every health check pass)", missed: "the app never came up" },
  fix: { done: "the fix is applied and the failing trip passes again", missed: "the fix wasn't verified" },
  flow: { done: "every step of the flow is green", missed: "the flow didn't pass" },
  ship: { done: "the pull request is open and its checks are green (or the branch is pushed, when there is no CI)", missed: "the checks didn't go green" },
  conflicts: { done: "the merge is clean and the tests pass", missed: "the merge or the tests failed" },
  ci: { done: "the checks are green", missed: "the checks are still red" },
  review: { done: "the review finished", missed: "the review didn't finish" },
  design: { done: "the option the user approved is built (its patch applied)", missed: "the approved design wasn't built" },
  quest: { done: "every objective's flow passes (the quest is complete)", missed: "the quest's flows didn't all pass" },
  preflight: { done: "the pre-flight matched what hosted CI then reported", missed: "CI disagreed with the pre-flight" }, // CI5
  reviewed: { done: "a reviewer resolves a thread behind it or approves one of your PRs after it, without the issue coming back", missed: "the same issue was flagged again" }, // RL4
};

export function outcomeOf(s: Pick<Skill, "id" | "kind">): SkillOutcome {
  if (s.kind === "run" || s.id === "starting-apps") return "run";
  if (s.kind === "flow") return "flow";
  if (s.id === "fix-conflicts" || s.id === "sync-main") return "conflicts";
  if (s.id === "explain-ci") return "ci";
  if (s.id === "review-pr") return "review";
  if (s.id === "design-taste" || s.id === "mockup-options") return "design";
  if (s.id === "plan-feature") return "quest";
  if (s.id === "ci-lessons") return "preflight";
  if (s.id === "review-lessons") return "reviewed";
  return s.kind === "git" ? "ship" : "fix";
}

const BLOCK = /^([>|])[+-]?\d*$/;

/** The front-matter block: flat `key: value` lines, quoted values and `>`/`|` block scalars. Nested maps are skipped. */
export function frontMatter(text: string): { fields: Record<string, string>; raw: string; body: string } | null {
  const m = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const lines = (m[1] ?? "").split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (lines[i + 1]!.trim() === "" && /^\s+\S/.test(lines[i + 2] ?? "")))) more.push(lines[++i]!.trim());
    const block = BLOCK.exec(v);
    if (block) v = block[1] === ">" ? more.join(" ") : more.join("\n");
    else if (!v && more.length) v = /^([\w-]+:|- )/.test(more[0]!) ? "" : more.join(" "); // nested map or list: not a scalar
    else if (more.length) v = [v, ...more].join(" ");
    if (/^"/.test(v)) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.replace(/^"|"$/g, "");
      }
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    fields[kv[1]!.toLowerCase()] = typeof v === "string" ? v.trim() : "";
  }
  return { fields, raw: m[1] ?? "", body: m[2]! };
}

/** One line of "when" from a long Claude Code description: its "Use when …" sentence, else its first sentence. */
export function whenOf(description: string): string {
  const s = description.replace(/\s+/g, " ").trim();
  const use = /\b(Use (?:it |this(?: skill)? |proactively )?(?:when|whenever|for|before|after|to)\b.*?)(?:(?<!\.)\.(?=\s|$)|$)/i.exec(s)?.[1];
  const pick = (use ?? s.split(/(?<=[.!?])\s/)[0] ?? s).trim().replace(/[.;:,]$/, "");
  return pick.length > 140 ? `${pick.slice(0, 139).trimEnd()}…` : pick;
}

/** prompts/skills/<id>.md, .shrike/skills/<id>.md or a Claude Code SKILL.md: name and when (or description) in front matter. */
export function parseSkill(id: string, text: string): SkillDoc | null {
  const fm = frontMatter(text);
  if (!fm) return null;
  const f = fm.fields;
  const when = f.when || (f.description ? whenOf(f.description) : "");
  if (!when) return null;
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const version = num(f.version);
  const improvedAt = num(f.improved);
  const kind = f.kind === "debug" || f.kind === "flow" || f.kind === "git" || f.kind === "run" || f.kind === "chain" ? f.kind : undefined;
  // MCP7: `uses-mcp: [chrome-devtools, github]` or a comma list. ponytail: inline lists only, not a block `- x` list.
  const usesMcp = [...new Set((f["uses-mcp"] ?? "").replace(/^\[|\]$/g, "").split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  return {
    id,
    name: f.name || id,
    when,
    body: fm.body.trim(),
    ...(version ? { version } : {}),
    ...(improvedAt ? { improvedAt } : {}),
    ...(kind ? { kind } : {}),
    ...(usesMcp.length ? { usesMcp } : {}),
    ...(f.from === "claude" ? { from: "claude" as const } : {}),
  };
}

const plain = (s: string) => {
  const t = s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*+|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = t.split(/(?<=[.!?])\s/)[0]!.replace(/[.:]$/, "");
  return first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
};

/** S3: the skill's steps as a checklist. One numbered list wins; else its sections (## headings); else the first numbered list. */
export function skillSteps(body: string, max = 12): string[] {
  const lines = body.replace(/^## Changelog\b[\s\S]*$/m, "").replace(/```[\s\S]*?```/g, "").split(/\r?\n/);
  const lists: string[][] = [];
  for (const l of lines) {
    const m = /^(\d+)[.)]\s+(.+)$/.exec(l);
    if (!m) continue;
    if (m[1] === "1" || !lists.length) lists.push([]);
    lists.at(-1)!.push(plain(m[2]!));
  }
  const heads = lines.flatMap((l) => {
    const m = /^##\s+(.+)$/.exec(l);
    return m ? [plain(m[1]!.replace(/^(\d+[.)]|step \d+:?)\s*(?:[—–-]\s*)?/i, ""))] : [];
  });
  const pick = lists.length === 1 && lists[0]!.length >= 2 ? lists[0]! : heads.length >= 2 ? heads : (lists[0] ?? []);
  return pick.filter(Boolean).slice(0, max);
}

export async function readSkills(dir: string): Promise<SkillDoc[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const docs = await Promise.all(names.map(async (f) => parseSkill(f.slice(0, -3), await fs.readFile(path.join(dir, f), "utf8"))));
  return docs.filter((d): d is SkillDoc => d !== null);
}

export async function listSkills(dir: string): Promise<Skill[]> {
  return (await readSkills(dir)).map(({ id, name, when }) => ({ id, name, when }));
}
