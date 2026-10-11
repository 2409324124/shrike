import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProcessSpec, ProjectInfo, RunStatus } from "@shrike/schema";
import { readEnv } from "@shrike/scanner";
import { killTree, spawnShell } from "./platform.ts";

const MAX_LINES = 2000;
const READY_TIMEOUT_MS = 45_000;
const QUIET_READY_MS = 1000; // a process with no URL counts as up once it has lived this long
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/[^\s'"<>]+/;
// No terminal behind Shrike's processes: TUIs (process-compose) and browser openers (vite --open, CRA) must stay quiet.
export const NO_TTY_ENV = { PC_DISABLE_TUI: "true", BROWSER: "none" };

export interface RunnerOptions {
  onStatus(s: RunStatus): void;
  onOutput(chunk: string): void; // merged stream of every process ("run:output")
  onProcessOutput?(process: string, chunk: string): void; // per process ("process:output")
}

export interface RunEnv {
  nodeAgentRegister: string; // absolute path of register.mjs
  ingestUrl: string;
  token: string;
  serverUrl?: string; // API server that must also answer before the app counts as running
}

type ProcState = NonNullable<RunStatus["processes"]>[number];

export interface ServiceInfo {
  name: string;
  command: string;
  cwd?: string;
  url?: string;
  state: ProcState["state"];
  pid?: number;
  exitCode?: number | null;
  error?: string;
  startedAt: number;
}

interface Proc {
  managed?: boolean; // R3: started by the start agent (start_service); one exiting never stops the others
  exitCode?: number | null;
  stopRequested?: boolean;
  spec: ProcessSpec;
  cwd: string;
  root: string;
  child: ChildProcess;
  state: ProcState["state"];
  startedAt: number;
  url?: string;
  instrumented?: boolean;
  error?: string;
  lines: string[];
  partial: string;
  atLineStart: boolean;
  exited: Promise<void>;
}

export function detectUrl(line: string): { url: string; local: boolean } | undefined {
  const clean = line.replace(ANSI, "");
  const m = clean.match(URL_RE);
  if (!m) return undefined;
  const url = m[0].replace(/[.,)\]]+$/, "");
  return { url, local: /Local:/i.test(clean) && /^https?:\/\/localhost[:/]/.test(url) };
}

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host.replace(/^127\.0\.0\.1(?=:|$)/, "localhost") : undefined;
  } catch {
    return undefined;
  }
};

