import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJson } from "./state-file.ts";
import type { AgentRunInfo, AgentStep, AgentUsage, ChainDef, ChainEvent, ChainRun, ChainStep, ChainsState, GitState, RunStatus, ShrikeEvents, UpNextItem, UpNextWhen } from "@shrike/schema";
import { afterRun, afterScore, missedWhy, nextUp, onRelaunch, overBudget, pauseOnStop, moveItem, tidy, whenLabel, withCritique, type LastRun, type Next } from "../renderer/src/chains/logic.ts";

// P: prompt chains. Up next (P1), schedules (P2) and conditional chains (P3) as one state machine that follows the agent's own
// events (ipc.ts feeds observe()) and starts runs the way the UI does. Electron-free so it tests with node:test; ipc.ts wires deps.

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;

export interface ChainDeps {
  emit: Emit;
  file(): string | undefined; // where this project's up next lives (userData), none without a project
  /** Fire a prompt: main continues `after`'s session; branch forks it. */
  start(prompt: string, o: { target: UpNextItem["target"]; after?: AgentRunInfo }): Promise<AgentRunInfo>;
  /** The critique skill on a finished run, in a separate one-shot call. Null when it gave no score or was aborted (Stop chain kills it). */
  critique(run: AgentRunInfo, rubric: string, o: { signal: AbortSignal; onTokens(total: number): void }): Promise<{ score: number; reason: string } | null>;
  stop(runId: string): void;
  outcome?(chainId: string, ok: boolean, why: string): void; // P4: the skills outcome gate (a use and its drafts kept only when reached)
  now?(): number;
}

const MAX_ITEMS = 40;
const TICK_MS = 5000;

