import type { CiFailureKind, CiJob, CiLessonsState, CiPipeline, PreflightLeg, PreflightRun } from "@shrike/schema";

// CI1–CI8 in plain words, pure so it tests without a DOM.

/** "ci / Dashboard lint" → "Dashboard lint". */
export const short = (name: string): string => name.replace(/^[^/]+ \/ /, "");

const mins = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

const KIND: Partial<Record<CiFailureKind, string>> = { memory: "out of memory", env: "missing env", unknown: "other" };

/** CI2: what the skill holds. Before any pre-flight lesson, the failure kinds it learned from CI's runs, or plainly none. */
export function skillLine(lessons: number, p?: CiPipeline | null): string {
  if (lessons) return `${lessons} ${lessons === 1 ? "lesson" : "lessons"}`;
  const kinds = [...new Set((p?.jobs ?? []).flatMap((j) => j.stats?.last?.kind ?? []))].map((k) => KIND[k] ?? k);
  return kinds.length ? `knows ${kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}`} failures` : "no CI failures seen yet";
}

/** CI6: "CI caught 0 surprises in your last 8 pushes". */
export function recordLine(r: CiLessonsState["record"]): { n: number; line: string } {
  const measured = r.pushes.filter((p) => p !== "waiting").length;
  if (!measured) return { n: 0, line: r.pushes.length ? "Waiting on CI for your push" : "No pushes measured yet. Run pre-flight, then push" };
  return { n: r.surprises, line: `${r.surprises === 1 ? "surprise" : "surprises"} from CI in your last ${measured === 1 ? "push" : `${measured} pushes`}` };
}

export type Tone = "ok" | "fail" | "flaky" | "off" | "idle";

/** A station's colour from history: failing more than 1 in 5, flaky, not on pull requests, or quiet. */
export function jobTone(j: CiJob): Tone {
  if (j.off) return "off";
  if (j.stats?.flaky) return "flaky";
  if (!j.stats?.runs) return "idle";
  return j.stats.fails / j.stats.runs > 0.2 ? "fail" : "ok";
}

/** "node 22 · 4 min · 1 in 6 failed" */
export function jobLine(j: CiJob): string {
  if (j.off) return "not on pull requests";
  const s = j.stats;
  return [j.node ? `node ${j.node}` : "", s?.seconds ? mins(s.seconds) : "", s?.runs ? (s.fails ? `${s.fails} in ${s.runs} failed` : `${s.runs} green`) : "", s?.flaky ? "flaky" : ""].filter(Boolean).join(" · ");
}

export interface Lane {
  stage: number;
  label: string; // "STAGE 1 · 9 JOBS" or the GitLab stage name
  groups: { workflow: string; jobs: CiJob[] }[];
}

/** CI1: stages as lanes, jobs grouped by workflow inside each, in config order. */
export function lanes(p: CiPipeline): Lane[] {
  const by = new Map<number, CiJob[]>();
  for (const j of p.jobs) by.set(j.stage, [...(by.get(j.stage) ?? []), j]);
  return [...by.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, jobs]) => {
      const groups: Lane["groups"] = [];
      for (const j of jobs) {
        const g = groups.find((x) => x.workflow === j.workflow);
        if (g) g.jobs.push(j);
        else groups.push({ workflow: j.workflow, jobs: [j] });
      }
      const name = jobs.find((j) => j.stageName)?.stageName;
      const on = jobs.filter((j) => !j.off).length; // pre-flight's "of N" counts only these
      return { stage, label: `${name ?? `Stage ${stage + 1}`} · ${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${on < jobs.length ? `, ${on} ${on === 1 ? "runs" : "run"} on pull requests` : ""}`, groups };
    });
}

export type Side = "pass" | "fail" | "skipped" | "none";

/** CI5: each leg beside its hosted job; the first that differs is the one that snaps. */
export function sideBySide(run: PreflightRun | null): { rows: { job: string; name: string; local: Side; hosted: Side; differs: boolean }[]; first?: string } {
  if (!run?.hosted?.jobs.length) return { rows: [] };
  const rows = run.legs.map((l) => {
    const h = run.hosted!.jobs.find((x) => x.name === l.name);
    const local: Side = l.state === "pass" || l.state === "fail" || l.state === "skipped" ? l.state : "none";
    const hosted: Side = h ? (h.state === "pending" ? "none" : h.state) : "none";
    return { job: l.job, name: l.name, local, hosted, differs: (local === "pass" || local === "fail") && (hosted === "pass" || hosted === "fail") && local !== hosted };
  });
  for (const h of run.hosted.jobs) if (h.state === "fail" && !run.legs.some((l) => l.name === h.name)) rows.push({ job: h.name, name: h.name, local: "none", hosted: "fail", differs: run.hosted.first === h.name });
  return { rows, ...(run.hosted.first ? { first: run.hosted.first } : {}) };
}

/** CI4: the result line's parts, red ones first in the sentence order they ran. */
export function resultParts(run: PreflightRun): { name: string; state: PreflightLeg["state"]; why?: string; job: string }[] {
  return run.legs.filter((l) => l.state !== "skipped").map((l) => ({ name: short(l.name), state: l.state, job: l.job, ...(l.state === "fail" && l.why ? { why: l.why } : {}) }));
}

/** Legs that couldn't run here, folded into one dim line. */
export function skippedLine(run: PreflightRun): string | undefined {
  const s = run.legs.filter((l) => l.state === "skipped");
  if (!s.length) return undefined;
  return s.length === 1 ? `${short(s[0]!.name)} didn't run here: ${lower(s[0]!.why ?? "")}` : `${s.length} didn't run here: ${s.map((l) => short(l.name)).join(", ")}`;
}

const lower = (s: string) => s.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());

/** The panel's one line before a run: "3 of 14 CI jobs look at this change". */
export function touchLine(st: CiLessonsState): string {
  const total = st.pipeline?.jobs.filter((j) => !j.off).length ?? 0;
  if (!st.files) return "No changes yet. Pre-flight looks at what you changed since main";
  if (!st.touched.length) return `No CI job looks at your ${st.files === 1 ? "change" : `${st.files} changed files`}`;
  return `${st.touched.length} of ${total} CI ${total === 1 ? "job looks" : "jobs look"} at this change`;
}

/** What the hosted comparison says, once it has something to say. */
export function hostedLine(run: PreflightRun | null): { text: string; tone: "ok" | "fail" | "info" } | undefined {
  const h = run?.hosted;
  if (!h) return undefined;
  if (h.state === "waiting") return { text: "Watching CI for this push", tone: "info" };
  if (h.state === "gave-up") return { text: "CI took too long to finish, so Shrike stopped watching", tone: "info" };
  if (h.matched) return { text: "CI agreed with the pre-flight", tone: "ok" };
  return h.first ? { text: `CI disagreed on ${short(h.first)}. Shrike is learning why`, tone: "fail" } : { text: "Nothing ran here to compare with CI", tone: "info" };
}