const LOOPBACK_PORT = /^(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])):(\d{1,5})(?=[/?#]|$)/;

/** W2: a local URL with its port moved by `offset` (main checkout 0, each worktree +100). Other URLs as they are. */
export function shiftUrl(url: string | undefined, offset: number): string | undefined {
  return url && offset ? url.replace(LOOPBACK_PORT, (_m, h: string, p: string) => `${h}:${Number(p) + offset}`) : url;
}

const portOf = (url: string | undefined) => (url ? LOOPBACK_PORT.exec(url)?.[2] : undefined);

/** W2: every known port, shifted, as env vars: APP_PORT (appUrl), SERVER_PORT (serverUrl), <NAME>_PORT per process, SHRIKE_PORT_OFFSET. */
export function portEnv(project: Pick<ProjectInfo, "appUrl" | "processes">, serverUrl: string | undefined, offset: number): Record<string, string> {
  const env: Record<string, string> = { SHRIKE_PORT_OFFSET: String(offset) };
  const put = (key: string, url: string | undefined) => {
    const port = portOf(shiftUrl(url, offset));
    if (port) env[key] = port;
  };
  put("APP_PORT", project.appUrl);
  put("SERVER_PORT", serverUrl);
  for (const p of project.processes ?? []) put(`${p.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`, p.url);
  return env;
}

/** A process's OpenTelemetry SDK (.NET, Python, Go, Java) exports its traces to Shrike's /v1/traces. Its own exporter settings win. */
export function addOtelEnv(env: NodeJS.ProcessEnv, service: string, ingestUrl: string, token: string): void {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;
  const ours: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: ingestUrl,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_HEADERS: `x-shrike-token=${token}`,
    OTEL_SERVICE_NAME: service,
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_BSP_SCHEDULE_DELAY: "200", // steps show up while the user still looks, not 5 s later
    // Shrike's readiness checks carry x-shrike-internal; recording the header lets the store drop them (Python, Java names).
    OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: "x-shrike-internal",
    OTEL_INSTRUMENTATION_HTTP_SERVER_CAPTURE_REQUEST_HEADERS: "x-shrike-internal",
  };
  for (const [k, v] of Object.entries(ours)) env[k] ??= v;
}

// Runs with a live process; portTaken doesn't count their ports as "another program" (a worktree's run, W2).
const live = new Set<Runner>();

export class Runner {
  status: RunStatus = { state: "idle" };
  offsetFor: (root: string) => number = () => 0; // W2: port offset of the worktree at `root`; shifts every local port
  urls: string[] = []; // what the current run listens on, shifted
  private opts: RunnerOptions;
  private procs: Proc[] = [];
  private stopping = false;
  private gen = 0;
  private pageUrl?: string;
  private firstUrl?: string;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  private alive(): Proc[] {
    return this.procs.filter((p) => p.state === "starting" || p.state === "running");
  }

  private set(s: Omit<RunStatus, "processes">): void {
    if (this.alive().length) live.add(this);
    else live.delete(this);
    this.status = {
      ...s,
      ...(this.procs.length
        ? { processes: this.procs.map((p) => ({ name: p.spec.name, state: p.state, pid: p.child.pid, url: p.url, instrumented: p.instrumented, error: p.error })) }
        : {}),
    };
    this.opts.onStatus(this.status);
  }

  private refresh(): void {
    const { processes: _, ...rest } = this.status;
    this.set(rest);
  }

  /** placeId "service:<name>" marks that process; without it only the run as a whole. `url`: where it listens, when its output didn't say. */
  setInstrumented(placeId?: string, url?: string): void {
    if (!this.alive().length) return;
    const p = placeId?.startsWith("service:") ? this.procs.find((q) => q.spec.name === placeId.slice(8)) : undefined;
    if (p && url && !p.url) p.url = url;
    if (p && !p.instrumented) p.instrumented = true;
    else if (this.status.instrumented) return;
    this.set({ ...this.status, instrumented: true });
  }

  /** Don't start: say why. */
  refuse(error: string): RunStatus {
    if (!this.alive().length) this.set({ state: "error", error });
    return this.status;
  }

  async start(project: ProjectInfo, env: RunEnv): Promise<RunStatus> {
    if (this.alive().length) {
      if (this.status.state === "starting" || this.status.state === "running") return this.status;
      await this.stop(); // one process failed, the rest still run: start over cleanly
    }
    const off = this.offsetFor(project.root);
    const specs = project.processes?.length ? project.processes : [{ name: "app", command: project.devCommand }];
    const blank = specs.find((s) => !s.command.trim());
    if (blank) return this.refuse(`Shrike doesn't know how to start ${specs.length > 1 ? `the "${blank.name}" process` : "your app"}. Open Setup and type the command you use, like npm run dev.`);
    const wanted = [...new Set(specs.map((s) => shiftUrl(s.url, off)))];
    const others = new Set([...live].filter((r) => r !== this).flatMap((r) => r.urls.map(portOf)));
    const clash = wanted.map(portOf).find((p) => p && others.has(p));
    if (clash) return this.refuse(`Port ${clash} is already used by another of your runs in Shrike (a worktree), so this one can't start there. Stop that run first.`);
    const taken = await portTaken(wanted);
    if (taken) return this.refuse(`Port ${new URL(taken).port || new URL(taken).host} is already in use by another program, so Shrike can't see your app there. Stop that program, then press Run again.`);

    // The project's .env (and the process folder's), as `source .env` would: the shell's own env and Shrike's settings win.
    const rootEnv = await readEnv(project.root, [".env"]);
    const dotenvs = await Promise.all(specs.map(async (s) => (s.cwd ? { ...rootEnv, ...(await readEnv(resolve(project.root, s.cwd), [".env"])) } : rootEnv)));
    const gen = ++this.gen;
    this.procs = [];
    this.stopping = false;
    this.pageUrl = shiftUrl(project.appUrl, off);
    this.firstUrl = undefined;
    const serverUrl = shiftUrl(env.serverUrl, off);
    this.urls = [...specs.map((s) => shiftUrl(s.url, off)), this.pageUrl, serverUrl].filter((u): u is string => !!u);
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.ELECTRON_RENDERER_URL;
    delete base.ELECTRON_RUN_AS_NODE;
    const ours = `--import=${pathToFileURL(env.nodeAgentRegister).href} --enable-source-maps`;
    Object.assign(base, { SHRIKE_INGEST_URL: env.ingestUrl, SHRIKE_TOKEN: env.token, SHRIKE_PROJECT_ROOT: project.root, FORCE_COLOR: "1", ...NO_TTY_ENV, ...portEnv(project, env.serverUrl, off) });

    for (const spec of specs) {
      // ponytail: a process whose URL is declared "outside" (a test double for a real API) runs without the recorder, so its lane stays outside.
      // Firebase emulators too: the CLI is Node, but the database lane comes from the page.
      const plain = project.declaredPlaces?.[hostOf(spec.url) ?? ""]?.kind === "outside" || /\bemulators:start\b/.test(spec.command);
      const url = shiftUrl(spec.url, off);
      const childEnv: NodeJS.ProcessEnv = { ...dotenvs[specs.indexOf(spec)], ...base, SHRIKE_SERVICE: spec.name, ...(portOf(url) ? { PORT: portOf(url) } : {}) };
      if (!plain) {
        childEnv.NODE_OPTIONS = base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ${ours}` : ours;
        addOtelEnv(childEnv, spec.name, env.ingestUrl, env.token);
      }
      const cwd = resolve(project.root, spec.cwd ?? ".");
      const rel = relative(project.root, cwd);
      if (rel.startsWith("..") || isAbsolute(rel)) return this.fail(`The "${spec.name}" process folder is outside the project: ${spec.cwd}`);
      let child: ChildProcess;
      try {
        child = spawnShell(spec.command, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        return this.fail(`Couldn't start "${spec.command}": ${(err as Error).message}`);
      }
      let done!: () => void;
      const p: Proc = { spec, cwd, root: project.root, child, state: "starting", startedAt: Date.now(), url, lines: [], partial: "", atLineStart: true, exited: new Promise((r) => (done = r)) };
      this.procs.push(p);
      child.stdout?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
      child.once("error", (err) => this.emitOutput(p, `\r\n${err.message}\r\n`));
      child.once("close", (code, signal) => {
        done();
        if (gen === this.gen) this.onExit(p, code, signal);
      });
    }
    this.set({ state: "starting", url: this.pageUrl });
    for (const p of this.procs) this.emitOutput(p, `$ ${p.spec.command}\r\n`);
    void this.waitReady(gen, project, serverUrl);
    return this.status;
  }

  private async fail(error: string): Promise<RunStatus> {
    await this.stop();
    this.set({ state: "error", error });
    return this.status;
  }

  private onExit(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    p.exitCode = code;
    if (p.managed) {
      // R3: the start agent reads why (service_logs) and fixes it; the other services keep running.
      p.state = this.stopping || p.stopRequested || code === 0 ? "stopped" : "error";
      if (p.state === "error") p.error = `The "${p.spec.name}" service ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}.${errorTail(p.lines) ? `\n${errorTail(p.lines)}` : ""}`;
      return this.refresh();
    }
    const wasRunning = this.status.state === "running";
    // One process of several that finishes cleanly (a seed or cron script) is done, not broken.
    if (this.stopping || (code === 0 && (wasRunning || this.procs.length > 1))) p.state = "stopped";
    else {
      const tail = errorTail(p.lines);
      const why = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      const who = this.procs.length === 1 ? "Your dev command" : `The "${p.spec.name}" process`;
      p.state = "error";
      p.error = `${who} ${why}.${tail ? `\n${tail}` : ""}${code === 127 && ![p.cwd, p.root].some((d) => existsSync(join(d, "node_modules"))) ? `\nYour project's packages aren't installed. Run your install command (like npm install) in ${p.spec.cwd ?? "the project folder"}, then press Run.` : ""}`;
      // Once up, one failing process of several shows on that process only (O4); while starting it fails the run and stops the rest, so their ports are free for Run.
      if (!this.stopping && !(wasRunning && this.alive().length)) {
        this.set({ ...this.status, state: "error", error: p.error });
        if (!wasRunning) void this.stop(true);
        return;
      }
    }
    if (this.alive().length) return this.refresh();
    if (this.status.state === "error") return this.refresh();
    this.set({ state: "stopped" });
  }

  private emitOutput(p: Proc, chunk: string): void {
    this.opts.onProcessOutput?.(p.spec.name, chunk);
    if (this.procs.length < 2) this.opts.onOutput(chunk);
    else {
      let out = "";
      for (const piece of chunk.split(/(?<=\n)/)) {
        if (p.atLineStart) out += `[${p.spec.name}] `;
        out += piece;
        p.atLineStart = piece.endsWith("\n");
      }
      this.opts.onOutput(out);
    }
    const parts = (p.partial + chunk).split(/\r?\n/);
    p.partial = parts.pop() ?? "";
    for (const line of parts) this.onLine(p, line);
    if (p.partial.length > 8192) {
      this.onLine(p, p.partial);
      p.partial = "";
    }
  }

  private onLine(p: Proc, line: string): void {
    p.lines.push(line);
    if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
    if (this.status.state !== "starting") return;
    const found = detectUrl(line);
    // Only this computer's URLs say where a service listens (Nix prints https://cache.nixos.org while it downloads).
    if (!found || !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/.test(found.url)) return;
    this.firstUrl ??= found.url;
    if (!p.url) {
      p.url = found.url;
      this.refresh();
    }
    if (found.local && !this.pageUrl) {
      this.pageUrl = found.url;
      this.set({ ...this.status, url: found.url });
    }
  }

  private async waitReady(gen: number, project: ProjectInfo, serverUrl?: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const needPage = !!(project.appUrl || project.frontend);
    const live = () => gen === this.gen && this.status.state === "starting";
    while (live()) {
      let changed = false;
      for (const p of this.procs) {
        if (p.state !== "starting") continue;
        // node-agent's hello comes before user code runs, so a URL-less process must also live a moment.
        const up = p.url ? await responds(p.url) : Date.now() - p.startedAt >= QUIET_READY_MS;
        if (up && live() && p.state === "starting") {
          p.state = "running";
          changed = true;
        }
      }
      if (!live()) return;
      if (changed) this.refresh();
      // Old single-command behaviour: any URL the command printed may be the page.
      const page = needPage ? (this.pageUrl ?? (this.procs.length === 1 ? this.firstUrl : undefined)) : undefined;
      const pageUp = !needPage || (!!page && (await responds(page)));
      const serverUp = !serverUrl || (await responds(serverUrl));
      if (!live()) return;
      if (pageUp && serverUp && this.procs.every((p) => p.state === "running" || p.state === "stopped")) return this.set({ ...this.status, state: "running", url: page });
      if (Date.now() > deadline) {
        const slow = this.procs.find((p) => p.state === "starting");
        const error =
          needPage && !page
            ? "Couldn't find your app's URL in the dev command output within 45 seconds. Open Setup and type your app's address."
            : needPage && !pageUp
              ? `Your app didn't respond at ${page} within 45 seconds. Check the Terminal tab.`
              : slow
                ? `The "${slow.spec.name}" process didn't respond at ${slow.url} within 45 seconds. Check the Terminal tab.`
                : `Your API didn't respond at ${serverUrl} within 45 seconds. Check the Terminal tab.`;
        const why = this.procs.map((p) => lastProblem(p.lines)).findLast(Boolean);
        this.set({ ...this.status, state: "error", error: why ? `${error}\nThe last error it printed: ${why}` : error });
        return void this.stop(true);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---- R3: the start agent's executor. Services are added one at a time and live until Stop, not until the agent run ends. ----

  /** Start one long-running service of `project` (start_service). `instrument`: inject node-agent (Node services). */
  async startService(project: ProjectInfo, spec: ProcessSpec & { instrument?: boolean }, env: RunEnv): Promise<ServiceInfo> {
    const live = this.procs.find((p) => p.spec.name === spec.name && (p.state === "starting" || p.state === "running"));
    if (live) throw new Error(`The "${spec.name}" service is already running. Stop it first with stop_service.`);
    const cwd = resolve(project.root, spec.cwd ?? ".");
    const rel = relative(project.root, cwd);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The "${spec.name}" folder is outside the project: ${spec.cwd}`);
    if (!this.procs.some((p) => p.managed)) {
      this.procs = this.procs.filter((p) => p.state === "starting" || p.state === "running");
      this.pageUrl = undefined;
    }
    this.procs = this.procs.filter((p) => p.spec.name !== spec.name);
    const rootEnv = await readEnv(project.root, [".env"]);
    const dotenv = spec.cwd ? { ...rootEnv, ...(await readEnv(cwd, [".env"])) } : rootEnv;
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.ELECTRON_RENDERER_URL;
    delete base.ELECTRON_RUN_AS_NODE;
    const port = portOf(spec.url);
    // Same port vars as start() (W2), so a project's declared ports and worktree shifts hold for Claude-started services too.
    const childEnv: NodeJS.ProcessEnv = { ...dotenv, ...base, ...portEnv(project, env.serverUrl, this.offsetFor(project.root)), SHRIKE_INGEST_URL: env.ingestUrl, SHRIKE_TOKEN: env.token, SHRIKE_PROJECT_ROOT: project.root, SHRIKE_SERVICE: spec.name, FORCE_COLOR: "1", ...NO_TTY_ENV, ...(port ? { PORT: port } : {}) };
    // Same as start(): a service at a host declared "outside" (a test double for a real API) runs without the recorder.
    const outside = Object.entries(project.declaredPlaces ?? {}).some(([k, d]) => d.kind === "outside" && hostOf(shiftUrl(`http://${k}`, this.offsetFor(project.root))) === hostOf(spec.url));
    if (spec.instrument !== false && !outside) {
      const ours = `--import=${pathToFileURL(env.nodeAgentRegister).href} --enable-source-maps`;
      childEnv.NODE_OPTIONS = base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ${ours}` : ours;
      addOtelEnv(childEnv, spec.name, env.ingestUrl, env.token);
    }
    const child = spawnShell(spec.command, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let done!: () => void;
    const p: Proc = { managed: true, spec, cwd, root: project.root, child, state: "starting", startedAt: Date.now(), url: spec.url, lines: [], partial: "", atLineStart: true, exited: new Promise((r) => (done = r)) };
    this.procs.push(p);
    this.stopping = false;
    const gen = this.gen;
    child.stdout?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
    child.once("error", (err) => this.emitOutput(p, `\r\n${err.message}\r\n`));
    child.once("close", (code, signal) => {
      done();
      if (gen === this.gen) this.onExit(p, code, signal);
    });
    this.emitOutput(p, `$ ${spec.command}\r\n`);
    this.urls = [...new Set([...this.urls, ...(spec.url ? [spec.url] : [])])];
    if (this.status.state !== "running") this.set({ state: "starting" });
    else this.refresh();
    return this.serviceInfo(p);
  }

  private serviceInfo(p: Proc): ServiceInfo {
    return { name: p.spec.name, command: p.spec.command, cwd: p.spec.cwd, url: p.url, state: p.state, pid: p.child.pid, exitCode: p.exitCode, error: p.error, startedAt: p.startedAt };
  }

  services(): ServiceInfo[] {
    return this.procs.filter((p) => p.managed).map((p) => this.serviceInfo(p));
  }

  /** The service's last `n` output lines, colours removed. */
  serviceTail(name: string, n = 200): string[] | undefined {
    const p = this.procs.findLast((q) => q.spec.name === name);
    return p && [...p.lines, ...(p.partial ? [p.partial] : [])].slice(-n).map((l) => l.replace(ANSI, ""));
  }

  /** Stop one service and its whole process group. False when it wasn't running. */
  async stopService(name: string): Promise<boolean> {
    const p = this.procs.find((q) => q.spec.name === name && (q.state === "starting" || q.state === "running"));
    if (!p?.child.pid) return false;
    const pid = p.child.pid;
    p.stopRequested = true;
    killTree(pid, "SIGTERM");
    const timer = setTimeout(() => killTree(pid, "SIGKILL"), 3000);
    await p.exited;
    clearTimeout(timer);
    killTree(pid, "SIGKILL");
    p.state = "stopped";
    this.refresh();
    return true;
  }

  /** A service answered its health check. */
  markService(name: string, url?: string): void {
    const p = this.procs.find((q) => q.spec.name === name && q.state === "starting");
    if (!p) return;
    p.state = "running";
    if (url && !p.url) p.url = url;
    this.refresh();
  }

  /** R3: every service is healthy (and the page answers): the dock switches to the live app. */
  markRunning(url?: string): void {
    for (const p of this.procs) if (p.managed && p.state === "starting") p.state = "running";
    this.pageUrl = url;
    if (url) this.urls = [...new Set([...this.urls, url])];
    this.set({ state: "running", url, instrumented: this.status.instrumented });
  }

  /** The start agent gave up: say why, keep its services for a look (Stop ends them). */
  markFailed(error: string): void {
    const { processes: _, ...rest } = this.status;
    this.set({ ...rest, state: this.alive().length && rest.state === "running" ? "running" : "error", error });
  }

  /** keepError: a failed start stops what's left but keeps saying why. */
  async stop(keepError = false): Promise<RunStatus> {
    const procs = this.alive();
    if (!procs.length) {
      if (this.status.state === "starting" || this.status.state === "running") this.set({ state: "stopped" });
      return this.status;
    }
    this.stopping = true;
    for (const p of procs) if (p.child.pid) killTree(p.child.pid, "SIGTERM");
    const timer = setTimeout(() => procs.forEach((p) => p.child.pid && killTree(p.child.pid, "SIGKILL")), 3000);
    await Promise.all(procs.map((p) => p.exited));
    clearTimeout(timer);
    // Children that ignored SIGTERM (e.g. vite under `&`) may outlive the shell.
    for (const p of procs) if (p.child.pid) killTree(p.child.pid, "SIGKILL");
    if (keepError && this.status.state === "error") this.refresh();
    else if (this.status.state !== "stopped") this.set({ state: "stopped" });
    return this.status;
  }

  // Synchronous last resort for process exit.
  killNow(): void {
    for (const p of this.procs) if (p.child.pid) killTree(p.child.pid, "SIGKILL");
  }
}

/** The error line Node prints (not the stack frames after it), else the last few lines. */
export function errorTail(lines: string[]): string {
  const clean = lines.slice(-40).map((l) => l.replace(ANSI, "").trimEnd()).filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v\d/.test(l));
  const err = clean.findLast((l) => /^(Uncaught )?([A-Z]\w*)?(Error|Exception)\b.*:/.test(l.trim()));
  return err ? err.trim() : clean.slice(-5).join("\n").trim();
}


/** The last line that names a problem and says something past "Error:" (a child that crashed while its parent kept running). */
export function lastProblem(lines: string[]): string | undefined {
  return lines
    .map((l) => l.replace(ANSI, "").trim())
    .findLast((l) => !/^at |^(throw|await|return|const|let|var)\b|[;{]$/.test(l) && /\b(error|could not|couldn't|cannot|can't|failed|refused|EADDRINUSE)\b/i.test(l) && l.replace(/^\w*(error|exception):?/i, "").trim().length > 8);
}


export async function responds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual", headers: { "x-shrike-internal": "1" } });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** The first URL whose port already answers (another program holds it), after giving a just-stopped run a moment to let go. */
export async function portTaken(urls: (string | undefined)[], graceMs = 1500): Promise<string | undefined> {
  const deadline = Date.now() + graceMs;
  const ours = new Set([...live].flatMap((r) => r.urls.map(portOf)).filter(Boolean));
  for (;;) {
    let taken: string | undefined;
    for (const u of urls) if (u && !taken && !ours.has(portOf(u)) && (await responds(u))) taken = u;
    if (!taken || Date.now() > deadline) return taken;
    await new Promise((r) => setTimeout(r, 250));
  }
}
