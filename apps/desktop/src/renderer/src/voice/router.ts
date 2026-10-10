import type { VoiceChip } from "@shrike/schema";
import { BY_ID, type LiveContext } from "../actions/registry.ts";
import type { ExecState } from "./understand/executor.ts";
import { normalize, parse, stepTitle, understand, type PlanFn, type Step } from "./understand/index.ts";

// One turn (docs/16 §2.4, §2.7): grammar on live partials for safe actions, the cascade on the final words,
// plan-control words (yes, no, stop, undo, again) answered here. No length rule sends anything to the agent.
// Tested in router.test.ts.

export interface Echo {
  heard: string;
  echo?: string; // "Showing logs"
  tone: "live" | "ok" | "thinking" | "miss" | "card";
  chips?: VoiceChip[]; // "Did you mean" or the three nearest commands
}

export interface PlanRunner {
  readonly waiting: boolean; // the card is up
  readonly busy: boolean; // steps running
  readonly current: ExecState;
  start(steps: Step[], meta: { heard: string; source: "grammar" | "planner" }): Promise<ExecState>;
  confirm(how: "voice" | "click", words?: string): Promise<boolean>;
  cancel(): void;
  stop(): void;
  undo(): Promise<string | null>;
  repeat(): Promise<ExecState | null>;
}

export interface RouterDeps {
  context(): LiveContext;
  plan?: PlanFn; // the bundled planner; absent until it's downloaded
  exec: PlanRunner;
  /** The agent's own approval card (apply a fix): answer it like a click. Returns false when there's none. */
  approve(yes: boolean): string | null;
  agentBusy(): boolean;
  stopAgent(): void;
  help(): void;
  voiceOff(): void;
  show(e: Echo): void;
}

const STOP = new Set(["stop", "cancel"]);
const key = (steps: Step[]): string => JSON.stringify(steps);

/** What the executor's state says, for the caption. */
export function echoFor(heard: string, s: ExecState): Echo {
  const plan = s.plan;
  if (plan?.state === "needs_yes") {
    const risky = plan.steps.find((x) => x.state === "needs_yes");
    return { heard, tone: "card", echo: s.needs === "click-and-say" ? `Click ${risky?.title ?? "it"} on the card and say yes` : `Say yes to ${risky?.title.toLowerCase() ?? "go on"}` };
  }
  if (plan?.state === "failed") return { heard, tone: "miss", echo: s.echo ?? "That didn't work" };
  return { heard, tone: "ok", echo: s.echo ?? plan?.steps.map((x) => x.title).join(", ") };
}

export class Turn {
  readonly id: number;
  private deps: RouterDeps;
  private last = ""; // the parse of the previous partial
  private fired: string | null = null;
  private done = false;

  constructor(id: number, deps: RouterDeps) {
    this.id = id;
    this.deps = deps;
  }

  /** Acts early only for one safe step, and only when the same parse held for two partials in a row. */
  partial(text: string): void {
    if (this.done) return;
    const heard = text.trim();
    if (!heard) return;
    if (!this.fired) {
      const p = parse(heard, this.deps.context());
      const one = p.kind === "plan" && p.steps.length === 1 ? p.steps[0]! : null;
      const def = one && BY_ID.get(one.action);
      const k = one ? key([one]) : "";
      if (one && def?.risk === "safe" && !def.meta && one.action !== "agent.ask" && k === this.last && !this.deps.exec.waiting) {
        this.fired = k;
        void this.deps.exec.start([one], { heard, source: "grammar" }).then((s) => this.deps.show(echoFor(heard, s)));
        return;
      }
      this.last = k;
    }
    this.deps.show({ heard, tone: this.fired ? "ok" : "live", ...(this.fired ? { echo: this.deps.exec.current.echo ?? undefined } : {}) });
  }

  /** A yes to the card: the turn settles as soon as the plan runs (the card shows its steps), then echoes how it ended. */
  private async yes(heard: string): Promise<void> {
    const d = this.deps;
    const run = d.exec.confirm("voice", heard);
    if (d.exec.busy) d.show({ heard, tone: "ok", echo: "Going ahead" });
    const ok = await run;
    if (ok && d.exec.current.plan?.state === "stopped") return; // "stop" spoke for it
    d.show(ok ? echoFor(heard, d.exec.current) : { heard, tone: "card", echo: "Click it on the card to finish" });
  }

