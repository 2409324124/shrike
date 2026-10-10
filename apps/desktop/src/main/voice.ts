import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { VoiceCommand, VoiceEvent, VoiceModel, VoiceModelId, VoiceModels } from "@shrike/schema";
import { PLANNER_MODEL } from "./voice-planner-model.ts";

// V1: talks to ShrikeVoice.app (native/voice): mic, VAD and Nemotron ASR in its own bundle so the mic prompt names it.
// It connects back over localhost TCP and proves itself with a token. V7: the models it loads, downloaded here.

export interface VoiceDeps {
  nativeDir: string; // apps/desktop/native/voice
  modelsDir?: string; // userData/voice-models, handed to the helper
  emit(e: VoiceEvent): void;
  testArgs?: string[]; // tests: run the binary directly with these (--fake "show logs|next", --wav "a.wav|b.wav")
}

const HELLO_MS = 15_000; // a cold `open` plus a first-run build can be slow
const BUILD_MS = 600_000; // first build compiles MLX: a few minutes, once

export class VoiceHelper {
  private server: Server | undefined;
  private sock: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private queue: VoiceCommand[] = [];
  private sticky = new Map<string, VoiceCommand>(); // config, context, hands: replayed to a restarted helper
  private restarts: number[] = [];
  private deps: VoiceDeps;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  get appPath(): string {
    return join(this.deps.nativeDir, "build/ShrikeVoice.app");
  }

