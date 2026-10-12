import type { ActionView, BuildRail, BuildStage, Checkpoint, Finding, Flow, GitState, OptionsSession, Quest, Race, SdlcStage, SdlcState, ShrikeEvents } from "@shrike/schema";

// L1–L7: where the change in flight is, Spot → Watch. Pure computeSdlc (tested) plus a collector fed by the
// main→renderer event stream, so it sees every other engineer's state without importing their modules.
// Types only: the dev mock imports this file too.

export const STAGES: SdlcStage[] = ["spot", "understand", "fix", "prove", "review", "ship", "watch"];

export interface ReviewRecord {
  state: "running" | "passed" | "concerns" | "waived";
  at: number;
  summary: string;
  findings: Finding[];
  patchId?: string;
}

export interface SdlcInput {
  actions: ActionView[]; // oldest first; background views already left out
  findings: { at: number; summary: string; actionIds: string[] }[]; // agent FOUND IT reports
  checkpoints: Checkpoint[];
  flows: Flow[];
  tests: { ok: boolean; summary: string; at: number } | null;
  review: ReviewRecord | null;
  git: GitState | null;
  race: Race | null;
  hasTests?: boolean;
}

const HIDDEN: SdlcState = { actionId: null, stages: Object.fromEntries(STAGES.map((s) => [s, "idle"])) as SdlcState["stages"], detail: {} };

const clip = (s: string, n = 110) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** The current stage: the first one that isn't done or skipped. */
export function currentStage(s: SdlcState): SdlcStage | null {
  if (!s.actionId) return null;
  return STAGES.find((k) => s.stages[k] !== "done" && s.stages[k] !== "skipped") ?? null;
}

/** The same action by name: a click on a named button and the submit it records as (Enter, or el.click() in a focused form) are one. */
export function sameAction(a: string, b: string): boolean {
  const named = (l: string) => /^(?:Clicked|Submitted) (".+")$/.exec(l)?.[1];
  return a === b || (!!named(a) && named(a) === named(b));
}

/** A red re-run belongs to the break it re-runs: walk back over earlier breaks of the same thing with no green run between. */
function episodeStart(actions: ActionView[], last: ActionView | undefined): ActionView | undefined {
  if (!last) return undefined;
  let start = last;
  for (let k = actions.indexOf(last) - 1; k >= 0; k--) {
    const a = actions[k]!;
    if (!sameAction(a.label, last.label)) continue;
    if (a.status !== "error") break;
    start = a;
  }
  return start;
}