  async final(text: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    const heard = text.trim();
    const d = this.deps;
    if (!heard) return d.show({ heard, echo: "Didn't hear anything", tone: "miss" });
    const ctx = d.context();
    let g = parse(heard, ctx);
    const words = normalize(heard).words;

    // barge-in: "stop" with recognised words while something runs
    if (words.length && words.every((w) => STOP.has(w)) && (d.exec.busy || d.exec.waiting || d.agentBusy())) {
      d.exec.stop();
      if (d.agentBusy()) d.stopAgent();
      return d.show({ heard, echo: "Stopped", tone: "ok" });
    }
    const one = g.kind === "plan" && g.steps.length === 1 ? g.steps[0]!.action : "";
    switch (one) {
      case "confirm.yes": {
        if (d.exec.waiting) return this.yes(heard);
        const ok = d.approve(true);
        if (ok) return d.show({ heard, echo: ok, tone: "ok" });
        // nothing waits: "haan push kar do" is the command itself, which then gets its own card
        const rest = words.filter((w) => w !== "yes" && w !== "do").join(" ");
        const r = rest ? parse(rest, ctx) : null;
        if (r?.kind !== "plan") return d.show({ heard, echo: "Nothing to approve", tone: "ok" });
        g = r;
        break;
      }
      case "confirm.no":
        if (d.exec.waiting) return d.exec.cancel(), d.show({ heard, echo: "Cancelled. Nothing was sent", tone: "ok" });
        return d.show({ heard, echo: d.approve(false) ?? "Okay", tone: "ok" });
      case "plan.stop":
        // busy was caught above; a bare "stop" / "bas" never stops your app on its own, it offers it
        return d.show({ heard, echo: "Nothing running to stop", tone: "miss", chips: [{ label: "Stop the app", action: "app.stop" }] });
      case "plan.undo":
        return d.show({ heard, echo: (await d.exec.undo()) ?? "Nothing to undo", tone: "ok" });
      case "plan.repeat": {
        const s = await d.exec.repeat();
        return d.show(s ? echoFor(heard, s) : { heard, echo: "Nothing to do again", tone: "miss" });
      }
      case "voice.help":
        return d.help(), d.show({ heard, echo: "Here's what you can say", tone: "ok" });
      case "voice.off":
        return d.voiceOff(), d.show({ heard, echo: "Stopped listening", tone: "ok" });
    }
    if (this.fired) {
      // acted on a partial already; only a different command in the full words acts again
      if (g.kind === "plan" && key(g.steps) === this.fired) return d.show({ heard, echo: d.exec.current.echo ?? undefined, tone: "ok" });
    }
    // the card is up and the words name what it waits for ("push it"): that's a yes
    const card = d.exec.current.plan;
    if (d.exec.waiting && card && g.kind === "plan" && g.steps.every((s) => card.steps.some((c) => c.action === s.action && c.state === "needs_yes"))) return this.yes(heard);
    if (g.kind === "none" && d.plan) d.show({ heard, tone: "thinking" });
    const u = g.kind === "none" ? await understand(heard, ctx, d.plan) : g.kind === "plan" ? ({ kind: "plan", steps: g.steps, source: "grammar", ms: 0 } as const) : ({ kind: "close", options: g.options, ms: 0 } as const);
    if (u.kind === "close")
      return d.show({ heard, tone: "miss", echo: "Did you mean", chips: u.options.slice(0, 3).map((o): VoiceChip => ({ label: o.map(stepTitle).join(", "), action: o[0]!.action, plan: o })) });
    if (u.kind === "none") return d.show({ heard, tone: "miss", echo: u.why === "timeout" ? "That took too long" : "Didn't catch that", chips: u.chips });
    const s = await d.exec.start(u.steps, { heard, source: u.source });
    d.show(echoFor(heard, s));
  }
}
