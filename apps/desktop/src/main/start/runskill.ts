import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillProposal, StartReward } from "@shrike/schema";
import { loadSkills, pendingDraft, proposeUpdate, slug, withoutChangelog, type SkillDirs } from "../skills.ts";

// R4/R5: a start ends with a skill. The run skill lives at <project>/.shrike/skills/run-<project>.md (Shrike's format, kind: run).
// New → written (v1, Skill Acquired). Same as before → used. Different → a draft, kept when the start ends verified ready (Level Up).
// Never written: the project's .claude folder or ~/.claude. A recipe that came from there gets a Shrike copy instead.

export const runSkillId = (projectName: string) => `run-${slug(projectName.replace(/^@[^/]+\//, "")) || "app"}`;
export const runSkillPath = (root: string, id: string) => join(root, ".shrike", "skills", `${id}.md`);

const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** What a run skill must have, so the next start can follow it. */
export function checkRunSkill(body: string): string | undefined {
  const b = body.trim();
  if (b.length < 120) return "That's too short to follow next time. Write the prerequisites, every step with its exact command, the ports, the health checks, the gotchas you hit and how to stop it.";
  if (!/```|`[^`\n]+`/.test(b)) return "Put the exact commands in backticks or code blocks, so the next start can run them as they are.";
  if (!/^#{1,3}\s|^\d+[.)]\s/m.test(b)) return "Give it sections (## Prerequisites, ## Run, ## Gotchas…) or numbered steps.";
  return undefined;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export interface SaveResult {
  reward: StartReward;
  file: string;
  proposal?: SkillProposal;
}

export async function saveRunSkill(
  d: SkillDirs & { project: string },
  o: { projectName: string; body: string; when?: string; learned?: string; from?: string; runId?: string },
): Promise<SaveResult> {
  const problem = checkRunSkill(o.body);
  if (problem) throw new Error(problem);
  const id = runSkillId(o.projectName);
  const file = runSkillPath(d.project, id);
  const name = `Run ${o.projectName.replace(/^@[^/]+\//, "")}`;
  const existing = (await loadSkills(d)).find((s) => s.id === id && s.source === "project");
  if (!existing) {
    const when = oneLine(o.when || `Start ${o.projectName} locally: every service, in order, with health checks`).slice(0, 200);
    const fm = [`name: ${name}`, `when: ${when}`, "kind: run", "version: 1", `improved: ${Date.now()}`, ...(o.from ? [`from-recipe: ${oneLine(o.from)}`] : [])];
    await atomicWrite(file, `---\n${fm.join("\n")}\n---\n\n${norm(o.body)}\n`);
    return { file, reward: { kind: "acquired", skillId: id, name, level: 1, ...(o.learned ? { learned: oneLine(o.learned).slice(0, 200) } : {}) } };
  }
  if (norm(withoutChangelog(existing.body)) === norm(withoutChangelog(o.body))) return { file, reward: { kind: "used", skillId: id, name: existing.name, level: existing.version ?? 1 } };
  const reason = oneLine(o.learned || "Learned a better way to start it").slice(0, 200);
  const proposal = await proposeUpdate(d, { skillId: id, reason, after: norm(o.body), ...(o.runId ? { runId: o.runId } : {}) });
  return { file, proposal, reward: { kind: "proposed", skillId: id, name: existing.name, level: (existing.version ?? 1) + 1, learned: reason, proposalId: proposal.id } };
}

/** R7: a lesson for every project is a draft for the personal starting-apps skill (kept → ~/.shrike/skills/starting-apps.md). */
export async function proposeLesson(d: SkillDirs, lesson: string, runId?: string): Promise<SaveResult> {
  const text = oneLine(lesson);
  if (text.length < 12) throw new Error("Say the lesson in one full sentence.");
  const skill = (await loadSkills(d)).find((s) => s.id === "starting-apps");
  if (!skill) throw new Error("The starting-apps skill is missing.");
  const prev = await pendingDraft(d, skill.id, runId); // this start's earlier lessons: build on them, not over them
  const base = prev?.after ?? skill.body;
  if (base.toLowerCase().includes(text.toLowerCase())) return { file: join(d.personal, "starting-apps.md"), reward: { kind: "used", skillId: skill.id, name: skill.name, level: skill.version ?? 1 } };
  const lines = base.trimEnd().split("\n");
  const head = lines.findIndex((l) => /^## Lessons learned/.test(l));
  if (head < 0) lines.push("", "## Lessons learned", "");
  let at = head < 0 ? lines.length : lines.findIndex((l, i) => i > head && /^## /.test(l));
  if (at < 0) at = lines.length;
  while (at > 0 && !lines[at - 1]!.trim() && at - 1 > head) at--;
  lines.splice(at, 0, `- ${text}`);
  const body = lines.join("\n");
  const proposal = await proposeUpdate(d, { skillId: skill.id, reason: prev ? `${prev.reason}; ${text}` : text, after: body, ...(runId ? { runId } : {}) });
  return { file: join(d.personal, "starting-apps.md"), proposal, reward: { kind: "proposed", skillId: skill.id, name: skill.name, level: (skill.version ?? 1) + 1, learned: text, proposalId: proposal.id } };
}
