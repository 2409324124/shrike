import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceEvent, VoiceModels } from "@shrike/schema";
import { VoiceHelper, VoiceModelStore, type ModelSpec } from "./voice.ts";

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