export function computeSdlc(i: SdlcInput): SdlcState {
  const flowRed = i.flows.filter((f) => f.lastRun && !f.lastRun.ok).sort((a, b) => b.lastRun!.at - a.lastRun!.at)[0];
  const broken = episodeStart(i.actions, i.actions.findLast((a) => a.status === "error"));
  const fromFlow = flowRed ? i.actions.find((a) => flowRed.lastRun!.actionIds.includes(a.id)) : undefined;
  const raced = i.race ? i.actions.find((a) => a.id === i.race!.actionId) : undefined;
  const anchor = [broken, fromFlow, raced].filter((a): a is ActionView => !!a).sort((a, b) => b.startMs - a.startMs)[0];
  if (!anchor) return HIDDEN;
  const t0 = anchor.startMs;
  const stages = { ...HIDDEN.stages };
  const detail: SdlcState["detail"] = {};

  // L1
  stages.spot = "done";
  const why = anchor.summary.steps.find((s) => !s.ok)?.text;
  detail.spot = clip(`${anchor.label} broke${why ? `: ${why}` : "."}`);

  // L2
  const found = i.findings.filter((f) => f.at >= t0).at(-1);
  if (found) {
    stages.understand = "done";
    detail.understand = clip(found.summary || "Your agent found the cause.");
  }

  // L3: a fix applied here, or one waiting in a race worktree
  const cps = i.checkpoints.filter((c) => c.createdAt >= t0);
  const fix = cps.findLast((c) => c.current);
  const racedFix = i.race?.actionId === anchor.id ? i.race.candidates.find((c) => c.patchId || c.state === "green") : undefined;
  const fixAt = fix?.createdAt ?? (racedFix ? t0 : undefined);
  if (fix) {
    stages.fix = "done";
    detail.fix = clip(`Applied: ${fix.label}.`);
  } else if (racedFix) {
    stages.fix = "done";
    detail.fix = clip(`A fix is ready in the ${racedFix.worktree} worktree.`);
  } else if (cps.length) detail.fix = "You rewound the fix. The code is back to how it was.";
  if (stages.fix === "done" && !found) stages.understand = "skipped"; // fixed without a FOUND IT (e.g. your own agent over MCP)

  // L4: the re-run, saved flows and unit tests after the fix
  const since = fixAt ?? t0;
  const rerun = i.actions.filter((a) => a.id !== anchor.id && sameAction(a.label, anchor.label) && a.startMs > since && a.complete).at(-1);
  const flowsAfter = i.flows.filter((f) => f.lastRun && f.lastRun.at > since);
  const redFlows = flowsAfter.filter((f) => !f.lastRun!.ok);
  const tests = i.tests && i.tests.at > since ? i.tests : null;
  if (!fix && !racedFix && rerun?.status === "ok") {
    // fixed by hand: nothing for the agent to understand or apply
    if (stages.understand !== "done") stages.understand = "skipped";
    stages.fix = "skipped";
    detail.fix = "Fixed outside Shrike's agent.";
  }
  const proveParts: string[] = [];
  // before any fix, another red run of the same thing is just the agent reproducing it
  const redRerun = rerun?.status === "error" && fixAt !== undefined;
  if (rerun && (redRerun || rerun.status !== "error")) proveParts.push(redRerun ? `${rerun.label} still breaks.` : `${rerun.label} works now.`);
  if (redFlows.length) proveParts.push(`${redFlows.map((f) => f.name).join(", ")} turned red.`);
  else if (flowsAfter.length) proveParts.push(`${flowsAfter.length === 1 ? "Your saved flow" : `All ${flowsAfter.length} saved flows`} passed.`);
  if (tests) proveParts.push(tests.summary);
  if (proveParts.length) detail.prove = clip(proveParts.join(" "), 220);
  if (!fix && racedFix) {
    // a race fix is proven by its own re-run in its worktree
    const all = i.race!.candidates;
    stages.prove = racedFix.state === "green" ? "done" : all.every((c) => c.state === "red" || c.state === "failed") ? "failed" : "idle";
    detail.prove =
      racedFix.state === "green" ? `It works in the ${racedFix.worktree} worktree. Use that fix to bring it over.`
      : stages.prove === "failed" ? (all.length === 1 ? `The fix didn't work in the ${racedFix.worktree} worktree. Your code wasn't touched.` : "None of the fixes worked. Your code wasn't touched.")
      : "Re-running each fix in its own worktree.";
  } else if (redRerun || redFlows.length || tests?.ok === false) stages.prove = "failed";
  else if (rerun?.status === "ok" || (fixAt !== undefined && (flowsAfter.length || tests))) stages.prove = "done";

  // L5
  // a review of the proposed patch, before Apply, counts for that fix
  const review = i.review && (i.review.at >= since || (fix && i.review.patchId === fix.patchId && i.review.at >= t0)) ? i.review : null;
  if (review) {
    stages.review = review.state === "running" ? "active" : review.state === "passed" ? "done" : review.state === "waived" ? "skipped" : "failed";
    detail.review = clip(review.summary || (review.state === "waived" ? "You skipped the review." : "Reviewing the fix."), 200);
  }

  // L6
  const ship = shipOf(i.git);
  if (ship) [stages.ship, detail.ship] = ship;

  // L7
  const watched = i.flows.filter((f) => f.watch);
  if (watched.length) {
    stages.watch = "done";
    const w = watched[0]!.watch!;
    detail.watch = clip(`Watching ${watched.map((f) => f.name).join(", ")} ${w.mode === "save" ? "on every save" : `every ${w.minutes ?? 10} minutes`}.`);
  }

  const out: SdlcState = { actionId: anchor.id, stages, detail, ...(review?.findings.length ? { review: review.findings } : {}), ...(tests ? { tests: tests.summary } : {}), ...(i.hasTests ? { hasTests: true } : {}) };
  // Merged (or nothing to ship and everything proven) and watched or nothing to watch: nothing in flight.
  const settled = (k: SdlcStage) => stages[k] === "done" || stages[k] === "skipped";
  const shipped = stages.ship === "done" || (stages.ship === "skipped" && settled("prove") && settled("review"));
  if (shipped && (settled("watch") || !i.flows.length)) return HIDDEN;
  const cur = currentStage(out);
  if (cur && stages[cur] === "idle") stages[cur] = "active";
  return out;
}