  get running(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  send(cmd: VoiceCommand): void {
    if (cmd.cmd === "config" || cmd.cmd === "context" || cmd.cmd === "hands") this.sticky.set(cmd.cmd, cmd);
    if (this.sock && !this.sock.destroyed) return void this.sock.write(`${JSON.stringify(cmd)}\n`);
    this.queue.push(cmd);
    void this.ensure().catch((e: Error) => {
      this.queue = [];
      this.deps.emit({ type: "error", message: e.message });
    });
  }

  /** Starts the helper once; later calls share the same connection. */
  ensure(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Voice needs macOS for now.");
    await this.build();
    const token = randomBytes(16).toString("hex");
    const server = (this.server ??= createServer());
    server.removeAllListeners("connection");
    await new Promise<void>((ok, fail) => (server.listening ? ok() : server.once("error", fail).listen(0, "127.0.0.1", () => ok())));
    const port = (server.address() as { port: number }).port;
    const got = new Promise<Socket>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Voice didn't start. Try again, or rebuild it with pnpm --filter @shrike/desktop voice:build.")), HELLO_MS);
      server.on("connection", (s) => {
        let buf = "";
        let trusted = false;
        s.setEncoding("utf8");
        s.setNoDelay(true);
        const drop = setTimeout(() => !trusted && s.destroy(), 3000);
        s.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.length > 1_000_000) return void s.destroy();
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            const msg = parseLine(line);
            if (!msg) continue;
            if (!trusted) {
              if (msg.type !== "hello" || msg.token !== token) return void s.destroy(); // not ours
              trusted = true;
              clearTimeout(drop);
              clearTimeout(timer);
              ok(s);
              continue;
            }
            if (msg.type !== "stat") this.deps.emit(msg as VoiceEvent);
          }
        });
        s.on("close", () => {
          clearTimeout(drop);
          if (this.sock === s) {
            this.sock = undefined;
            const hands = this.sticky.get("hands");
            this.restarts = [...this.restarts.filter((t) => Date.now() - t < 60_000), Date.now()];
            if (hands?.cmd === "hands" && hands.on && this.restarts.length <= 3) return void this.ensure().catch(() => this.deps.emit({ type: "error", message: "Voice stopped. Hold ⌥ Space to start it again." })); // hands-free has no next press to restart it
            this.deps.emit({ type: "error", message: "Voice stopped. Hold ⌥ Space to start it again." });
          }
        });
        s.on("error", () => {});
      });
    });
    this.launch(port, token);
    this.sock = await got;
    const queued = this.queue.splice(0);
    for (const c of [...[...this.sticky.values()].filter((c) => !queued.includes(c)), ...queued]) this.sock.write(`${JSON.stringify(c)}\n`);
  }

  /** Builds the helper when it's missing or older than its source (one-time; the first build compiles MLX). */
  private async build(): Promise<void> {
    const bin = join(this.appPath, "Contents/MacOS/ShrikeVoice");
    const srcs = ["ShrikeVoice.swift", "Package.swift", "build.sh", "Info.plist"].map((f) => join(this.deps.nativeDir, f)).filter(existsSync);
    if (existsSync(bin) && srcs.every((s) => statSync(bin).mtimeMs >= statSync(s).mtimeMs)) return;
    this.deps.emit({ type: "setup" });
    await new Promise<void>((ok, fail) =>
      execFile(join(this.deps.nativeDir, "build.sh"), { timeout: BUILD_MS }, (err, _o, stderr) =>
        err ? fail(new Error(`Couldn't build voice (needs Xcode): ${String(stderr).trim().split("\n").at(-1) || err.message}`)) : ok(),
      ),
    );
  }

  private launch(port: number, token: string): void {
    const args = ["--port", String(port), "--token", token, ...(this.deps.modelsDir ? ["--models", this.deps.modelsDir] : [])];
    if (this.deps.testArgs) {
      const p = spawn(join(this.appPath, "Contents/MacOS/ShrikeVoice"), [...args, ...this.deps.testArgs], { stdio: "ignore" });
      p.on("error", () => {});
      return;
    }
    // Through LaunchServices, so ShrikeVoice (not Electron) is the process macOS asks about. -g: stay in the background.
    execFile("open", ["-g", "-n", "-a", this.appPath, "--args", ...args], (err) => err && this.deps.emit({ type: "error", message: `Couldn't start voice: ${err.message}` }));
  }

  /** The helper exits when its socket closes. */
  close(): void {
    this.sock?.end(`${JSON.stringify({ cmd: "quit" })}\n`);
    this.sock?.destroy();
    this.sock = undefined;
    this.server?.close();
    this.server = undefined;
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

// ---------- V7 models ----------

export interface ModelSpec {
  id: VoiceModelId;
  name: string;
  license: string;
  base: string; // files are fetched from base + path (a pinned Hugging Face revision)
  dir: string; // under userData/models; "" for the planner's single file
  files: { path: string; bytes: number; sha256: string }[];
}

const hf = (repo: string, rev: string) => `https://huggingface.co/${repo}/resolve/${rev}/`;

// docs/16-voice.md. Pinned revisions; every file is checked against its sha256 before the helper may load it.
export const VOICE_MODELS: ModelSpec[] = [
  {
    id: "vad",
    name: "Silero VAD v6.2",
    license: "MIT",
    base: hf("aufklarer/Silero-VAD-v6.2.1-CoreML", "523876545a57961474fee9df913e833e130560b8"),
    dir: "vad",
    files: [
      { path: "config.json", bytes: 888, sha256: "459e764d58cdc13f3db6878adfdf8a29b5fd467ad1f4ef2161137cc115339c81" },
      { path: "silero_vad.mlmodelc/analytics/coremldata.bin", bytes: 243, sha256: "b777c3751d72b7430eac7f8544769a3d918faf77c15db184fec30e44c56007a3" },
      { path: "silero_vad.mlmodelc/coremldata.bin", bytes: 399, sha256: "f6fcd92c3132c9c718e5f54e0e770a8c8075beaa50a5b212a6287273b4ddae67" },
      { path: "silero_vad.mlmodelc/metadata.json", bytes: 3005, sha256: "1b953eb3818e7092deedd96e976c05354f77beb2ddc2976fe416af17e47f62d2" },
      { path: "silero_vad.mlmodelc/model.mil", bytes: 18203, sha256: "b0a1384c4a664697989d9eb9cfb166b4b85f151206aeefd1bfa391ef9e5ad08f" },
      { path: "silero_vad.mlmodelc/weights/weight.bin", bytes: 619136, sha256: "83210545de90c65195e8d6db1b349b7e5c31f989f48d0a908a8dc0e2f586e5f9" },
    ],
  },
  {
    id: "turn",
    name: "Smart Turn v3.2",
    license: "BSD-2-Clause",
    base: hf("aufklarer/Smart-Turn-v3.2-CoreML", "75f069717f500947195fa1945c46ddb472559cff"),
    dir: "turn",
    files: [
      { path: "LICENSE", bytes: 1406, sha256: "db31415d226689aaf6fa6274da0416171edb70ca7ebf97bd3d99d8d8b88cd34e" },
      { path: "config.json", bytes: 1029, sha256: "bc09d1b40285465b389dc42cef54290fa1db7b4928348018bc61d819b4914402" },
      { path: "smart_turn.mlmodelc/analytics/coremldata.bin", bytes: 243, sha256: "1646746d0029e78d26be065e62602d4f89e51013ec238b653adf7d7d21057f89" },
      { path: "smart_turn.mlmodelc/coremldata.bin", bytes: 643, sha256: "9245ac99889c9d738cba6c89da9e851fd16488bf8effbc15a109d06b401c9383" },
      { path: "smart_turn.mlmodelc/model.mil", bytes: 69968, sha256: "41a6d9ac0f7d01d738e56ecdf4435e55f139591541b7cf1a4dba6b9ce2f1c9ef" },
      { path: "smart_turn.mlmodelc/weights/weight.bin", bytes: 16714240, sha256: "b6295316741a0149e1fcab7cdf030e1b9bfb0eef778207accee91a2a9703a39c" },
    ],
  },
  {
    id: "asr",
    name: "Nemotron 3.5 ASR Streaming 0.6B",
    license: "OpenMDW-1.1",
    base: hf("aufklarer/Nemotron-3.5-ASR-Streaming-0.6B-MLX-5bit", "f61b87ba929caeeed675393358413260d103babb"),
    dir: "asr",
    files: [
      { path: "config.json", bytes: 1718, sha256: "8ff09db6700fd2e43ef2b1007c3a7464e369b40ef02d24d3a52ce0fcc1f94e5b" },
      { path: "lang2slot.json", bytes: 1710, sha256: "bbb41d0ed80b34d2f8a479f8b9054454b095a562b081f03e385b8854fc054af1" },
      { path: "languages.json", bytes: 2020, sha256: "a1efe863e1057d4658bce8175c978020ac35a63a3c9a65ae899f324a32c8e4f6" },
      { path: "model.safetensors", bytes: 564236441, sha256: "105da31cd6b14e0f5fea6968a06722847fa5aca1cccb3bf2a6b0c3a46ce3c8a5" },
      { path: "tokenizer.model", bytes: 406554, sha256: "ce3895e40806f02a26c3a225161b96ef682d6c0054bae32a245dec4258d7d291" },
      { path: "vocab.json", bytes: 103278, sha256: "f7218f3ae2c5baf002974a7babf50ee1f719732fb1f349eeefb86b62219dc0cd" },
    ],
  },
  {
    id: "planner",
    name: PLANNER_MODEL.name,
    license: PLANNER_MODEL.license,
    base: PLANNER_MODEL.url.slice(0, -PLANNER_MODEL.file.length),
    dir: "",
    files: [{ path: PLANNER_MODEL.file, bytes: PLANNER_MODEL.bytes, sha256: PLANNER_MODEL.sha256 }],
  },
];

const SPARE = 256 * 1024 * 1024; // never fill the disk to the last byte
const READY = "ready"; // written into a bundle's folder after every file passed its sha256 check; the helper loads only bundles that have it

/**
 * Downloads, verifies and deletes the voice models in userData. Resumes a cut download from its `.part`
 * files. One download runs at a time, the small models first, so hands-free works before the big one lands.
 */
export class VoiceModelStore {
  private live = new Map<VoiceModelId, Partial<VoiceModel>>();
  private abort: AbortController | undefined;
  private running: Promise<void> | undefined;
  private wanted: VoiceModelId[] = [];
  private lastEmit = 0;
  private current: VoiceModelId | undefined;

  readonly dir: string;
  private emit: (m: VoiceModels) => void;
  private onReady: () => void; // a model landed or went away: the helper reloads
  private specs: ModelSpec[];
  private fetchImpl: typeof fetch;

  constructor(dir: string, emit: (m: VoiceModels) => void, onReady: () => void, specs: ModelSpec[] = VOICE_MODELS, fetchImpl: typeof fetch = fetch) {
    this.dir = dir;
    this.emit = emit;
    this.onReady = onReady;
    this.specs = specs;
    this.fetchImpl = fetchImpl;
  }

  async list(): Promise<VoiceModels> {
    const models = await Promise.all(
      this.specs.map(async (s): Promise<VoiceModel> => {
        const bytes = s.files.reduce((n, f) => n + f.bytes, 0);
        const base: VoiceModel = { id: s.id, name: s.name, license: s.license, bytes, state: this.isReady(s) ? "ready" : "missing" };
        const l = this.live.get(s.id);
        if (base.state === "ready" || !l) return base;
        return { ...base, ...l };
      }),
    );
    await mkdir(this.dir, { recursive: true }).catch(() => {});
    const fs = await statfs(this.dir).catch(() => undefined);
    return { models, freeBytes: fs ? fs.bavail * fs.bsize : 0 };
  }

  /** A file reaches its real name only after its sha256 matched; a bundle also needs the marker the helper loads by. */
  private isReady(s: ModelSpec): boolean {
    return (!s.dir || existsSync(join(this.dir, s.dir, READY))) && s.files.every((f) => existsSync(join(this.dir, s.dir, f.path)) && statSync(join(this.dir, s.dir, f.path)).size === f.bytes);
  }

  private async publish(force = false): Promise<void> {
    if (!force && Date.now() - this.lastEmit < 150) return;
    this.lastEmit = Date.now();
    this.emit(await this.list());
  }

  /** Queues models (default: all missing) and resolves with the state right after queueing. */
  async download(id?: VoiceModelId): Promise<VoiceModels> {
    for (const s of this.specs) if ((!id || s.id === id) && !this.isReady(s) && !this.wanted.includes(s.id)) this.wanted.push(s.id);
    for (const w of this.wanted) if (!this.live.has(w) || this.live.get(w)?.state === "failed") this.live.set(w, { state: "downloading", got: 0 });
    this.running ??= this.drain().finally(() => (this.running = undefined));
    await this.publish(true);
    return this.list();
  }

  async cancel(id?: VoiceModelId): Promise<VoiceModels> {
    this.wanted = id ? this.wanted.filter((w) => w !== id) : [];
    if (!id || this.current === id) this.abort?.abort();
    for (const [k] of this.live) if (!id || k === id) this.live.delete(k);
    await this.publish(true);
    return this.list();
  }

  async remove(id?: VoiceModelId): Promise<VoiceModels> {
    await this.cancel(id);
    await this.running?.catch(() => {});
    for (const s of this.specs) {
      if (id && s.id !== id) continue;
      if (s.dir) await rm(join(this.dir, s.dir), { recursive: true, force: true });
      else for (const f of s.files) for (const p of [f.path, `${f.path}.part`]) await rm(join(this.dir, p), { force: true });
    }
    this.onReady();
    await this.publish(true);
    return this.list();
  }

  /** Resolves when nothing is downloading (tests). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    for (let id = this.wanted[0]; id; id = this.wanted[0]) {
      const spec = this.specs.find((s) => s.id === id)!;
      this.current = id;
      this.abort = new AbortController();
      try {
        await this.fetchModel(spec, this.abort.signal);
        this.live.delete(id);
        this.onReady();
      } catch (e) {
        if (this.abort.signal.aborted) this.live.delete(id);
        else this.live.set(id, { state: "failed", error: errText(e) });
      }
      this.wanted = this.wanted.filter((w) => w !== id);
      this.current = undefined;
      await this.publish(true);
    }
  }

  private async fetchModel(spec: ModelSpec, signal: AbortSignal): Promise<void> {
    const root = join(this.dir, spec.dir);
    await mkdir(root, { recursive: true });
    const total = spec.files.reduce((n, f) => n + f.bytes, 0);
    const done = async (f: ModelSpec["files"][number]) => (await stat(join(root, f.path)).catch(() => undefined))?.size === f.bytes;
    const partSize = async (f: ModelSpec["files"][number]) => (await stat(join(root, `${f.path}.part`)).catch(() => undefined))?.size ?? 0;
    let have = 0;
    for (const f of spec.files) have += (await done(f)) ? f.bytes : await partSize(f);
    const fs = await statfs(this.dir);
    if (fs.bavail * fs.bsize < total - have + SPARE) throw new Error(`Not enough disk space: ${spec.name} needs ${mb(total - have + SPARE)} free, ${mb(fs.bavail * fs.bsize)} left.`);
    let got = have;
    this.live.set(spec.id, { state: "downloading", got });
    for (const f of spec.files) {
      if (await done(f)) continue;
      const dest = join(root, f.path);
      const part = `${dest}.part`;
      await mkdir(dirname(dest), { recursive: true });
      const from = await partSize(f);
      if (from === f.bytes) continue; // came down whole last time, not verified yet
      const res = await this.fetchImpl(spec.base + f.path, { headers: from ? { range: `bytes=${from}-` } : {}, signal });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}). Check your connection and try again.`);
      const resumed = from > 0 && res.status === 206;
      if (from && !resumed) got -= from; // the server sent the whole file again
      const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
      body.on("data", (c: Buffer) => {
        got += c.length;
        this.live.set(spec.id, { state: "downloading", got });
        void this.publish();
      });
      await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }), { signal });
      if ((await stat(part)).size !== f.bytes) throw new Error(`${f.path} came down the wrong size. Try again.`);
    }
    this.live.set(spec.id, { state: "verifying", got: total });
    await this.publish(true);
    for (const f of spec.files) {
      const dest = join(root, f.path);
      const file = existsSync(`${dest}.part`) ? `${dest}.part` : dest;
      if ((await sha256(file)) !== f.sha256) {
        await rm(file, { force: true });
        throw new Error(`${f.path} didn't match its checksum, so it was deleted. Download it again.`);
      }
      if (file !== dest) await rename(file, dest);
    }
    if (spec.dir) await writeFile(join(root, READY), `${spec.base}\n`);
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => ok(h.digest("hex")))
      .on("error", fail);
  });
}

const mb = (n: number) => `${Math.ceil(n / 1_048_576)} MB`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