const isMain = (r: AgentRunInfo) => !r.parentRunId && !r.aside;
const isLive = (c: ChainRun | null): c is ChainRun => !!c && (c.state === "running" || c.state === "critiquing" || c.state === "waiting");
const cut = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function createChains(deps: ChainDeps) {
  const now = () => deps.now?.() ?? Date.now();
  let file: string | undefined;
  let items: UpNextItem[] = [];
  let paused = false;
  let chain: ChainRun | null = null;
  let loaded: Promise<void> | undefined;
  let ready = false; // this project's file is read: saving before that would overwrite it
  let current: AgentRunInfo | undefined; // the main run going now (this project's)
  let last: AgentRunInfo | undefined; // the newest main run that ended (this project's)
  const owner = new Map<string, string | undefined>(); // run id -> the project file open when it started: up next never follows another project's run
  const stopping = new Set<string>(); // runs the chain stopped itself (not "you stopped the run")
  let critAbort: AbortController | undefined; // the critique going now
  let crit = 0; // tokens the critic spent on this chain
  let firing = false;
  const verified = new Map<string, boolean>(); // run id -> its done step said "Fixed and verified"
  const usage = new Map<string, number>(); // run id -> tokens
  let app = false;
  let ci = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const state = (): ChainsState => ({ items: tidy(items), paused, chain });
  const say = (kind: ChainEvent["kind"], text: string, extra: Partial<ChainEvent> = {}) => deps.emit("chains:event", { kind, text, at: now(), ...extra });
  const push = () => {
    deps.emit("chains:update", state());
    void save();
  };

  let saving = Promise.resolve();
  /** One write at a time, to the project open now, with the state as it is now. */
  const save = () => {
    const f = file;
    if (!f || !ready) return;
    const body = JSON.stringify({ items: tidy(items).slice(-MAX_ITEMS), paused, chain });
    saving = saving.then(() => write(f, body));
  };

  async function write(f: string, body: string): Promise<void> {
    const tmp = `${f}.${randomBytes(3).toString("hex")}.tmp`;
    try {
      await mkdir(dirname(f), { recursive: true });
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, f);
    } catch {} // ponytail: a failed save loses only the queue's newest change; the next change writes it again
  }

  /** This project's up next and last chain, read once per project (P2: they survive a restart). Another project's runs are forgotten. */
  function ensure(): Promise<void> {
    const f = deps.file();
    if (f === file && loaded) return loaded;
    if (isLive(chain)) (critAbort?.abort(), end("You opened another project.", "stopped", false)); // saved to the project it ran in; its run keeps going there
    file = f;
    ready = false;
    items = [];
    paused = false;
    chain = null;
    if (current && owner.get(current.id) !== f) current = undefined;
    if (last && owner.get(last.id) !== f) last = undefined;
    loaded = (async () => {
      if (!f) return;
      try {
        const v = ((await readJson(f)) ?? {}) as { items?: unknown; paused?: unknown; chain?: unknown };
        const list = Array.isArray(v.items) ? (v.items as UpNextItem[]).filter((i) => i && typeof i.id === "string" && typeof i.prompt === "string" && i.when && typeof i.when.on === "string") : [];
        items = onRelaunch(list, now());
        paused = v.paused === true;
        const c = v.chain as ChainRun | null | undefined;
        if (c && typeof c === "object" && c.def && Array.isArray(c.steps)) {
          chain = c;
          if (isLive(c)) {
            Object.assign(c, { state: "stopped", why: "Shrike closed while the chain ran.", endedAt: now() });
            say("stopped", "Chain stopped. Shrike closed while it ran.");
          }
        }
        for (const m of items.filter((i) => i.state === "missed")) say("missed", `Missed: ${cut(m.prompt)}. ${missedWhy(m, now())}`);
      } catch {} // nothing saved yet
      finally {
        if (file === f) ready = true;
      }
    })();
    return loaded;
  }

  /** The chain's tokens: its runs' and the critic's. */
  function tally(): void {
    if (!chain) return;
    const ids = new Set(chain.steps.flatMap((s) => (s.runId ? [s.runId] : [])));
    chain.tokens = [...ids].reduce((a, id) => a + (usage.get(id) ?? 0), 0) + crit;
  }

  /** Kill what the chain has going: its run and its critique. */
  function halt(): void {
    critAbort?.abort();
    critAbort = undefined;
    const id = chain?.steps.at(-1)?.runId;
    if (id && current?.id === id) (stopping.add(id), deps.stop(id));
  }

  /** The loop guard, checked while a run or a critique works too: over budget stops it then and there. */
  function guard(): boolean {
    if (!isLive(chain)) return false;
    const over = overBudget(chain, now());
    if (!over) return false;
    halt();
    end(over, "stopped");
    return true;
  }

  const busy = () => firing || !!current || chain?.state === "critiquing";

  function lastGate(): LastRun | undefined {
    return last ? { status: last.status, verified: verified.get(last.id) ?? false } : undefined;
  }

  async function fire(prompt: string, target: UpNextItem["target"]): Promise<AgentRunInfo | undefined> {
    firing = true;
    try {
      return await deps.start(prompt, { target, ...(last ? { after: last } : {}) });
    } finally {
      firing = false;
    }
  }

  // ---- P1/P2 up next ----

  async function tick(): Promise<void> {
    await ensure();
    if (guard() || busy()) return;
    if (chain?.state === "waiting") return void startNode("prompt", chain.def.prompt);
    if (chain?.state === "running" || paused) return;
    const pick = nextUp(items, { now: now(), last: lastGate(), app, ci });
    if (!pick) return;
    const item = pick.item;
    if (!pick.fire) {
      item.state = "skipped";
      item.note = pick.why;
      say("skipped", `Skipped: ${cut(item.prompt)}. ${pick.why ? pick.why[0]!.toUpperCase() + pick.why.slice(1) : ""}.`);
      push();
      return tick();
    }
    item.state = "running";
    push();
    say("next", `Next up: ${cut(item.prompt)}`);
    try {
      const info = await fire(item.prompt, item.target);
      if (info) {
        item.runId = info.id;
        if (info.status !== "running") item.state = "done";
      } else item.state = "skipped";
      if (item.state !== "running") queueMicrotask(() => void tick());
    } catch (err) {
      item.state = "skipped";
      item.note = err instanceof Error ? err.message : String(err);
      say("skipped", `Couldn't start: ${cut(item.note, 80)}`);
    }
    push();
  }

  // ---- P3 chains ----

  function end(why: string, kind: "complete" | "stopped" = "complete", next = true): void {
    if (!chain) return;
    critAbort = undefined;
    chain.state = kind === "complete" ? "done" : "stopped";
    chain.why = why;
    chain.endedAt = now();
    const stepAt = chain.steps.at(-1);
    if (stepAt && !stepAt.took) stepAt.took = "stop";
    const ok = stepAt?.node !== "failed" && (chain.steps.some((s) => s.score !== undefined && s.score >= chain!.def.threshold) || (chain.def.check !== "critique" && stepAt?.status === "done"));
    say(kind, kind === "complete" ? `Chain complete. ${why.replace(/\s*Chain complete\.?$/, "")}`.trim() : why, { ...(stepAt?.score !== undefined ? { score: stepAt.score } : {}), ok: kind === "complete" && ok });
    if (chain.def.id) deps.outcome?.(chain.def.id, kind === "complete" && ok, why);
    push();
    if (next) void tick();
  }

  async function startNode(node: ChainStep["node"], prompt: string): Promise<void> {
    if (!chain) return;
    const over = overBudget(chain, now());
    if (over) return end(over, "stopped");
    const prev = chain.steps.at(-1);
    const text = node === "below" ? withCritique(prompt, prev) : prompt;
    const step: ChainStep = { node, prompt: text };
    chain.steps.push(step);
    chain.state = "running";
    push();
    try {
      const info = await fire(text, "main");
      if (!info) return end("Couldn't start the next step.", "stopped");
      step.runId = info.id;
      push();
      if (info.status !== "running" && last?.id === info.id) chainRunEnded(info); // it ended before we knew its id
    } catch (err) {
      end(`Couldn't start the next step: ${err instanceof Error ? err.message : String(err)}`, "stopped");
    }
  }

  async function take(next: Next): Promise<void> {
    if (!chain) return;
    const step = chain.steps.at(-1)!;
    if (next.go === "stop") return end(next.why, step.status === "stopped" ? "stopped" : "complete");
    if (next.go === "critique") return critique(step);
    step.took = next.go;
    await startNode(next.go, next.prompt);
  }

  async function critique(step: ChainStep): Promise<void> {
    if (!chain) return;
    const run = last;
    const over = overBudget(chain, now());
    if (over) return end(over, "stopped");
    if (!run || run.id !== step.runId) return end("Lost track of the run to score.", "stopped");
    chain.state = "critiquing";
    push();
    const me = chain;
    const ac = (critAbort = new AbortController());
    const base = crit;
    const onTokens = (n: number) => {
      if (chain !== me || ac.signal.aborted) return;
      crit = base + n;
      tally();
      if (!guard()) deps.emit("chains:update", state());
    };
    const r = await deps.critique(run, chain.def.rubric, { signal: ac.signal, onTokens }).catch(() => null);
    if (chain !== me || chain.state !== "critiquing" || ac.signal.aborted) return; // stopped meanwhile
    critAbort = undefined;
    chain.round++;
    if (!r) return end("The critique didn't give a score.", "stopped");
    step.score = r.score;
    step.reason = r.reason;
    const next = afterScore(chain.def, r.score, chain.round);
    const word = next.go === "below" ? "polishing" : next.go === "pass" ? "next step" : "done";
    say("critique", `Critique ${r.score} / 10 → ${word}`, { score: r.score });
    chain.state = "running";
    await take(next);
  }

  function chainRunEnded(info: AgentRunInfo): boolean {
    const step = chain && chain.state === "running" ? chain.steps.at(-1) : undefined;
    if (!step || step.runId !== info.id) return false;
    step.status = info.status;
    step.verified = verified.get(info.id) ?? false;
    void take(afterRun(chain!.def, step));
    return true;
  }

  // ---- events ----

  function onStatus(info: AgentRunInfo): void {
    if (!owner.has(info.id)) owner.set(info.id, deps.file());
    if (owner.size > 400) owner.delete(owner.keys().next().value!);
    if (owner.get(info.id) !== deps.file()) return; // another project's run: nothing here follows it
    tally();
    const item = items.find((i) => i.runId === info.id && i.state === "running");
    if (!isMain(info)) {
      if (item && info.status !== "running") (item.state = "done"), push(); // a branch item: done when the branch is
      return;
    }
    if (info.status === "running") {
      current = info;
      return;
    }
    if (current && current.id !== info.id && current.status === "running") return; // an older run's late status
    current = undefined;
    last = info;
    if (item) item.state = "done";
    const ours = stopping.delete(info.id);
    if (!ours && chainRunEnded(info)) return; // a run the chain halted itself (budget, Stop chain): end() already said why
    if (info.status === "stopped" && !ours && !paused && pauseOnStop(items)) {
      paused = true;
      say("paused", "Up next paused. You stopped the run.");
    }
    push();
    void tick();
  }

  return {
    state: async (): Promise<ChainsState> => (await ensure(), state()),
    observe<K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]): void {
      if (channel === "agent:status") return onStatus(payload as AgentRunInfo);
      if (channel === "agent:step") {
        const s = payload as AgentStep;
        if (s.kind === "done") verified.set(s.runId, s.summary === "Fixed and verified");
        if (verified.size > 200) verified.delete(verified.keys().next().value!);
        return;
      }
      if (channel === "agent:usage") {
        const u = payload as AgentUsage;
        usage.set(u.runId, u.inputTokens + u.outputTokens);
        if (usage.size > 200) usage.delete(usage.keys().next().value!);
        if (isLive(chain) && chain.steps.some((s) => s.runId === u.runId)) {
          tally();
          if (!guard()) deps.emit("chains:update", state());
        }
        return;
      }
      if (channel === "run:status") {
        app = (payload as RunStatus).state === "running";
        if (app) void tick();
        return;
      }
      if (channel === "git:update") {
        const checks = (payload as GitState).pr?.checks ?? [];
        ci = checks.length > 0 && checks.every((c) => c.state === "pass" || c.state === "skipped");
        if (ci) void tick();
        return;
      }
      if (channel === "project:opened") void ensure().then(() => (deps.emit("chains:update", state()), tick()));
    },
    async queue(prompt: string, when: UpNextWhen, target: UpNextItem["target"] = "main"): Promise<ChainsState> {
      await ensure();
      if (!file) throw new Error("Open a project first.");
      const item: UpNextItem = { id: randomBytes(6).toString("hex"), prompt: prompt.trim(), when, target, state: "waiting", createdAt: now() };
      items = tidy([...items, item]);
      say("queued", `Queued: ${cut(item.prompt)} · ${whenLabel(when, now())}`);
      push();
      void tick();
      return state();
    },
    async edit(id: string, patch: { prompt?: string; when?: UpNextWhen; target?: UpNextItem["target"] } | null): Promise<ChainsState> {
      await ensure();
      const it = items.find((i) => i.id === id);
      if (!it) throw new Error("That prompt isn't in up next anymore.");
      if (patch === null) items = items.filter((i) => i !== it);
      else {
        if (it.state === "running") throw new Error("It's running already.");
        Object.assign(it, { ...(patch.prompt?.trim() ? { prompt: patch.prompt.trim() } : {}), ...(patch.when ? { when: patch.when } : {}), ...(patch.target ? { target: patch.target } : {}) });
      }
      push();
      void tick();
      return state();
    },
    async move(id: string, index: number): Promise<ChainsState> {
      await ensure();
      items = moveItem(items, id, index);
      push();
      return state();
    },
    async pause(p: boolean): Promise<ChainsState> {
      await ensure();
      paused = p;
      push();
      if (!p) void tick();
      return state();
    },
    async answerMissed(id: string, run: boolean): Promise<ChainsState> {
      await ensure();
      const it = items.find((i) => i.id === id && i.state === "missed");
      if (!it) throw new Error("That prompt isn't waiting on you anymore.");
      if (run) Object.assign(it, { state: "waiting", when: { on: "time", at: now() } });
      else Object.assign(it, { state: "skipped", note: "You skipped it" });
      push();
      void tick();
      return state();
    },
    async startChain(def: ChainDef): Promise<ChainsState> {
      await ensure();
      if (isLive(chain)) throw new Error("A chain is running already. Stop it first.");
      crit = 0;
      chain = { id: randomBytes(6).toString("hex"), def, state: "waiting", steps: [], round: 0, tokens: 0, startedAt: now() };
      if (!def.prompt.trim()) {
        // works on the run going now, or the last one
        const on = current ?? last;
        if (!on || !isMain(on)) {
          chain = null;
          throw new Error("Ask your agent something first, or give the chain a prompt.");
        }
        chain.steps.push({ node: "prompt", prompt: on.goal, runId: on.id });
        chain.state = "running";
        push();
        if (!current) chainRunEnded(on);
        return state();
      }
      push();
      void tick();
      return state();
    },
    async stopChain(): Promise<ChainsState> {
      if (!isLive(chain)) return state();
      halt();
      end("You stopped the chain.", "stopped");
      return state();
    },
    /** P2: times come due on their own. */
    startTimer(): void {
      timer ??= setInterval(() => void tick().catch(() => {}), TICK_MS);
      timer.unref?.();
    },
    dispose(): void {
      clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}