type Stage = SdlcState["stages"][SdlcStage];

/** L6/L14: the branch's pull request, in one state and one sentence. */
function shipOf(git: GitState | null): [Stage, string] | undefined {
  const pr = git?.pr;
  if (git && !git.isRepo) return ["skipped", "This folder isn't a git repo, so there's nothing to ship."];
  if (!pr) return undefined;
  const failing = pr.checks.filter((c) => c.state === "fail");
  const pending = pr.checks.filter((c) => c.state === "pending");
  return [
    pr.state === "merged" ? "done" : failing.length || pr.state === "closed" ? "failed" : "idle",
    pr.state === "merged" ? `PR #${pr.number} is merged.`
    : pr.state === "closed" ? `PR #${pr.number} was closed without merging.`
    : failing.length ? clip(`PR #${pr.number}: ${failing.map((c) => c.name).join(", ")} failed.`)
    : pending.length ? `PR #${pr.number} is open. ${pending.length} ${pending.length === 1 ? "check is" : "checks are"} still running.`
    : `PR #${pr.number} is open${pr.checks.length ? " and every check passed" : ""}.`,
  ];
}

// ---------- L8–L15: Build mode, Idea → Live, from the quest in flight ----------

export const BUILD_STAGES: BuildStage[] = ["idea", "plan", "design", "build", "prove", "review", "ship", "live"];

export interface BuildInput {
  quest: Quest | undefined;
  options: OptionsSession[];
  checkpoints: Checkpoint[];
  flows: Flow[];
  review: ReviewRecord | null;
  git: GitState | null;
  deployed?: { at: number; url?: string } | null; // L15 hook: a deploy integration reports here (none yet)
}

/** QB5: the quest that glows. A complete one stays a day so its Review, Ship and Live can finish on the rail. */
export function focused(list: Quest[], now = Date.now()): Quest | undefined {
  // ponytail: a complete quest leaves the rail after a day even if unshipped; upgrade: an explicit "done with this" action
  const open = list.filter((q) => q.state === "planning" || q.state === "active" || (q.state === "complete" && now - (q.completedAt ?? 0) < 86_400_000));
  return open.sort((a, b) => (b.focusAt ?? b.createdAt) - (a.focusAt ?? a.createdAt))[0];
}

export const currentBuildStage = (b: BuildRail): BuildStage | null => BUILD_STAGES.find((k) => b.stages[k] !== "done" && b.stages[k] !== "skipped") ?? null;

