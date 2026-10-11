import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectInfo, ShrikeEvents, StartAsk, StartCategory, StartReward, StartStep } from "@shrike/schema";
import type { PlanArgs, StartHost } from "@shrike/mcp-server";
import { plannedPlaces } from "@shrike/scanner";
import { NO_TTY_ENV, responds, type RunEnv, type Runner } from "../runner.ts";
import type { SkillDirs } from "../skills.ts";
import { killTree, spawnShell } from "../platform.ts";
import { CATEGORY_WORDS, decide, judge, projectScript, rememberable, type Judgement } from "./policy.ts";
import { Quest } from "./quest.ts";
import type { Recipe } from "./recipes.ts";
import { proposeLesson, runSkillId, runSkillPath, saveRunSkill, type SaveResult } from "./runskill.ts";

// R1–R8: one start, driven by Claude. This is what Shrike's start tools do; Shrike runs every command itself.

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;
export type StartRunner = Pick<Runner, "startService" | "stopService" | "services" | "serviceTail" | "markService" | "markRunning" | "markFailed"> & Partial<Pick<Runner, "offsetFor">>;
export type StartAnswer = { allow: boolean; always?: boolean; values?: Record<string, string> };

export interface SessionDeps {
  project: ProjectInfo;
  runner: StartRunner;
  runEnv(): Promise<RunEnv>;
  skillDirs(): SkillDirs & { project: string };
  emit: Emit;
  recipes: Recipe[];
  lessons: Recipe[];
  always: Set<StartCategory>; // "Always allow for this project"
  saveAlways?(categories: StartCategory[]): void;
  pageCheck?(url: string): Promise<{ title: string; text: string } | undefined>; // the page as the app pane shows it
  notify?(title: string, body: string): void;
  pushSkills?(): Promise<void>; // skills:update + the System's rescan
  outcome?(o: { ok: boolean; runIds: string[]; skillIds: string[]; why?: string }): Promise<StartReward[]>; // the gate: drafts apply only on a verified ready (evolve-on-outcome)
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_RESULT = 40_000;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/i;
const KIND_OF: Partial<Record<StartCategory, StartStep["kind"]>> = { install: "install", build: "build", service: "service", health: "health", env: "env", inspect: "check" };
const ENV_NAME = /^\.env(\.[\w.-]+)?$/;
const TEMPLATE = /\.(example|sample|template|defaults?)$/;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Claude Code gives up on a tool call after about 5 minutes, so a question waits at most this long per call.
export const ASK_WAIT_MS = 4 * 60_000;
const tail = (text: string, max = MAX_RESULT) => (text.length > max ? `…(earlier output cut)\n${text.slice(-max)}` : text);

export class StartSession implements StartHost {
  readonly quest: Quest;
  readonly startedAt = Date.now();
  readonly key = `start-${randomBytes(4).toString("hex")}`; // this start's drafts
  private settled = false;
  appUp = false; // app_ready passed
  ended = false; // ended with a skill (saved, proposed or used)
  lessoned = false; // propose_lesson was called
  lastError?: string;
  private d: SessionDeps;
  private root: string;
  private asks = new Map<string, (a: StartAnswer) => void>();
  private waiting = new Map<string, { id: string; answer: Promise<StartAnswer> }>(); // open questions by what they ask
  askWaitMs = ASK_WAIT_MS;
  private children = new Set<ChildProcess>();
  private serviceSteps = new Map<string, string>(); // service → step id
  private poll?: ReturnType<typeof setInterval>;
  private seenTail = new Map<string, string>();
  private stopped = false;
  private guess: Pick<ProjectInfo, "expectedPlaces" | "declaredPlaces">; // the lanes before any plan

  constructor(d: SessionDeps) {
    this.d = d;
    this.guess = { expectedPlaces: d.project.expectedPlaces, ...(d.project.declaredPlaces ? { declaredPlaces: d.project.declaredPlaces } : {}) };
    this.root = d.project.root;
    this.quest = new Quest(this.root, d.project.name, { plan: (p) => d.emit("start:plan", p), step: (s) => d.emit("start:step", s) });
    const best = d.recipes[0];
    this.quest.set({ recipes: [...d.recipes, ...d.lessons].map((r) => ({ id: r.id, name: r.name, source: r.source, path: r.path })), source: best && best.source !== "lessons" ? best.source : "explored", ...(best?.skillId ? { skillId: best.skillId } : {}) });
    this.quest.adhoc(best ? `Read the "${best.name}" recipe` : "Explore how this project starts", "check");
    this.quest.update(this.quest.plan.steps[0]!.id, { state: "running", detail: best ? `${sourceWords(best.source)}: ${best.path}` : "No recipe yet, so Claude reads the project first" });
    this.poll = setInterval(() => this.pollServices(), 400);
    this.poll.unref?.();
  }

  get recipeStep(): string {
    return this.quest.plan.steps[0]!.id;
  }

  // ---- recipes and plan ----