export type Chains = ReturnType<typeof createChains>;

/** P3: what the critic sees: the critique skill, the rubric, and the run (its ask, what it said, its answer and its diff). */
export function critiqueAsk(o: { skill: string; rubric: string; goal: string; steps: readonly AgentStep[]; diff: string }): string {
  const said = o.steps
    .filter((s) => s.kind === "message" || s.kind === "findings" || s.kind === "error" || s.kind === "done")
    .slice(-30)
    .map((s) => `- ${(s.summary ?? s.text).replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const answer = o.steps.findLast((s) => s.kind === "done")?.detail ?? "";
  return [
    "Score this run from 0 to 10. Only read: don't change any file and don't propose patches.",
    o.skill.trim() && `<playbook>\n${o.skill.trim()}\n</playbook>`,
    `What a 10 looks like: ${o.rubric.trim()}`,
    `<ask>\n${o.goal.slice(0, 4000)}\n</ask>`,
    `<steps>\n${said || "(none)"}\n</steps>`,
    `<answer>\n${answer.slice(0, 4000) || "(none)"}\n</answer>`,
    `<diff>\n${o.diff.slice(0, 16_000) || "(no code changed)"}\n</diff>`,
    "End with exactly two lines:\nSCORE: <number>/10\nWHY: <one sentence on the biggest gap>",
  ]
    .filter(Boolean)
    .join("\n\n");
}