export function computeBuild(i: BuildInput): BuildRail | undefined {
  const q = i.quest;
  if (!q || q.state === "dropped") return undefined;
  const t0 = q.createdAt;
  const stages = Object.fromEntries(BUILD_STAGES.map((s) => [s, "idle"])) as BuildRail["stages"];
  const detail: BuildRail["detail"] = {};
  const live = q.objectives.filter((o) => o.state !== "dropped");

  // L8, L9
  stages.idea = "done";
  detail.idea = clip(q.issue?.imported ? `From issue #${q.issue.number}: ${q.title}` : q.title);
  if (q.state === "planning") {
    stages.plan = "active";
    detail.plan = q.waiting ? `Your agent's plan is waiting for you: ${live.length} objective${live.length === 1 ? "" : "s"}.` : "Your agent is planning this.";
  } else {
    stages.plan = "done";
    detail.plan = clip(`${live.length} objective${live.length === 1 ? "" : "s"}: ${live.map((o) => o.text).join(", ")}.`, 220);
  }

  // L10: options rounds asked for this quest (its plan run, or since it began)
  const asked = i.options.filter((s) => (q.runId && s.runId === q.runId) || s.at >= t0);
  const picked = asked.findLast((s) => s.state === "approved");
  const asking = asked.find((s) => s.state === "asking" || s.state === "working");

  // L11
  const cps = i.checkpoints.filter((c) => c.createdAt >= t0 && c.current);

  // L12
  const done = live.filter((o) => o.state === "done");
  const red = live.filter((o) => o.state === "failed");
  if (q.state !== "planning") {
    stages.prove = q.state === "complete" ? "done" : red.length ? "failed" : "idle";
    detail.prove =
      q.state === "complete" ? `Every objective passes: ${done.length} of ${live.length}.`
      : red.length ? clip(`${red.map((o) => o.text).join(", ")} broke on the last run.`)
      : live.some((o) => !o.flowId) ? `${done.length} of ${live.length} objectives pass. ${live.filter((o) => !o.flowId).length} still need a flow to prove them.`
      : `${done.length} of ${live.length} objectives pass.`;
  }

  if (picked) (stages.design = "done"), (detail.design = `You picked ${picked.approved?.join(" + ") ?? "an option"}.`);
  else if (asking) (stages.design = "active"), (detail.design = "Your agent is showing you options.");
  else if (cps.length || done.length) (stages.design = "skipped"), (detail.design = "Nothing visual to choose.");

  if (cps.length) (stages.build = "done"), (detail.build = clip(`${cps.length} change${cps.length === 1 ? "" : "s"} applied: ${cps.map((c) => c.label).join(", ")}.`, 200));
  else if (stages.prove === "done") (stages.build = "skipped"), (detail.build = "Nothing needed building: the flows already pass.");
  else if (done.length) (stages.build = "skipped"), (detail.build = `Nothing built here yet: ${done.length} objective${done.length === 1 ? " already works" : "s already work"}.`); // Prove leads while objectives pass

  // L13
  const review = i.review && i.review.at >= t0 ? i.review : null;
  if (review) {
    stages.review = review.state === "running" ? "active" : review.state === "passed" ? "done" : review.state === "waived" ? "skipped" : "failed";
    detail.review = clip(review.summary || (review.state === "waived" ? "You skipped the review." : "Reviewing the change."), 200);
  }

  // L14, L15
  const ship = shipOf(i.git);
  if (ship) [stages.ship, detail.ship] = ship;
  if (i.deployed) (stages.live = "done"), (detail.live = i.deployed.url ? `Live at ${i.deployed.url}.` : "Deployed.");
  else if (i.git?.pr?.state === "merged") (stages.live = "done"), (detail.live = "Merged. It goes live when your deploy picks it up.");
  else if (stages.ship === "skipped") stages.live = "skipped";

  const rail: BuildRail = { questId: q.id, title: q.title, stages, detail };
  const settled = (k: BuildStage) => stages[k] === "done" || stages[k] === "skipped";
  if (q.state === "complete" && settled("live") && settled("review")) return undefined; // shipped: nothing in flight
  const cur = currentBuildStage(rail);
  if (cur && stages[cur] === "idle") stages[cur] = "active";
  return rail;
}

// ---------- collector ----------

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;
const ZERO_TRACE = "0".repeat(32);

