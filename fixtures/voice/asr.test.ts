import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lev, translit } from "../../apps/desktop/src/renderer/src/voice/understand/normalize.ts";
import { noiseWav } from "./eval.ts";

// ASR gates (docs/16, "Hearing"): the real helper fed fixtures/voice in real time, the way the mic feeds it.
// Push-to-talk: every corpus clip, released at the end of its audio (--autostop). Hands-free: mid-sentence pauses stay
// one turn, finished ones fire fast, and two minutes of fan noise open no turn. Skips without the helper or the models.
//   node --test fixtures/voice/asr.test.ts          (SHRIKE_MODELS=<dir> for models outside the dev app's userData)

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.SHRIKE_VOICE_BIN ?? join(HERE, "../../apps/desktop/native/voice/build/ShrikeVoice.app/Contents/MacOS/ShrikeVoice");
const MODELS = process.env.SHRIKE_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models");
const HINT: Record<string, string> = { en: "en", hi: "hi", hinglish: "hi", "hinglish-roman": "hi", es: "es", fr: "fr", de: "de", ja: "ja" };
const GATES = { finalP50: 160, finalP95: 250, footprintMB: 1024, warmLoadMs: 1500, pauseP50: 300, idleCpu: 5, speakingCpu: 150 };
const skip = !existsSync(BIN) ? "helper not built (apps/desktop/native/voice/build.sh)" : !existsSync(join(MODELS, "asr/ready")) ? `speech model not in ${MODELS}` : false;

