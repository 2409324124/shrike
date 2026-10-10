import type { VoicePlan, VoicePlanStep, VoiceRisk } from "@shrike/schema";
import { BY_ID } from "../../actions/registry.ts";
import { normalize } from "./normalize.ts";
import { stepTitle, type Step } from "./parse.ts";

// The plan executor (docs/16 §2.6). Steps run in order and stop at the first failure.
// Any outward or destructive step puts the whole plan on the card first: nothing runs until yes.
// Destructive needs a click and a spoken repeat ("yes, discard"). Undoable steps hand back an undo.
// Pure: the real bindings come from actions/run.ts. Tested in executor.test.ts and by the eval.

export interface PlannedStep extends Step {
  added?: boolean; // a precondition rule put it there, not the person
  detail?: string;
}

export interface StepResult {
  echo: string; // "Staged 4 files"
  undo?: () => Promise<unknown> | unknown;
}

export interface Bindings {
  /** Does one step; throws an Error with plain words when it can't. */
  run(step: PlannedStep): Promise<StepResult>;
  /** Precondition repair by rules ("push" with uncommitted changes gets a Commit first). Returns the full list. */
  pre(steps: PlannedStep[], heard: string): PlannedStep[];
}

export interface ExecState {
  plan: VoicePlan | null;
  /** What the card waits for: a yes (outward), a click and a spoken repeat (destructive). */
  needs: null | "yes" | "click-and-say";
  echo: string | null; // "Staged 4 files, pushed"
  undoUntil: number | null; // the Undo toast shows until then
}

const risk = (a: string): VoiceRisk => BY_ID.get(a)?.risk ?? "safe";
const gated = (r: VoiceRisk) => r === "outward" || r === "destructive";
let seq = 0;

export const UNDO_MS = 5000;

export class Executor {
  private b: Bindings;
  private emit: (s: ExecState) => void;
  private state: ExecState = { plan: null, needs: null, echo: null, undoUntil: null };
  private steps: PlannedStep[] = [];
  private undos: StepResult["undo"][] = [];
  private clicked = false;
  private said = false;
  private gen = 0; // a run whose gen is stale stops touching state (stop, cancel or a newer plan)
  private last: { steps: Step[]; heard: string; source: VoicePlan["source"] } | null = null;
  private running: Promise<void> | null = null;

  constructor(b: Bindings, emit: (s: ExecState) => void) {
    this.b = b;
    this.emit = emit;
  }

  get current(): ExecState {
    return this.state;
  }
  get waiting(): boolean {
    return this.state.plan?.state === "needs_yes";
  }
  get busy(): boolean {
    return this.state.plan?.state === "running";
  }

  private set(p: Partial<ExecState>): void {
    this.state = { ...this.state, ...p };
    this.emit(this.state);
  }

  private setStep(i: number, s: Partial<VoicePlanStep>): void {
    const plan = this.state.plan;
    if (!plan) return;
    this.set({ plan: { ...plan, steps: plan.steps.map((x, j) => (j === i ? { ...x, ...s } : x)) } });
  }

  /** A new plan. Runs at once unless a step is outward or destructive; then the card waits. */
  async start(steps: Step[], meta: { heard: string; source: VoicePlan["source"] }): Promise<ExecState> {
    if (this.busy) this.stop();
    this.last = { steps, heard: meta.heard, source: meta.source };
    this.steps = this.b.pre(steps.map((s) => ({ ...s })), meta.heard);
    this.undos = [];
    this.clicked = this.said = false;
    this.gen++;
    const id = `vp${++seq}`;
    const plan: VoicePlan = {
      id,
      heard: meta.heard,
      source: meta.source,
      state: "running",
      steps: this.steps.map((s, i) => ({ id: `${id}-${i}`, action: s.action, title: stepTitle(s), risk: risk(s.action), state: "waiting", ...(s.detail ? { detail: s.detail } : {}), ...(s.added ? { added: true } : {}) })),
    };
    const hold = plan.steps.some((s) => gated(s.risk));
    const destructive = plan.steps.some((s) => s.risk === "destructive");
    if (hold) {
      this.set({ plan: { ...plan, state: "needs_yes", steps: plan.steps.map((s) => (gated(s.risk) ? { ...s, state: "needs_yes" } : s)) }, needs: destructive ? "click-and-say" : "yes", echo: null, undoUntil: null });
      return this.state;
    }
    this.set({ plan, needs: null, echo: null, undoUntil: null });
    await this.go();
    return this.state;
  }