  async readRecipe(id: string): Promise<string> {
    const r = [...this.d.recipes, ...this.d.lessons].find((x) => x.id === id || x.id.split(":")[1] === id);
    if (!r) throw new Error(`No recipe "${id}". Recipes: ${[...this.d.recipes, ...this.d.lessons].map((x) => x.id).join(", ") || "none"}.`);
    const files = await Promise.all(
      (r.files ?? []).slice(0, 8).map(async (f) => {
        const text = await readFile(f, "utf8").catch(() => "");
        return text && text.length < 30_000 ? `\n\n--- ${basename(f)} (in the same folder: ${f}) ---\n${text}` : `\n\n--- ${basename(f)} (in the same folder: ${f})`;
      }),
    );
    return `Recipe ${r.id}: ${r.name}\nFrom: ${r.path}\nWhen: ${r.when}\n\n<recipe>\n${r.body}\n</recipe>${files.join("")}`;
  }

  async plan(p: PlanArgs): Promise<string> {
    const first = this.quest.plan.steps[0]!;
    const skillStep = { id: "skill", title: "Save what worked as a skill", kind: "other" as const };
    const steps = [{ id: first.id, title: first.title, kind: first.kind }, ...p.steps.filter((s) => s.id !== first.id && s.id !== "skill").map((s) => ({ ...s, ...(s.cwd ? { cwd: this.relDir(s.cwd) } : {}) })), skillStep];
    this.quest.setPlan({ source: p.source, services: p.services, steps, ...(p.skillId ? { skillId: p.skillId } : {}) });
    // Lanes-from-plan: the expected lanes are what the plan and its recipe name, not the package.json guess.
    const used = this.d.recipes.find((r) => (p.skillId ? r.skillId === p.skillId : r.source === p.source));
    const text = [used?.body ?? "", ...p.steps.map((x) => `${x.title} ${x.command ?? ""}`)].join("\n");
    const places = plannedPlaces(p.services, text, this.guess);
    if (places.length) {
      this.d.project.expectedPlaces = places;
      this.d.project.placesFrom = "plan";
      this.quest.set({ places });
    }
    if (first.state === "running") this.quest.update(first.id, { state: "done" });
    return `The user now sees this plan:\n${this.quest.plan.steps.map((s, i) => `${i + 1}. [${s.id}] ${s.title}${s.command ? `  $ ${s.command}` : ""}`).join("\n")}\nGo through it in order. Pass step ids to run_command, start_service and check_health.`;
  }

  async updateStep(p: { id: string; state: "running" | "done" | "failed" | "fixed" | "skipped"; detail?: string; fix?: string }): Promise<string> {
    if (p.id === "skill" && (p.state === "done" || p.state === "skipped")) throw new Error("The skill step ends with save_run_skill or mark_skill_used.");
    const s = this.quest.update(p.id, { state: p.state, ...(p.detail ? { detail: p.detail } : {}), ...(p.fix ? { fix: p.fix } : {}) });
    if (p.state === "failed" && p.detail) this.lastError = p.detail;
    return `Step ${s.id} is ${s.state}.`;
  }

  say(text: string): void {
    if (!this.quest.done) this.quest.set({ say: text.split("\n")[0]!.slice(0, 200) });
  }

  // ---- the guarded shell ----

  private relDir(cwd: string | undefined): string | undefined {
    if (!cwd || cwd === ".") return undefined;
    const abs = resolve(this.root, cwd);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${cwd} is outside the project. Use a folder inside it.`);
    return rel || undefined;
  }

  private stepFor(id: string | undefined, title: string, j: Judgement, command?: string): StartStep {
    if (id) {
      const s = this.quest.plan.steps.find((x) => x.id === id);
      if (s) return s;
    }
    return this.quest.adhoc(title, KIND_OF[j.category] ?? "other", command);
  }

  /** R6: run, ask or refuse. Resolves when it may run; throws with a plain reason otherwise. */
  private async gate(step: StartStep, j: Judgement, command: string, title: string): Promise<void> {
    const d = decide(j, this.d.always);
    if (d === "run") return;
    if (d === "refuse") {
      this.quest.update(step.id, { detail: `Shrike won't run this: ${j.why}`, ...(step.state === "pending" && step.command === command ? { state: "skipped" as const } : {}) });
      throw new Error(`Not allowed: ${j.why} Find another way that stays inside the project, or tell the user what to run themselves and why.`);
    }
    const cover = rememberable(j);
    const one = cover.length === 1 && (j.asks ?? [j.category]).length === 1 ? cover[0] : undefined; // "Always allow" only when it would really cover this
    const a = await this.ask(step, { kind: "approve", title: `${title}?`, reason: `${CATEGORY_WORDS[j.category]}. ${j.why === CATEGORY_WORDS[j.category] ? "" : j.why}`.trim(), command, ...(one ? { category: one } : {}) });
    if (!a.allow) {
      this.quest.update(step.id, { detail: "You said no to this", ...(step.state === "pending" && step.command === command ? { state: "skipped" as const } : {}) });
      throw new Error(`The user said no to: ${command}. Find another way, or explain in one line why it's needed and ask once more.`);
    }
    if (a.always && one) {
      this.d.always.add(one);
      this.d.saveAlways?.([...this.d.always]);
    }
  }