type Msg = Record<string, any>;
class Helper {
  p: ChildProcessWithoutNullStreams;
  seen: (Msg & { at: number })[] = [];
  private buf = "";
  constructor(args: string[]) {
    this.p = spawn(BIN, ["--models", MODELS, "--stats", ...args]);
    this.p.stdout.setEncoding("utf8").on("data", (c: string) => {
      this.buf += c;
      for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
        this.seen.push({ ...JSON.parse(this.buf.slice(0, i)), at: performance.now() });
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  send = (o: object) => this.p.stdin.write(`${JSON.stringify(o)}\n`);
  async wait(pred: (m: Msg) => boolean, ms = 20_000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.seen.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`helper: timed out (${this.seen.slice(-3).map((m) => JSON.stringify(m)).join(" ")})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  cpu = (): number => Number(execFileSync("ps", ["-o", "%cpu=", "-p", String(this.p.pid)]).toString().trim()) || 0;
  rssMB = (): number => Number(execFileSync("ps", ["-o", "rss=", "-p", String(this.p.pid)]).toString().trim()) / 1024 || 0;
  quit(): void {
    this.send({ cmd: "quit" });
    setTimeout(() => this.p.kill(), 500);
  }
}

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;
const latin = (s: string) => translit(s.toLowerCase()).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const group = (lang: string, noisy?: boolean) => (noisy ? "noisy" : lang === "hinglish-roman" ? "hinglish" : lang);

test("ASR gates: push-to-talk latency, memory and accuracy; hands-free turns and noise", { skip, timeout: 900_000 }, async () => {
  const corpus: { id: string; lang: string; text: string; wav: string; dur: number; noisy?: boolean }[] = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
  const rows: string[] = [];
  const gates: { gate: string; target: string; measured: string; pass: boolean }[] = [];
  const gate = (g: string, target: string, measured: string, pass: boolean) => gates.push({ gate: g, target, measured, pass });

  // ---- push-to-talk, real time ----
  const h = new Helper(["--wav", corpus.map((c) => join(HERE, c.wav)).join("|"), "--autostop"]);
  const t0 = performance.now();
  await h.wait((m) => m.type === "engine", 60_000);
  assert.equal(h.seen.find((m) => m.type === "engine")!.engine, "open", "the helper loaded Nemotron");
  const firstLoad = performance.now() - t0;
  const finals: number[] = [];
  const firsts: number[] = [];
  const err = new Map<string, { e: number; n: number }>();
  const cpu: number[] = [];
  let peakRss = 0;
  let footprint = 0;
  for (const [i, c] of corpus.entries()) {
    await new Promise((r) => setTimeout(r, 700)); // a quiet pre-roll, like a press before speaking
    h.send({ cmd: "config", langs: [HINT[c.lang] ?? "en"] });
    h.send({ cmd: "start", id: i + 1 });
    const sample = setInterval(() => ((peakRss = Math.max(peakRss, h.rssMB())), cpu.push(h.cpu())), 400);
    const stat = await h.wait((m) => m.type === "stat" && m.id === i + 1 && m.finalMs !== undefined);
    clearInterval(sample);
    const text = h.seen.find((m) => m.type === "final" && m.id === i + 1)?.text ?? "";
    finals.push(stat.finalMs);
    if (stat.firstPartialMs) firsts.push(stat.firstPartialMs); // from the press (the clip starts playing on start)
    footprint = Math.max(footprint, stat.mb);
    const g = err.get(group(c.lang, c.noisy)) ?? { e: 0, n: 0 };
    const ref = latin(c.text);
    err.set(group(c.lang, c.noisy), { e: g.e + lev(ref, latin(text)), n: g.n + ref.length });
  }
  h.quit();
  rows.push(`push-to-talk, ${corpus.length} clips: final after release p50 ${pct(finals, 0.5)} ms, p95 ${pct(finals, 0.95)} ms; first words p50 ${pct(firsts, 0.5)} ms after the press`);
  rows.push(`memory: footprint ${footprint} MB, peak RSS ${Math.round(peakRss)} MB; CPU while speaking p95 ${pct(cpu, 0.95)}%; first load ${Math.round(firstLoad)} ms`);
  rows.push(`CER % (script-agnostic): ${[...err].map(([k, v]) => `${k} ${((100 * v.e) / v.n).toFixed(0)}`).join(", ")}`);
  gate("Final transcript after release, p50", `${GATES.finalP50} ms or less`, `${pct(finals, 0.5)} ms`, pct(finals, 0.5) <= GATES.finalP50);
  gate("Final transcript after release, p95", `${GATES.finalP95} ms or less`, `${pct(finals, 0.95)} ms`, pct(finals, 0.95) <= GATES.finalP95);
  gate("ASR memory (phys footprint)", `${GATES.footprintMB} MB or less`, `${footprint} MB (RSS ${Math.round(peakRss)})`, footprint <= GATES.footprintMB);
  gate("CPU while speaking, p95", `${GATES.speakingCpu}% or less`, `${pct(cpu, 0.95)}%`, pct(cpu, 0.95) <= GATES.speakingCpu);

  // ---- warm load ----
  const w = new Helper(["--wav", "none"]);
  const w0 = performance.now();
  await w.wait((m) => m.type === "engine");
  const warm = Math.round(performance.now() - w0);
  w.quit();
  gate("Helper load with the models on disk", `under ${GATES.warmLoadMs} ms`, `${warm} ms`, warm < GATES.warmLoadMs);

  // ---- hands-free: pauses inside a sentence stay one turn ----
  const pauses = [
    { f: "pause-en1.wav", second: ["failing", "check"] }, // "open the … failing check"
    { f: "pause-en2.wav", second: ["admin", "workspace"] },
    { f: "pause-en3.wav", second: ["push", "them"] },
    { f: "pause-en5.wav", second: ["network", "requests"] },
  ];
  const hf = new Helper(["--wav", pauses.map((p) => join(HERE, "handsfree", p.f)).join("|")]);
  await hf.wait((m) => m.type === "engine");
  hf.send({ cmd: "config", langs: ["en"] });
  hf.send({ cmd: "hands", on: true });
  const turns: Msg[] = [];
  for (let i = 0; i < pauses.length; i++) turns.push(await hf.wait((m) => m.type === "stat" && m.id === 1_000_001 + i && m.pauseMs !== undefined, 30_000));
  const said = turns.map((t) => hf.seen.find((m) => m.type === "final" && m.id === t.id)?.text ?? "");
  hf.quit();
  // one turn per clip, carrying words from before the pause as well as the second half
  const whole = pauses.filter((p, i) => p.second.every((x) => said[i]!.toLowerCase().includes(x)) && said[i]!.split(/\s+/).length > p.second.length).length;
  const fast = turns.map((t) => t.pauseMs as number);
  rows.push(`hands-free: ${said.map((s) => `"${s}"`).join(", ")}; pause to final ${fast.join(", ")} ms`);
  gate("Mid-sentence pauses kept in one turn", `${pauses.length} of ${pauses.length}`, `${whole} of ${pauses.length}`, whole === pauses.length);
  gate("Finished command fires after the pause, p50", `${GATES.pauseP50} ms or less`, `${pct(fast, 0.5)} ms`, pct(fast, 0.5) <= GATES.pauseP50);

  // ---- hands-free: fan noise opens no turn, and idles on VAD alone ----
  const noise = noiseWav(120);
  const nz = new Helper(["--wav", noise]);
  await nz.wait((m) => m.type === "engine");
  nz.send({ cmd: "hands", on: true });
  const idle: number[] = [];
  for (let s = 0; s < 120; s += 2) (await new Promise((r) => setTimeout(r, 2000)), idle.push(nz.cpu()));
  const opened = nz.seen.filter((m) => m.type === "vad" && m.speech).length;
  const acted = nz.seen.filter((m) => m.type === "final" && m.text).length;
  nz.quit();
  rmSync(dirname(noise), { recursive: true, force: true });
  gate("Turns opened by 2 minutes of fan noise", "0", `${opened} (${acted} with words)`, acted === 0);
  gate("Idle hands-free CPU (VAD only), p50", `${GATES.idleCpu}% or less`, `${pct(idle, 0.5)}%`, pct(idle, 0.5) <= GATES.idleCpu);

  console.log(`\n${rows.join("\n")}\n\n${gates.map((g) => `${g.pass ? "PASS" : "MISS"}  ${g.gate}: ${g.measured} (target ${g.target})`).join("\n")}\n`);
  assert.deepEqual(gates.filter((g) => !g.pass).map((g) => `${g.gate}: ${g.measured}`), []);
});