  /**
   * The card's yes. Outward: a spoken yes, Enter or a click. Destructive: a click and a spoken repeat that names it.
   * Returns whether the plan now runs.
   */
  async confirm(how: "voice" | "click", words = ""): Promise<boolean> {
    if (!this.waiting || !this.state.plan) return false;
    if (how === "click") this.clicked = true;
    if (how === "voice") {
      const heard = new Set(normalize(words).words);
      const names = this.state.plan.steps.filter((s) => s.risk === "destructive").flatMap((s) => BY_ID.get(s.action)?.say.join(" ").replace(/[[\]{}|]/g, " ").split(" ").filter((w) => w.length > 3) ?? []);
      this.said = names.some((w) => heard.has(w));
      if (this.state.needs === "yes") this.said = true;
    }
    if (this.state.needs === "click-and-say" && !(this.clicked && this.said)) return false;
    this.set({ plan: { ...this.state.plan, state: "running", steps: this.state.plan.steps.map((s) => (s.state === "needs_yes" ? { ...s, state: "waiting" } : s)) }, needs: null });
    await this.go();
    return true;
  }

  /** "No" on the card: nothing ran, nothing runs. */
  cancel(echo = "Cancelled"): void {
    const plan = this.state.plan;
    if (!plan || (plan.state !== "needs_yes" && plan.state !== "running")) return;
    this.gen++;
    this.set({ plan: { ...plan, state: "stopped", steps: plan.steps.map((s) => (s.state === "done" ? s : { ...s, state: "skipped" })) }, needs: null, echo });
  }

  /** "Stop": pending steps are skipped; done steps stay done (and undoable). */
  stop(): void {
    this.cancel("Stopped");
  }

  /** "Undo that": the undoable steps of the last plan, newest first. */
  async undo(): Promise<string | null> {
    const fns = this.undos.filter(Boolean).reverse();
    if (!fns.length) return null;
    this.undos = [];
    for (const f of fns) await f!();
    this.set({ undoUntil: null, echo: "Undone" });
    return "Undone";
  }

  /** "Again": the last plan through the same gates. */
  async repeat(): Promise<ExecState | null> {
    return this.last ? this.start(this.last.steps, { heard: this.last.heard, source: this.last.source }) : null;
  }

  private async go(): Promise<void> {
    const run = (async () => {
      const gen = this.gen;
      const steps = this.steps;
      const echoes: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        if (gen !== this.gen) return;
        this.setStep(i, { state: "running" });
        try {
          const r = await this.b.run(steps[i]!);
          if (gen !== this.gen) return;
          const risk = this.state.plan?.steps[i]?.risk;
          if (risk === "outward" || risk === "destructive") this.undos = []; // nothing before a push can be undone once it left the Mac
          else this.undos.push(r.undo);
          echoes.push(r.echo);
          this.setStep(i, { state: "done", ...(r.echo ? { detail: r.echo } : {}) });
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          if (gen !== this.gen) return;
          this.setStep(i, { state: "failed", error: why });
          for (let j = i + 1; j < steps.length; j++) this.setStep(j, { state: "skipped" });
          this.set({ plan: { ...this.state.plan!, state: "failed" }, echo: why });
          return;
        }
      }
      const canUndo = this.undos.some(Boolean);
      this.set({ plan: { ...this.state.plan!, state: "done" }, echo: echoes.join(", "), undoUntil: canUndo ? Date.now() + UNDO_MS : null });
    })();
    this.running = run;
    await run;
    if (this.running === run) this.running = null;
  }
}

/** One plan through a fresh executor with no yes: what the eval uses to prove nothing outward runs without the card. */
export async function runPlan(steps: Step[], meta: { heard: string; source: VoicePlan["source"] }, b: Bindings, emit: (s: ExecState) => void): Promise<ExecState> {
  return new Executor(b, emit).start(steps, meta);
}
