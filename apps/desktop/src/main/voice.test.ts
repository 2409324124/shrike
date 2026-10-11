import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceEvent, VoiceModels } from "@shrike/schema";
import { VoiceHelper, VoiceModelStore, type ModelSpec } from "./voice.ts";
import { VoicePlanner, type Fork } from "./voice-planner.ts";
import { PLANNER_MODEL } from "./voice-planner-model.ts";

// ---------- V7 model store: resumable, checksummed, cancellable ----------

const A = Buffer.alloc(300_000, 7);
const B = Buffer.from("{\"ok\":true}\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function files(opts: { cut?: number; noRange?: boolean } = {}) {
  const seen: { url: string; range?: string }[] = [];
  let cutDone = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ url: req.url ?? "", range: req.headers.range });
    const body = req.url?.endsWith("/a.bin") ? A : req.url?.endsWith("/sub/b.json") ? B : null;
    if (!body) return res.writeHead(404).end();
    const m = !opts.noRange && /bytes=(\d+)-/.exec(req.headers.range ?? "");
    const from = m ? Number(m[1]) : 0;
    res.writeHead(m ? 206 : 200, { "content-length": body.length - from });
    if (opts.cut && !from && body === A && !cutDone) return void ((cutDone = true), res.write(body.subarray(0, opts.cut), () => setTimeout(() => res.destroy(), 50))); // the connection drops mid-file, once
    res.end(body.subarray(from));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/rev/`;
  return { base, seen, close: () => new Promise((r) => server.close(r)) };
}

const spec = (base: string, aSha = sha(A)): ModelSpec[] => [
  { id: "vad", name: "Tiny", license: "MIT", base, dir: "vad", files: [{ path: "a.bin", bytes: A.length, sha256: aSha }, { path: "sub/b.json", bytes: B.length, sha256: sha(B) }] },
  { id: "planner", name: "Flat", license: "MIT", base, dir: "", files: [{ path: "sub/b.json", bytes: B.length, sha256: sha(B) }] },
];

test("models: downloads into userData, verifies sha256, marks the bundle ready and tells the helper", async () => {
  const srv = await files();
  const dir = mkdtempSync(join(tmpdir(), "shrike-models-"));
  const events: VoiceModels[] = [];
  let reloads = 0;
  try {
    const store = new VoiceModelStore(dir, (m) => events.push(m), () => reloads++, spec(srv.base));
    assert.deepEqual((await store.list()).models.map((m) => m.state), ["missing", "missing"]);
    await store.download();
    await store.idle();
    const after = await store.list();
    assert.deepEqual(after.models.map((m) => m.state), ["ready", "ready"]);
    assert.ok(after.freeBytes > 0);
    assert.ok(existsSync(join(dir, "vad/ready")) && !existsSync(join(dir, "ready")), "bundle marker only inside a folder");
    assert.deepEqual(readFileSync(join(dir, "vad/a.bin")), A);
    assert.ok(existsSync(join(dir, "sub/b.json")), "the planner's file sits at the models root");
    assert.ok(events.some((e) => e.models.some((m) => m.state === "verifying")));
    assert.equal(reloads, 2);
    await store.remove("vad");
    assert.ok(!existsSync(join(dir, "vad")));
    assert.equal((await store.list()).models[0]!.state, "missing");
    assert.equal(reloads, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("models: a cut download resumes from its .part with a Range request", async () => {
  const srv = await files({ cut: 100_000 });
  const dir = mkdtempSync(join(tmpdir(), "shrike-models-"));
  try {
    const store = new VoiceModelStore(dir, () => {}, () => {}, spec(srv.base).slice(0, 1));
    await store.download();
    await store.idle();
    assert.equal((await store.list()).models[0]!.state, "failed");
    await store.download();
    await store.idle();
    assert.equal((await store.list()).models[0]!.state, "ready");
    assert.ok(srv.seen.some((s) => s.url.endsWith("/a.bin") && /^bytes=\d+-$/.test(s.range ?? "") && s.range !== "bytes=0-"), JSON.stringify(srv.seen));
    assert.deepEqual(readFileSync(join(dir, "vad/a.bin")), A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("models: a checksum mismatch deletes the file and fails in plain words; nothing is marked ready", async () => {
  const srv = await files();
  const dir = mkdtempSync(join(tmpdir(), "shrike-models-"));
  try {
    const store = new VoiceModelStore(dir, () => {}, () => assert.fail("no reload for a bad file"), spec(srv.base, "0".repeat(64)).slice(0, 1));
    await store.download();
    await store.idle();
    const m = (await store.list()).models[0]!;
    assert.equal(m.state, "failed");
    assert.match(m.error ?? "", /checksum/);
    assert.ok(!existsSync(join(dir, "vad/a.bin")) && !existsSync(join(dir, "vad/a.bin.part")) && !existsSync(join(dir, "vad/ready")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("models: a server that ignores Range starts the file over instead of corrupting it", async () => {
  const srv = await files({ noRange: true });
  const dir = mkdtempSync(join(tmpdir(), "shrike-models-"));
  try {
    const store = new VoiceModelStore(dir, () => {}, () => {}, spec(srv.base).slice(0, 1));
    mkdirSync(join(dir, "vad"), { recursive: true });
    writeFileSync(join(dir, "vad/a.bin.part"), A.subarray(0, 5000));
    await store.download();
    await store.idle();
    assert.equal((await store.list()).models[0]!.state, "ready");
    assert.deepEqual(readFileSync(join(dir, "vad/a.bin")), A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

// ---------- V1 helper protocol ----------

const nativeDir = join(import.meta.dirname, "../../native/voice");
const built = existsSync(join(nativeDir, "build/ShrikeVoice.app/Contents/MacOS/ShrikeVoice"));

test("helper: the real ShrikeVoice binary in --fake mode speaks the protocol over the token-checked socket", { skip: process.platform !== "darwin" || !built ? "ShrikeVoice.app not built (native/voice/build.sh)" : false }, async () => {
  const events: VoiceEvent[] = [];
  const h = new VoiceHelper({ nativeDir, emit: (e) => events.push(e), testArgs: ["--fake", "show the logs please|next"] });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 30));
    assert.ok(pred(), JSON.stringify(events));
  };
  try {
    h.send({ cmd: "context", words: ["todos controller"] });
    h.send({ cmd: "start", id: 7 });
    await until(() => events.some((e) => e.type === "partial" && e.text === "show the logs please"));
    h.send({ cmd: "stop" });
    await until(() => events.some((e) => e.type === "final"));
    assert.deepEqual(events.find((e) => e.type === "final"), { type: "final", id: 7, text: "show the logs please" });
    assert.ok(events.some((e) => e.type === "ready"));
    assert.ok(events.some((e) => e.type === "level"));
    h.send({ cmd: "start", id: 8 });
    h.send({ cmd: "stop" });
    await until(() => events.some((e) => e.type === "final" && e.id === 8));

    // A stranger on the same port is dropped before it can inject anything.
    const port = (h as unknown as { server: { address(): { port: number } } }).server.address().port;
    const before = events.length;
    const s = connect(port, "127.0.0.1");
    await new Promise((r) => s.on("connect", r));
    s.write(`${JSON.stringify({ type: "hello", token: "nope" })}\n${JSON.stringify({ type: "final", id: 9, text: "ship it" })}\n`);
    await new Promise((r) => s.on("close", r));
    assert.equal(events.length, before);
  } finally {
    h.close();
  }
});

// ---------- reliability: a planner model that won't load ----------

test("planner: a model that won't load says broken once, isn't reloaded every turn, and is tried again after a new download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-planner-"));
  const model = join(dir, PLANNER_MODEL.file);
  const fd = openSync(model, "w");
  ftruncateSync(fd, PLANNER_MODEL.bytes); // sparse: right size, not a model
  closeSync(fd);
  let forks = 0;
  let mode: "error" | "crash" | "throw" | "ok" = "error";
  const fork: Fork = () => {
    forks++;
    if (mode === "throw") throw new Error("node-llama-cpp failed to load");
    const ev = new EventEmitter();
    const proc = Object.assign(ev, {
      postMessage(m: { type: string; id?: number }) {
        setImmediate(() => {
          if (m.type === "load") mode === "error" ? ev.emit("message", { type: "error", message: "bad magic" }) : mode === "crash" ? ev.emit("exit", 1) : ev.emit("message", { type: "ready" });
          else ev.emit("message", { type: "reply", id: m.id, ok: true, json: { steps: [] }, ms: 5 });
        });
      },
      kill: () => void setImmediate(() => ev.emit("exit", 0)),
    });
    return proc as never;
  };
  const p = new VoicePlanner(dir, "worker.js", fork);
  const req = { prefix: "p", context: "", text: "what did the server print", schema: {} };
  try {
    assert.deepEqual(await p.plan(req), { ok: false, error: "broken" });
    assert.equal(forks, 0, "zeros of the right size aren't a GGUF: no load to find out");

    const head = openSync(model, "r+");
    writeSync(head, "GGUF", 0);
    closeSync(head);
    utimesSync(model, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(await p.plan(req), { ok: false, error: "broken" }); // node-llama-cpp rejects the rest of it
    assert.deepEqual(await p.plan(req), { ok: false, error: "broken" });
    assert.equal(forks, 1, "a model that failed to load isn't forked again each turn");
    assert.equal(await p.warm("p"), false);
    assert.equal(forks, 1);

    utimesSync(model, new Date(), new Date(Date.now() + 5000)); // downloaded again
    mode = "crash"; // node-llama-cpp's native side takes the worker down
    assert.deepEqual(await p.plan(req), { ok: false, error: "broken" });
    assert.equal(forks, 2);

    utimesSync(model, new Date(), new Date(Date.now() + 10_000));
    mode = "throw"; // the worker can't even start
    assert.deepEqual(await p.plan(req), { ok: false, error: "broken" });
    assert.equal(forks, 3);

    utimesSync(model, new Date(), new Date(Date.now() + 15_000));
    mode = "ok";
    assert.equal((await p.plan(req)).ok, true);
    rmSync(model);
    p.close();
    assert.deepEqual(await p.plan(req), { ok: false, error: "missing" });
  } finally {
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- reliability: a missing or crashing helper ----------

/** A stand-in ShrikeVoice that says hello, notes each launch in `log`, and exits when a turn starts (a crash mid-session). */
function fakeHelperDir(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "shrike-voice-"));
  const log = join(dir, "launches");
  const bin = join(dir, "build/ShrikeVoice.app/Contents/MacOS");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "ShrikeVoice"),
    `#!${process.execPath}
