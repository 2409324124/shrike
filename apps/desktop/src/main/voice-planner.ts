import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { VoicePlanRequest, VoicePlanResult } from "@shrike/schema";
import { PLANNER_MODEL } from "./voice-planner-model.ts";

// V9 planner, the main side (docs/16 §2.4): one utilityProcess, started when voice turns on, kept warm while voice is used,
// unloaded after 15 minutes without a turn. A crash there never takes Shrike down; the next turn starts it again.

const IDLE_MS = 15 * 60_000;
const LOAD_MS = 30_000;
const PLAN_MS = 1500; // docs/16: on timeout, "Didn't catch that" with chips

type Reply = { type: "reply"; id: number; ok: true; json?: unknown; ms: number } | { type: "reply"; id: number; ok: false; error: string };

export class VoicePlanner {
  private dir: string;
  private script: string;
  private proc: UtilityProcess | null = null;
  private loading: Promise<boolean> | null = null;
  private seq = 0;
  private waiting = new Map<number, (r: Reply) => void>();
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(modelsDir: string, script = join(import.meta.dirname, "voice-planner-worker.js")) {
    this.dir = modelsDir;
    this.script = script;
  }

  get modelPath(): string {
    return join(this.dir, PLANNER_MODEL.file);
  }

  /** The model is there and whole (the download checked its sha256 before naming it). */
  hasModel(): boolean {
    return existsSync(this.modelPath) && statSync(this.modelPath).size === PLANNER_MODEL.bytes;
  }

  private load(): Promise<boolean> {
    if (this.loading) return this.loading;
    if (!this.hasModel()) return Promise.resolve(false);
    this.loading = new Promise<boolean>((resolve) => {
      const p = utilityProcess.fork(this.script, [], { serviceName: "Shrike voice planner", stdio: "ignore" });
      this.proc = p;
      const fail = () => (clearTimeout(timer), resolve(false), this.close()); // the next warm-up or turn tries again
      const timer = setTimeout(fail, LOAD_MS);
      p.on("message", (m: { type: string; id?: number }) => {
        if (m.type === "ready") (clearTimeout(timer), resolve(true));
        else if (m.type === "error") fail();
        else if (m.type === "reply" && m.id !== undefined) this.waiting.get(m.id)?.(m as Reply);
      });
      p.on("exit", () => {
        clearTimeout(timer);
        resolve(false);
        for (const done of this.waiting.values()) done({ type: "reply", id: -1, ok: false, error: "failed" });
        this.waiting.clear();
        if (this.proc === p) (this.proc = null), (this.loading = null);
      });
      p.postMessage({ type: "load", modelPath: this.modelPath });
    });
    return this.loading;
  }

  private ask(msg: Record<string, unknown>, ms: number): Promise<Reply> {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    const id = ++this.seq;
    return new Promise<Reply>((resolve) => {
      const t = setTimeout(() => (this.waiting.delete(id), resolve({ type: "reply", id, ok: false, error: "timeout" })), ms);
      this.waiting.set(id, (r) => (clearTimeout(t), this.waiting.delete(id), resolve(r)));
      this.proc?.postMessage({ ...msg, id });
    });
  }

  /** Load the model and evaluate the fixed prompt, so the first spoken command doesn't pay for it. */
  async warm(prefix: string): Promise<boolean> {
    if (!(await this.load())) return false;
    return (await this.ask({ type: "warm", prefix }, LOAD_MS)).ok;
  }

  async plan(req: VoicePlanRequest): Promise<VoicePlanResult> {
    if (!(await this.load())) return { ok: false, error: this.hasModel() ? "failed" : "missing" };
    const r = await this.ask({ type: "plan", ...req, timeoutMs: PLAN_MS }, PLAN_MS + 500);
    if (r.ok) return { ok: true, json: r.json, ms: r.ms };
    return { ok: false, error: r.error === "timeout" ? "timeout" : "failed" };
  }

  close(): void {
    clearTimeout(this.idle);
    this.proc?.kill();
    this.proc = null;
    this.loading = null;
  }
}