  /** The question stays on the step until the user answers; the same question asked again (the next tool call) waits on it. */
  private async ask(step: StartStep, a: Omit<StartAsk, "id">): Promise<StartAnswer> {
    const key = `${a.kind}\n${a.command ?? ""}\n${a.file ?? ""}\n${(a.keys ?? []).join(",")}\n${a.kind === "approve" ? "" : a.title}`;
    let open = this.waiting.get(key);
    if (!open) {
      const id = randomBytes(6).toString("hex");
      this.quest.update(step.id, { state: "waiting_approval", ask: { ...a, id } });
      this.d.notify?.("Shrike needs you to start your app", a.title);
      open = { id, answer: new Promise<StartAnswer>((r) => this.asks.set(id, r)) };
      this.waiting.set(key, open);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([open.answer, new Promise<null>((r) => (timer = setTimeout(() => r(null), this.askWaitMs)))]).finally(() => clearTimeout(timer));
    if (this.stopped) throw new Error("The start was stopped.");
    if (!answer) throw new Error(`The user hasn't answered "${a.title}" yet; it stays on screen and nothing ran. Call the same tool again with the same command to keep waiting, or do other steps first.`);
    this.waiting.delete(key);
    return answer;
  }

  answer(askId: string, a: StartAnswer): boolean {
    const r = this.asks.get(askId);
    if (!r) return false;
    this.asks.delete(askId);
    const step = this.quest.plan.steps.find((x) => x.ask?.id === askId);
    if (step && !this.quest.done) this.quest.update(step.id, { state: a.allow ? "running" : "pending", ask: undefined });
    r(a);
    return true;
  }

  private settle(step: StartStep, ok: boolean, detail: string | undefined, fix?: string): void {
    const s = this.quest.plan.steps.find((x) => x.id === step.id)!;
    if (ok) {
      const fixText = fix ?? s.fix;
      if (this.retried.has(s.id) && fixText) this.quest.update(s.id, { state: "fixed", fix: fixText, ...(detail ? { detail } : {}) });
      else this.quest.update(s.id, { state: "done", detail: detail ?? (this.retried.has(s.id) ? "Worked on the retry" : undefined) });
    } else {
      this.retried.add(s.id);
      this.lastError = detail;
      this.quest.update(s.id, { state: "failed", ...(detail ? { detail } : {}) });
    }
  }
  private retried = new Set<string>();

  private begin(step: StartStep, patch: Partial<StartStep>): void {
    if (step.state === "running") return void this.quest.update(step.id, patch);
    this.quest.update(step.id, { ...patch, state: "running", output: "" });
  }

  async runCommand(p: { step?: string; title: string; command: string; cwd?: string; timeoutSec?: number; fix?: string }): Promise<string> {
    this.alive();
    const cwd = this.relDir(p.cwd);
    const abs = resolve(this.root, cwd ?? ".");
    const j = judge(p.command, { root: this.root, cwd: abs });
    const step = this.stepFor(p.step, p.title, j, p.command);
    await this.gate(step, j, p.command, p.title);
    this.begin(step, { command: p.command, ...(cwd ? { cwd } : {}), category: j.category });
    const started = Date.now();
    const r = await this.exec(p.command, abs, (p.timeoutSec ?? 570) * 1000, (c) => this.quest.output(step.id, c));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const why = r.code === 0 ? undefined : r.timedOut ? `Stopped after ${p.timeoutSec ?? 570}s without finishing` : lastLine(r.out) || `Exited with code ${r.code}`;
    this.settle(step, r.code === 0, why, p.fix);
    return `${r.timedOut ? "Timed out" : `Exit code ${r.code}`} after ${secs}s (step ${step.id} is now ${this.quest.step(step.id).state}).\n${tail(r.out) || "(no output)"}`;
  }

  private exec(command: string, cwd: string, timeoutMs: number, onChunk: (c: string) => void): Promise<{ code: number | null; out: string; timedOut: boolean }> {
    return new Promise((done) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...NO_TTY_ENV, FORCE_COLOR: "0", NO_UPDATE_NOTIFIER: "1", npm_config_yes: "true" };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_RENDERER_URL;
      let out = "";
      let timedOut = false;
      const child = spawnShell(command, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      this.children.add(child);
      const on = (b: Buffer) => {
        const s = b.toString("utf8");
        out = (out + s).slice(-200_000);
        onChunk(s);
      };
      child.stdout?.on("data", on);
      child.stderr?.on("data", on);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid, "SIGTERM");
        setTimeout(() => killTree(child.pid, "SIGKILL"), 2000).unref();
      }, timeoutMs);
      child.once("error", (e) => (out += `\n${e.message}`));
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        done({ code: timedOut ? null : code, out: out.replace(ANSI, ""), timedOut });
      });
    });
  }

  // ---- services (the runner keeps them after the agent run) ----

  async startService(p: { step?: string; title?: string; name: string; command: string; cwd?: string; url?: string; instrument?: boolean; waitSec?: number }): Promise<string> {
    this.alive();
    const cwd = this.relDir(p.cwd);
    const abs = resolve(this.root, cwd ?? ".");
    if (p.url) p = { ...p, url: this.here(p.url) };
    if (p.url) checkLocalUrl(p.url);
    const judged = judge(p.command, { root: this.root, cwd: abs });
    // A project file run as a service (node index.js, ./bin/api) is a local service; anything else keeps its judgement.
    const onlyOther = judged.verdict === "ask" && (judged.asks ?? [judged.category]).every((c) => c === "other");
    const j: Judgement = onlyOther && projectScript(p.command, { root: this.root, cwd: abs }) ? { verdict: "allow", category: "service", why: "Start a local service" } : judged;
    const title = p.title ?? `Start ${p.name}`;
    // The same service asked for again (a retried tool call): report on the one that's running instead of refusing.
    const same = this.service(p.name);
    if (same && (same.state === "starting" || same.state === "running") && same.command === p.command && this.serviceSteps.has(p.name)) {
      const out = (this.d.runner.serviceTail(p.name, 300) ?? []).join("\n");
      return `"${p.name}" is already ${same.state} from your earlier start_service (pid ${same.pid}); nothing new was started. Confirm with check_health. Output so far:\n${tail(out, 12_000) || "(nothing yet)"}`;
    }
    const step = this.stepFor(p.step, title, j, p.command);
    await this.gate(step, j, p.command, title);
    this.begin(step, { command: p.command, service: p.name, ...(cwd ? { cwd } : {}), category: j.category });
    this.serviceSteps.set(p.name, step.id);
    const info = await this.d.runner.startService(this.d.project, { name: p.name, command: p.command, ...(cwd ? { cwd } : {}), ...(p.url ? { url: p.url } : {}), instrument: p.instrument }, await this.d.runEnv());
    const deadline = Date.now() + (p.waitSec ?? 8) * 1000;
    let s = this.service(p.name);
    while (Date.now() < deadline && s && (s.state === "starting" || s.state === "running")) {
      if (p.url && (await responds(p.url))) break;
      await wait(300);
      s = this.service(p.name);
    }
    const lines = (this.d.runner.serviceTail(p.name, 300) ?? []).join("\n");
    if (s && (s.state === "error" || s.state === "stopped")) {
      const why = s.error?.split("\n")[0] ?? `It stopped with code ${s.exitCode}`;
      this.settle(step, false, s.error?.split("\n").at(-1) || why);
      return `The "${p.name}" service stopped right away (code ${s.exitCode}).\n${tail(lines) || "(no output)"}`;
    }
    const up = p.url && (await responds(p.url));
    if (up) this.d.runner.markService(p.name, p.url);
    return `Started "${p.name}" (pid ${info.pid}). ${up ? `It answers at ${p.url}.` : `Not answering yet${p.url ? ` at ${p.url}` : ""}: confirm with check_health.`} Output so far:\n${tail(lines, 12_000) || "(nothing yet)"}`;
  }

  /** W2: a worktree runs on every declared local port moved by its offset; a URL with a declared port moves with it. */
  private here(url: string): string {
    const off = this.d.runner.offsetFor?.(this.root) ?? 0;
    if (!off) return url;
    const declared = new Set([this.d.project.appUrl, ...this.d.project.processes.map((x) => x.url)].map((u) => /:(\d{2,5})(?=[/?#]|$)/.exec(u ?? "")?.[1]).filter(Boolean));
    return url.replace(/^((?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))?:|tcp:)(\d{2,5})(?=[/?#]|$)/, (m, pre: string, port: string) => (declared.has(port) ? `${pre}${Number(port) + off}` : m));
  }

  private service(name: string) {
    return this.d.runner.services().findLast((s) => s.name === name);
  }

  async stopService(p: { name: string }): Promise<string> {
    const ok = await this.d.runner.stopService(p.name);
    return ok ? `Stopped "${p.name}".` : `"${p.name}" wasn't running. Running: ${this.running().join(", ") || "nothing"}.`;
  }

  private running(): string[] {
    return this.d.runner.services().filter((s) => s.state === "starting" || s.state === "running").map((s) => s.name);
  }

  async serviceLogs(p: { name: string; lines?: number }): Promise<string> {
    const lines = this.d.runner.serviceTail(p.name, p.lines ?? 300);
    if (!lines) throw new Error(`No service "${p.name}". Started: ${this.d.runner.services().map((s) => s.name).join(", ") || "none"}.`);
    const s = this.service(p.name);
    return `"${p.name}" is ${s?.state ?? "unknown"}${s?.exitCode != null ? ` (exit code ${s.exitCode})` : ""}.\n${tail(lines.join("\n")) || "(no output yet)"}`;
  }

  private pollServices(): void {
    for (const [name, stepId] of this.serviceSteps) {
      const t = (this.d.runner.serviceTail(name, 40) ?? []).join("\n");
      if (t === this.seenTail.get(name)) continue;
      this.seenTail.set(name, t);
      const s = this.quest.plan.steps.find((x) => x.id === stepId);
      if (s && !this.quest.done) {
        s.output = "";
        this.quest.output(stepId, t);
      }
    }
  }

  // ---- health ----

  async checkHealth(p: { step?: string; target: string; service?: string; timeoutSec?: number; expect?: string; fix?: string }): Promise<string> {
    this.alive();
    const target = this.here(p.target.trim());
    const probe = this.prober(target, p.expect);
    const step = p.step ? this.quest.plan.steps.find((s) => s.id === p.step) : undefined;
    if (step) this.begin(step, { detail: `Waiting for ${target}` });
    const deadline = Date.now() + (p.timeoutSec ?? 60) * 1000;
    const before = new Set(this.d.runner.services().filter((s) => s.state === "error" || s.state === "stopped").map((s) => `${s.name}:${s.startedAt}`));
    let last = "";
    for (;;) {
      const r = await probe();
      last = r.detail;
      if (r.ok) {
        if (p.service) this.d.runner.markService(p.service);
        for (const s of this.d.runner.services()) if (s.url && sameHostPort(s.url, target)) this.d.runner.markService(s.name);
        if (step) this.settle(step, true, `Answers: ${r.detail}`.slice(0, 200), p.fix);
        return `Healthy: ${target} ${r.detail}`;
      }
      const died = this.d.runner.services().find((s) => (s.state === "error" || s.state === "stopped") && !before.has(`${s.name}:${s.startedAt}`));
      if (died) {
        const why = `The "${died.name}" service stopped while waiting: ${died.error?.split("\n").at(-1) ?? `code ${died.exitCode}`}`;
        if (step) this.settle(step, false, why.slice(0, 300));
        return `${why}\nIts last output:\n${tail((this.d.runner.serviceTail(died.name, 120) ?? []).join("\n"), 12_000)}`;
      }
      if (Date.now() > deadline) break;
      await wait(1000);
    }
    const why = `No answer from ${target} after ${p.timeoutSec ?? 60}s${last ? ` (${last})` : ""}`;
    if (step) this.settle(step, false, why.slice(0, 300));
    return `${why}. Running services: ${this.running().join(", ") || "none"}. Read service_logs to see why.`;
  }

  private prober(target: string, expect?: string): () => Promise<{ ok: boolean; detail: string }> {
    if (/^https?:\/\//i.test(target)) {
      checkLocalUrl(target);
      return async () => {
        try {
          const res = await fetch(target, { signal: AbortSignal.timeout(3000), redirect: "manual", headers: { "x-shrike-internal": "1" } });
          const body = (await res.text().catch(() => "")).slice(0, 4000);
          const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
          const ok = res.status < 500 && (!expect || body.includes(expect));
          return { ok, detail: `${res.status}${title ? ` "${title}"` : body ? ` ${body.replace(/\s+/g, " ").slice(0, 160)}` : ""}${expect && !body.includes(expect) ? ` (no "${expect}" yet)` : ""}` };
        } catch (e) {
          return { ok: false, detail: (e as Error).cause ? String(((e as Error).cause as Error).message ?? "") : (e as Error).message };
        }
      };
    }
    const tcp = /^(?:tcp:)?(?:(\[[^\]]+\]|[\w.-]+):)?(\d{1,5})$/i.exec(target);
    if (tcp) {
      const host = (tcp[1] ?? "127.0.0.1").replace(/^\[|\]$/g, "");
      if (!LOCAL.test(host)) throw new Error(`Only this computer's ports can be checked, not ${host}.`);
      const port = Number(tcp[2]);
      return () => new Promise((r) => {
        const s = connect({ host: host === "localhost" ? "127.0.0.1" : host, port });
        const end = (ok: boolean, detail: string) => (s.destroy(), r({ ok, detail }));
        s.setTimeout(2000, () => end(false, "timed out"));
        s.once("connect", () => end(true, `port ${port} is open`));
        s.once("error", (e) => end(false, (e as NodeJS.ErrnoException).code ?? e.message));
      });
    }
    const cmd = /^cmd:\s*(.+)$/s.exec(target)?.[1];
    if (cmd) {
      const j = judge(cmd, { root: this.root, cwd: this.root });
      if (decide(j, this.d.always) !== "run") throw new Error(`A health check command must be a plain look or check (${j.why}). Use run_command for anything else.`);
      return async () => {
        const r = await this.exec(cmd, this.root, 30_000, () => {});
        return { ok: r.code === 0, detail: `exit ${r.code}: ${lastLine(r.out)}`.slice(0, 300) };
      };
    }
    throw new Error("target is a local URL (http://localhost:3001/health), a port (tcp:5433) or a command (cmd:pg_isready -p 5433).");
  }

  // ---- env ----

  async envStatus(p: { dir?: string }): Promise<string> {
    const dirs = p.dir ? [this.relDir(p.dir) ?? ""] : ["", ...(await subdirs(this.root))];
    const lines: string[] = [];
    for (const dir of dirs) {
      const abs = join(this.root, dir);
      const names = (await readdir(abs).catch(() => [] as string[])).filter((f) => ENV_NAME.test(f)).sort();
      if (!names.length) continue;
      const templates = names.filter((f) => TEMPLATE.test(f));
      const real = names.filter((f) => !TEMPLATE.test(f));
      const keysOf = async (f: string) => parseEnv(await readFile(join(abs, f), "utf8").catch(() => ""));
      const have = new Set((await Promise.all(real.map(keysOf))).flatMap((m) => [...m.keys()]));
      lines.push(`${dir || "."}: real ${real.join(", ") || "none"}; templates ${templates.join(", ") || "none"}`);
      for (const t of templates) {
        const keys = await keysOf(t);
        const missing = [...keys].filter(([k]) => !have.has(k));
        lines.push(`  ${t}: ${keys.size} keys, ${missing.length} missing from ${real.join("/") || "any real env file"}`);
        for (const [k, v] of missing.slice(0, 60)) lines.push(`    - ${k}${v ? ` (example: ${v.slice(0, 80)})` : ""}`);
      }
      if (real.length) lines.push(`  keys set in ${real.join(", ")}: ${[...have].sort().join(", ").slice(0, 3000)}`);
    }
    return lines.join("\n") || "No env files or templates in this project.";
  }

  async writeEnv(p: { step?: string; file: string; values?: Record<string, string>; ask?: string[]; copyFrom?: string; reason: string }): Promise<string> {
    this.alive();
    const rel = this.relDir(dirname(p.file));
    const name = basename(p.file);
    if (!ENV_NAME.test(name) || TEMPLATE.test(name)) throw new Error(`write_env only writes env files like .env or .env.local, not ${p.file}.`);
    const file = join(this.root, rel ?? "", name);
    const show = rel ? `${rel}/${name}` : name;
    const values = p.values ?? {};
    const asked = [...new Set(p.ask ?? [])].filter((k) => !(k in values));
    const title = `Write ${Object.keys(values).length + asked.length} setting${Object.keys(values).length + asked.length === 1 ? "" : "s"} to ${show}`;
    const step = this.stepFor(p.step, title, { verdict: "ask", category: "env", why: p.reason }, undefined);
    const keyList = [...Object.keys(values), ...asked];
    const a = await this.ask(step, { kind: "env", title: `${title}?`, reason: `${p.reason}${keyList.length ? ` (${keyList.join(", ")})` : ""}${p.copyFrom ? `. Starts from a copy of ${p.copyFrom}` : ""}`, file: show, keys: asked, category: "env" });
    if (!a.allow) {
      this.quest.update(step.id, { detail: "You said no to this" });
      throw new Error(`The user said no to writing ${show}. Explain why it's needed, or find another way.`);
    }
    const typed = Object.fromEntries(asked.map((k) => [k, a.values?.[k] ?? ""]).filter(([, v]) => v !== ""));
    const missing = asked.filter((k) => !(k in typed));
    if (p.copyFrom && !existsSync(file)) {
      const from = resolve(this.root, p.copyFrom);
      const r = relative(this.root, from);
      if (r.startsWith("..") || isAbsolute(r) || !TEMPLATE.test(from)) throw new Error("copyFrom must be an env template inside the project, like .env.example.");
      await copyFile(from, file);
    }
    const before = await readFile(file, "utf8").catch(() => "");
    const next = setEnv(before, { ...values, ...typed });
    const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`;
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, file);
    this.quest.update(step.id, { state: "done", detail: `Wrote ${Object.keys({ ...values, ...typed }).join(", ") || "nothing new"} to ${show}` });
    return `Wrote ${show}: ${Object.keys(values).join(", ") || "no values from you"}${Object.keys(typed).length ? `; the user typed ${Object.keys(typed).join(", ")} (values hidden from you)` : ""}${missing.length ? `; the user left ${missing.join(", ")} empty` : ""}.`;
  }

  // ---- ready, and ending with a skill ----

  async appReady(p: { url?: string }): Promise<string> {
    this.alive();
    if (p.url) p = { url: this.here(p.url) };
    if (p.url) checkLocalUrl(p.url);
    const services = this.d.runner.services();
    const down = services.filter((s) => s.state === "error" || (s.state === "stopped" && s.exitCode !== 0));
    const live = services.filter((s) => s.state === "starting" || s.state === "running");
    const open = this.quest.unfinished(["skill"]).filter((s) => !(s.state === "running" && s.service && live.some((x) => x.name === s.service)));
    const problems = [
      ...down.map((s) => `the "${s.name}" service stopped (${s.error?.split("\n").at(-1) ?? `code ${s.exitCode}`})`),
      ...open.map((s) => `step "${s.id}" is ${s.state}`),
      ...(!live.length && !services.length ? ["no service was started with start_service"] : []),
    ];
    // A cold dev server can take longer than one 2s probe to answer its first page (Vite compiles on demand).
    let answers = !p.url;
    for (const end = Date.now() + 20_000; p.url && !answers && Date.now() < end; ) answers = (await responds(p.url)) || (await wait(1000), false);
    if (p.url && !answers) problems.push(`nothing answers at ${p.url} after 20s`);
    if (problems.length) throw new Error(`Not ready yet: ${problems.join("; ")}. Fix these, or mark steps skipped if they aren't needed.`);
    for (const s of this.quest.plan.steps) if (s.state === "running" && s.service) this.quest.update(s.id, { state: "done" });
    this.d.runner.markRunning(p.url);
    let page: { title: string; text: string } | undefined;
    if (p.url && this.d.pageCheck) {
      for (let i = 0; i < 20 && !(page?.title || page?.text.trim()); i++) {
        page = await this.d.pageCheck(p.url).catch(() => undefined);
        if (!(page?.title || page?.text.trim())) await wait(1000);
      }
      if (!(page?.title || page?.text.trim())) {
        this.lastError = "The page loads but shows nothing";
        return `The app pane loaded ${p.url}, but the page is blank (no title, no text). That usually means a stale build (rebuild shared packages), a missing env value the page needs, or a crash in the browser. Fix it, then call app_ready again.`;
      }
    }
    this.appUp = true;
    const skillStep = this.quest.plan.steps.find((s) => s.id === "skill");
    if (skillStep && skillStep.state === "pending") this.quest.update("skill", { state: "running" });
    return `Ready. ${p.url ? `The app pane shows ${p.url}${page ? `: title "${page.title}", text "${page.text.replace(/\s+/g, " ").slice(0, 300)}"` : ""}.` : "No page to show."} Running: ${this.running().join(", ")}. Now end with a skill: save_run_skill (or mark_skill_used if the run skill needed no change), then propose_lesson for anything that would help start other projects.`;
  }

  private needUp(): void {
    if (!this.appUp) throw new Error("The app isn't up yet. A run skill is only saved after app_ready succeeds, so it records what really worked.");
  }

  async saveRunSkill(p: { body: string; when?: string; learned?: string }): Promise<string> {
    this.needUp();
    const from = this.d.recipes[0];
    const r = await saveRunSkill(this.d.skillDirs(), { projectName: this.d.project.name, body: p.body, runId: this.key, ...(p.when ? { when: p.when } : {}), ...(p.learned ? { learned: p.learned } : {}), ...(from && from.source !== "shrike-skill" ? { from: from.path } : {}) });
    return this.ending(r);
  }

  async markSkillUsed(p: { skillId: string }): Promise<string> {
    this.needUp();
    const id = runSkillId(this.d.project.name);
    if (p.skillId !== id || !existsSync(runSkillPath(this.root, id))) throw new Error(`There's no Shrike run skill "${p.skillId}" yet (this project's is ${id}). Call save_run_skill so the next start can follow it.`);
    return this.ending({ file: runSkillPath(this.root, id), reward: { kind: "used", skillId: id, name: `Run ${this.d.project.name}` } });
  }

  private async ending(r: SaveResult): Promise<string> {
    await this.d.pushSkills?.().catch(() => {});
    this.quest.reward(r.reward);
    this.quest.set({ skillId: r.reward.skillId });
    this.ended = true;
    const s = this.quest.plan.steps.find((x) => x.id === "skill");
    if (s) this.quest.update("skill", { state: "done", detail: r.reward.kind === "acquired" ? `New skill: ${r.reward.name}` : r.reward.kind === "proposed" ? `Learned: ${r.reward.learned}. Kept once the start ends verified ready` : `Used: ${r.reward.name}` });
    return r.reward.kind === "acquired"
      ? `Saved ${r.file} (Lv.1). The next start follows it first. If you learned something that helps start any project, call propose_lesson; then stop.`
      : r.reward.kind === "proposed"
        ? `Saved as a draft of ${r.reward.name}. Shrike keeps it by itself once this start ends verified ready. Call propose_lesson for anything generic, then stop.`
        : `Counted one more successful use of ${r.reward.name}. Stop here.`;
  }

  async proposeLesson(p: { lesson: string }): Promise<string> {
    this.lessoned = true;
    const r = await proposeLesson(this.d.skillDirs(), p.lesson, this.key);
    if (r.reward.kind !== "used") this.quest.reward(r.reward);
    return r.reward.kind === "proposed" ? "Saved as a draft for starting-apps. It is kept once a start ends verified ready." : "starting-apps already has that lesson.";
  }

  /** The gate (once per start): ok only when app_ready passed and every health check is done. Applied drafts replace the quest's proposed rewards. */
  private async learn(ok: boolean, why?: string): Promise<void> {
    if (this.settled || !this.d.outcome) return;
    this.settled = true;
    const healthy = !this.quest.plan.steps.some((s) => s.kind === "health" && s.state !== "done" && s.state !== "fixed");
    const verified = ok && this.appUp && healthy;
    const skillIds = [runSkillId(this.d.project.name), "starting-apps", ...(this.quest.plan.skillId ? [this.quest.plan.skillId] : [])];
    const runIds = [this.key, ...(this.quest.plan.runId ? [this.quest.plan.runId] : [])];
    const reason = why ?? (!this.appUp ? "the app never came up" : "a health check didn't pass");
    const up = await this.d.outcome({ ok: verified, runIds, skillIds, ...(verified ? {} : { why: reason }) }).catch(() => [] as StartReward[]);
    if (!verified) return;
    this.quest.plan.rewards = this.quest.plan.rewards?.filter((r) => r.kind !== "proposed"); // a draft that didn't apply stays a draft, not a reward
    for (const r of up) this.quest.reward(r);
  }

  /** The agent run ended. "nudge": up but no run skill yet; "lesson": not up and nothing learned yet. */
  agentEnded(status: "done" | "failed" | "stopped"): "ready" | "nudge" | "lesson" | "failed" | "stopped" {
    if (this.quest.done) return this.quest.plan.state === "ready" ? "ready" : this.quest.plan.state === "stopped" ? "stopped" : "failed";
    if (status === "stopped" || this.stopped) return "stopped";
    if (this.appUp && this.ended) return "ready";
    if (this.appUp) return "nudge";
    return this.lessoned ? "failed" : "lesson";
  }

  /** Ready: the drafts are judged first, so [Level Up] plays before [Quest Complete]. */
  finishReady(note?: string): Promise<void> {
    clearInterval(this.poll);
    return this.learn(true).then(() => {
      if (note) this.quest.set({ error: note });
      this.quest.finish("ready");
      const r = this.quest.plan.rewards?.[0];
      this.d.notify?.("Your app is running", `${this.d.project.name} is up${r ? ` and ${r.name} ${r.kind === "acquired" ? "is a new skill" : r.kind === "leveled" ? "leveled up" : "is one use stronger"}` : ""}.`);
    });
  }

  finishFailed(error: string): void {
    clearInterval(this.poll);
    void this.learn(false);
    this.quest.finish("failed", error);
    this.d.runner.markFailed(error);
  }

  /** Stop: end every command and question; services are the runner's to stop. */
  stop(): void {
    this.stopped = true;
    void this.learn(false, "the start was stopped before it finished");
    clearInterval(this.poll);
    for (const c of this.children) killTree(c.pid, "SIGKILL");
    for (const r of this.asks.values()) r({ allow: false });
    this.asks.clear();
    this.waiting.clear();
    this.quest.finish("stopped");
  }

  private alive(): void {
    if (this.stopped || this.quest.done) throw new Error(`This start is ${this.quest.plan.state}. Stop here.`);
  }
}


function sourceWords(s: Recipe["source"]): string {
  return s === "shrike-skill" ? "Shrike's run skill" : s === "project-skill" ? "The project's own Claude skill" : s === "claude-skill" ? "Your Claude skill" : s === "readme" ? "The README" : s === "lessons" ? "Lessons" : "Explored";
}

function lastLine(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.findLast((l) => /\b(error|failed|cannot|can't|not found|missing|refused|EADDRINUSE|denied)\b/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 300);
}

function checkLocalUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url}" isn't a URL. Use one like http://localhost:5173.`);
  }
  if (!/^https?:$/.test(u.protocol) || !LOCAL.test(u.hostname.replace(/^\[|\]$/g, ""))) throw new Error(`Only this computer's addresses are allowed (localhost), not ${u.host}.`);
}

function sameHostPort(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = /^https?:/.test(b) ? new URL(b) : undefined;
    return !!y && x.port === y.port;
  } catch {
    return false;
  }
}

async function subdirs(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const g of ["apps", "packages", "services", "backend", "frontend", "server", "client", "web", "api"]) {
    const ents = await readdir(join(root, g), { withFileTypes: true }).catch(() => []);
    if (ents.length) out.push(g);
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") out.push(`${g}/${e.name}`);
  }
  return out;
}

export function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.]*)[ \t]*=[ \t]*(.*?)[ \t]*$/gm)) m.set(x[1]!, x[2]!.replace(/^(["'])(.*)\1$/, "$2"));
  return m;
}

/** KEY=value set in place (first line with that key), else appended. Comments and order stay. */
export function setEnv(text: string, values: Record<string, string>): string {
  let out = text;
  const quote = (v: string) => (/^[\w./:@%+,-]*$/.test(v) ? v : JSON.stringify(v));
  const added: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${k.replace(/\./g, "\\.")}[ \\t]*=.*$`, "m");
    if (re.test(out)) out = out.replace(re, (_m, pre: string) => `${pre}${k}=${quote(v)}`);
    else added.push(`${k}=${quote(v)}`);
  }
  if (added.length) out = `${out.replace(/\s*$/, "")}${out.trim() ? "\n" : ""}${added.join("\n")}\n`;
  return out;
}