const a = process.argv.slice(2), o = (k) => a[a.indexOf(k) + 1];
require("fs").appendFileSync(${JSON.stringify(log)}, "x");
const s = require("net").connect(Number(o("--port")), "127.0.0.1", () => s.write(JSON.stringify({ type: "hello", token: o("--token") }) + "\\n" + JSON.stringify({ type: "ready", onDevice: true, available: true, speech: "granted", mic: "granted" }) + "\\n"));
s.on("data", (d) => String(d).includes('"start"') && process.exit(1));
s.on("close", () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return { dir, log };
}

const macOnly = { skip: process.platform !== "darwin" ? "the helper is macOS only" : false };
const launches = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").length : 0);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test("helper: missing from this copy of Shrike fails in plain words, and stop or hands off never tries to start it", macOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-voice-"));
  const events: VoiceEvent[] = [];
  const h = new VoiceHelper({ nativeDir: dir, emit: (e) => events.push(e) });
  try {
    h.send({ cmd: "start", id: 1 });
    await settle();
    const errors = events.filter((e) => e.type === "error");
    assert.equal(errors.length, 1, JSON.stringify(events));
    assert.doesNotMatch(JSON.stringify(errors[0]), /ENOENT|spawn|build\.sh/);
    h.send({ cmd: "stop" });
    h.send({ cmd: "hands", on: false });
    await settle();
    assert.equal(events.filter((e) => e.type === "error").length, 1, "no second start attempt");
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("helper: a crash mid-turn says Voice stopped, and turning things off after it doesn't relaunch it", macOnly, async () => {
  const { dir, log } = fakeHelperDir();
  const events: VoiceEvent[] = [];
  const h = new VoiceHelper({ nativeDir: dir, emit: (e) => events.push(e), testArgs: [] });
  try {
    h.send({ cmd: "start", id: 1 });
    for (let i = 0; i < 100 && !events.some((e) => e.type === "error"); i++) await settle(50);
    assert.match(JSON.stringify(events.find((e) => e.type === "error")), /Voice stopped/);
    assert.equal(launches(log), 1);
    h.send({ cmd: "stop" });
    h.send({ cmd: "hands", on: false });
    h.send({ cmd: "arm", on: false });
    await settle(800);
    assert.equal(launches(log), 1, "off commands to a dead helper stay quiet");
    h.send({ cmd: "start", id: 2 }); // the next press starts it again
    for (let i = 0; i < 100 && launches(log) < 2; i++) await settle(50);
    assert.equal(launches(log), 2);
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
