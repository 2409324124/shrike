import type { StartPlan, StartReward, StartStep } from "@shrike/schema";

// R2/R3 + SL5: the live checklist. Claude drives it through plan_steps / update_step and the run tools; this keeps it honest.

export type StepState = StartStep["state"];
const MOVES: Record<StepState, StepState[]> = {
  pending: ["running", "done", "failed", "skipped", "waiting_approval"],
  running: ["done", "failed", "fixed", "waiting_approval", "skipped"],
  waiting_approval: ["running", "failed", "skipped", "pending"],
  failed: ["running", "fixed", "skipped", "failed", "waiting_approval"],
  fixed: ["running", "done", "failed", "waiting_approval"],
  done: ["running", "failed", "waiting_approval"],
  skipped: ["running", "pending", "waiting_approval"],
};
const FINISHED: StepState[] = ["done", "fixed", "skipped"];
const TAIL_LINES = 40;
const TAIL_BYTES = 6000;

export interface QuestEvents {
  plan(p: StartPlan): void;
  step(s: StartStep): void;
}

export type PlanInput = Pick<StartPlan, "source" | "services"> & { skillId?: string; steps: (Omit<StartStep, "state" | "id"> & { id?: string; state?: StepState })[] };

const slugId = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step";

export class Quest {
  plan: StartPlan;
  private failedOnce = new Set<string>(); // "fixed" needs a failure to fix
  private ev: QuestEvents;
  private flush = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(projectRoot: string, name: string, ev: QuestEvents) {
    this.ev = ev;
    this.plan = { projectRoot, name, source: "explored", steps: [], services: [], state: "planning" };
  }

  private emit(): void {
    this.ev.plan(structuredClone(this.plan));
  }

  set(p: Partial<Pick<StartPlan, "runId" | "say" | "recipes" | "source" | "skillId" | "error" | "places" | "tools">>): void {
    Object.assign(this.plan, p);
    this.emit();
  }

  get done(): boolean {
    return this.plan.state === "ready" || this.plan.state === "failed" || this.plan.state === "stopped";
  }

  /** plan_steps: replaces the checklist; steps that keep their id keep their state and output. */
  setPlan(input: PlanInput): StartPlan {
    if (this.done) throw new Error(`This start is ${this.plan.state}. Press Run to start again.`);
    if (!input.steps.length) throw new Error("A plan needs at least one step.");
    const old = new Map(this.plan.steps.map((s) => [s.id, s]));
    const used = new Set<string>();
    this.plan.steps = input.steps.map((s) => {
      let id = s.id?.trim() || slugId(s.title);
      for (let n = 2; used.has(id); n++) id = `${slugId(s.title)}-${n}`;
      used.add(id);
      const prev = old.get(id);
      const { id: _i, state, ...rest } = s;
      return { ...prev, ...rest, id, state: prev?.state ?? state ?? "pending" };
    });
    // A running or waiting step that was dropped from the plan still shows: it's real.
    for (const [id, s] of old) if (!used.has(id) && (s.state === "running" || s.state === "waiting_approval")) this.plan.steps.push(s);
    this.plan.source = input.source;
    this.plan.services = input.services;
    if (input.skillId) this.plan.skillId = input.skillId;
    this.plan.state = "running";
    this.emit();
    return this.plan;
  }

  step(id: string): StartStep {
    const s = this.plan.steps.find((x) => x.id === id);
    if (!s) throw new Error(`There's no step "${id}" in the plan. Steps: ${this.plan.steps.map((x) => x.id).join(", ") || "none yet (call plan_steps first)"}.`);
    return s;
  }

  /** A step for a command Claude ran without naming one (so nothing it does is invisible). */
  adhoc(title: string, kind: StartStep["kind"], command?: string): StartStep {
    let id = slugId(title);
    for (let n = 2; this.plan.steps.some((s) => s.id === id); n++) id = `${slugId(title)}-${n}`;
    const s: StartStep = { id, title, kind, state: "pending", ...(command ? { command } : {}) };
    const end = this.plan.steps.findIndex((x) => x.id === "skill"); // the closing skill step stays last
    this.plan.steps.splice(end < 0 ? this.plan.steps.length : end, 0, s);
    if (this.plan.state === "planning") this.plan.state = "running";
    this.emit();
    return s;
  }

  update(id: string, patch: Partial<Omit<StartStep, "id">>): StartStep {
    const s = this.step(id);
    const to = patch.state;
    if (to && to !== s.state) {
      if (!MOVES[s.state].includes(to)) throw new Error(`Step "${id}" is ${s.state}; it can't go to ${to}.`);
      if (to === "fixed" && !this.failedOnce.has(id)) throw new Error(`Step "${id}" never failed, so there's nothing to mark fixed. Mark it done.`);
      if (to === "fixed" && !(patch.fix ?? s.fix)?.trim()) throw new Error("Say what you changed in fix, in plain words (\"Used uv run uvicorn\").");
      if (FINISHED.includes(to) && (patch.ask ?? s.ask)) throw new Error(`Step "${id}" is waiting for the user.`);
    }
    if (to === "failed") this.failedOnce.add(id);
    Object.assign(s, patch);
    if (to && to !== "waiting_approval" && patch.ask === undefined) delete s.ask;
    if (to === "running" && patch.detail === undefined) delete s.detail;
    this.ev.step(structuredClone(s));
    return s;
  }

  /** Live output into a step, as a tail, sent at most every 150ms. */
  output(id: string, chunk: string): void {
    const s = this.plan.steps.find((x) => x.id === id);
    if (!s) return;
    const text = (s.output ?? "") + chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
    s.output = text.split("\n").slice(-TAIL_LINES).join("\n").slice(-TAIL_BYTES);
    if (this.flush.has(id)) return;
    this.flush.set(id, setTimeout(() => {
      this.flush.delete(id);
      this.ev.step(structuredClone(s));
    }, 150));
  }

  /** What still stands between here and "ready" (the skill step is the agent's last job, so it may be open). */
  unfinished(except: string[] = []): StartStep[] {
    return this.plan.steps.filter((s) => !FINISHED.includes(s.state) && !except.includes(s.id));
  }

  reward(r: StartReward): void {
    const list = (this.plan.rewards ??= []);
    const i = list.findIndex((x) => x.skillId === r.skillId && x.kind === r.kind);
    if (i >= 0) list[i] = r;
    else list.push(r);
    this.emit();
  }

  /** The user stopped an app that was up: the plan says so, so nothing reads it as still running. */
  stopped(): void {
    if (this.plan.state !== "ready") return;
    this.plan.state = "stopped";
    this.emit();
  }

  finish(state: "ready" | "failed" | "stopped", error?: string): void {
    if (this.done) return;
    for (const t of this.flush.values()) clearTimeout(t);
    this.flush.clear();
    this.plan.state = state;
    if (error) this.plan.error = error;
    if (state !== "ready") for (const s of this.plan.steps) if (s.state === "running" || s.state === "waiting_approval") Object.assign(s, { state: state === "stopped" ? "skipped" : "failed", ask: undefined });
    this.emit();
  }
}
