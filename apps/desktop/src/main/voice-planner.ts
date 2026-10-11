import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { UtilityProcess } from "electron";
import type { VoicePlanRequest, VoicePlanResult } from "@shrike/schema";
import { PLANNER_MODEL } from "./voice-planner-model.ts";

// V9 planner, the main side (docs/16 §2.4): one utilityProcess, started when voice turns on, kept warm while voice is used,
// unloaded after 15 minutes without a turn. A crash there never takes Shrike down; the next turn starts it again.
// A model that won't load (a corrupt file, node-llama-cpp can't start) is "broken" until the file changes, so turns don't reload it.

const IDLE_MS = 15 * 60_000;
const LOAD_MS = 30_000;
const PLAN_MS = 1500; // docs/16: on timeout, "Didn't catch that" with chips

type Reply = { type: "reply"; id: number; ok: true; json?: unknown; ms: number } | { type: "reply"; id: number; ok: false; error: string };
type Proc = Pick<UtilityProcess, "on" | "postMessage" | "kill">;
export type Fork = (script: string) => Proc | Promise<Proc>;
const electronFork: Fork = async (script) => (await import("electron")).utilityProcess.fork(script, [], { serviceName: "Shrike voice planner", stdio: "ignore" });

function isGguf(file: string): boolean {
  const head = Buffer.alloc(4);
  try {
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return head.toString("latin1") === "GGUF";
}

export class VoicePlanner {
  private dir: string;
  private script: string;
  private fork: Fork;
  private proc: Proc | null = null;
  private loading: Promise<boolean> | null = null;
  private broken: string | undefined; // the model file (size and mtime) that failed to load
  private seq = 0;
  private waiting = new Map<number, (r: Reply) => void>();
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(modelsDir: string, script = join(import.meta.dirname, "voice-planner-worker.js"), fork: Fork = electronFork) {
    this.dir = modelsDir;
    this.script = script;
    this.fork = fork;
  }

  get modelPath(): string {
    return join(this.dir, PLANNER_MODEL.file);
  }

  /** The model is there and whole (the download checked its sha256 before naming it). */
  hasModel(): boolean {
    return existsSync(this.modelPath) && statSync(this.modelPath).size === PLANNER_MODEL.bytes;
  }

  private stamp(): string {
    const s = statSync(this.modelPath);
    return `${s.size}:${s.mtimeMs}`;
  }

  private isBroken(): boolean {
    return this.broken !== undefined && this.hasModel() && this.broken === this.stamp();
  }

  private load(): Promise<boolean> {
    if (this.loading) return this.loading;
    if (!this.hasModel() || this.isBroken()) return Promise.resolve(false);
    const stamp = this.stamp();
    if (!isGguf(this.modelPath)) return (this.broken = stamp), Promise.resolve(false); // garbage of the right size: no 20 s load to find out
    const loading = (async () => {
      let p: Proc;
      try {
        p = await this.fork(this.script);
      } catch {
        this.broken = stamp;
        return false;
      }
      this.proc = p;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const fail = (broken: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (broken) this.broken = stamp;
          resolve(false);
          this.close(); // a slow load (not broken) is tried again on the next warm-up or turn
        };
        const timer = setTimeout(() => fail(false), LOAD_MS);
        p.on("message", (m: { type: string; id?: number }) => {
          if (m.type === "ready") (settled = true), clearTimeout(timer), resolve(true);
          else if (m.type === "error") fail(true);
          else if (m.type === "reply" && m.id !== undefined) this.waiting.get(m.id)?.(m as Reply);
        });
        p.on("exit", () => {
          fail(true); // died before it was ready: node-llama-cpp or the model took it down
          for (const done of this.waiting.values()) done({ type: "reply", id: -1, ok: false, error: "failed" });
          this.waiting.clear();
          if (this.proc === p) (this.proc = null), (this.loading = null);
        });
        p.postMessage({ type: "load", modelPath: this.modelPath });
      });
    })();
    this.loading = loading;
    void loading.then((ok) => void (!ok && this.loading === loading && (this.loading = null)));
    return loading;
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
    if (!(await this.load())) return { ok: false, error: !this.hasModel() ? "missing" : this.isBroken() ? "broken" : "failed" };
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