class Collector {
  private findings: SdlcInput["findings"] = [];
  private checkpoints: Checkpoint[] = [];
  private flows: Flow[] = [];
  private tests: SdlcInput["tests"] = null;
  private review: ReviewRecord | null = null;
  private git: GitState | null = null;
  private race: Race | null = null;
  private quests: Quest[] = []; // quests: L8–L15
  private options: OptionsSession[] = [];
  private actions: () => ActionView[] = () => [];
  private loadFlows: (() => Promise<Flow[]>) | undefined;
  private hasTests: () => boolean = () => false;
  private flowsLoaded = false;
  private loadQuests: (() => Promise<Quest[]>) | undefined;
  private questsLoaded = false;
  private emit: Emit | undefined;
  private last = JSON.stringify(HIDDEN);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** flows: the saved flows on disk, read once per project (later changes arrive as flows:update). */
  connect(o: { actions: () => ActionView[]; emit: Emit; flows?: () => Promise<Flow[]>; hasTests?: () => boolean; quests?: () => Promise<Quest[]> }): void {
    this.actions = o.actions;
    if (o.quests) this.loadQuests = o.quests;
    if (o.hasTests) this.hasTests = o.hasTests;
    this.emit = o.emit;
    this.loadFlows = o.flows;
  }

  /** Every main→renderer event passes through here (ipc.ts emit). */
  observe<K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]): void {
    switch (channel) {
      case "agent:step": {
        const s = payload as ShrikeEvents["agent:step"];
        if (s.kind !== "findings") return;
        this.findings = [...this.findings.slice(-20), { at: s.createdAt, summary: s.summary ?? s.text, actionIds: s.actionIds ?? [] }];
        break;
      }
      case "checkpoint:update":
        this.checkpoints = payload as Checkpoint[];
        break;
      case "flows:update":
        this.flows = payload as Flow[];
        this.flowsLoaded = true;
        break;
      case "git:update":
        this.git = payload as GitState;
        break;
      case "race:update":
        this.race = payload as Race;
        break;
      case "quests:update":
        this.quests = payload as Quest[];
        this.questsLoaded = true;
        break;
      case "options:update": {
        const o = payload as OptionsSession;
        this.options = [...this.options.filter((x) => x.id !== o.id).slice(-20), o];
        break;
      }
      case "actions:cleared":
        this.findings = [];
        this.review = null;
        this.tests = null;
        this.race = null;
        this.flowsLoaded = false;
        this.questsLoaded = false;
        break;
      case "actions:update":
        if (!this.questsLoaded && this.loadQuests) {
          this.questsLoaded = true;
          this.loadQuests().then((q) => ((this.quests = q), this.schedule()), () => (this.questsLoaded = false));
        }
        if (!this.flowsLoaded && this.loadFlows) {
          this.flowsLoaded = true;
          this.loadFlows().then((f) => ((this.flows = f), this.schedule()), () => (this.flowsLoaded = false));
        }
        break;
      default:
        return;
    }
    this.schedule();
  }

  noteTests(r: { ok: boolean; summary: string } | null): void {
    this.tests = r ? { ...r, at: Date.now() } : null;
    this.schedule();
  }

  noteReview(r: ReviewRecord | null): void {
    this.review = r;
    this.schedule();
  }

  waiveReview(): SdlcState {
    this.review = { state: "waived", at: Date.now(), summary: "You skipped the review.", findings: [] };
    return this.flush();
  }

  /** Forget everything (a new project). */
  reset(): void {
    this.findings = [];
    this.checkpoints = [];
    this.flows = [];
    this.tests = null;
    this.review = null;
    this.git = null;
    this.race = null;
    this.quests = [];
    this.options = [];
    this.flowsLoaded = false;
    this.schedule();
  }

  get(): SdlcState {
    const build = computeBuild({ quest: focused(this.quests), options: this.options, checkpoints: this.checkpoints, flows: this.flows, review: this.review, git: this.git });
    return { ...this.fix(), ...(build ? { build } : {}) };
  }

  private fix(): SdlcState {
    return computeSdlc({
      actions: this.actions().filter((a) => a.traceId !== ZERO_TRACE),
      findings: this.findings,
      checkpoints: this.checkpoints,
      flows: this.flows,
      tests: this.tests,
      review: this.review,
      git: this.git,
      race: this.race,
      hasTests: this.hasTests(),
    });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 120);
  }

  private flush(): SdlcState {
    clearTimeout(this.timer);
    const s = this.get();
    const json = JSON.stringify(s);
    if (json !== this.last) {
      this.last = json;
      this.emit?.("sdlc:update", s);
    }
    return s;
  }
}

export const sdlc = new Collector();
