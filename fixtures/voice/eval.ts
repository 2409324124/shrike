// Voice understanding eval (docs/16 §3, docs/09). Scores full-plan accuracy (actions, order and slots) per language
// for the grammar alone and the grammar + planner cascade, on: the synthetic script, held-out paraphrases,
// real ASR transcripts from the benchmark, and your own recordings (fixtures/voice/recordings/*.wav).
//   node fixtures/voice/eval.ts              grammar only
//   node fixtures/voice/eval.ts --planner    plus the bundled planner (needs the model in userData/models)
//   node fixtures/voice/eval.ts --prompts    what to record, one line per file name
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BY_ID, type LiveContext } from "../../apps/desktop/src/renderer/src/actions/registry.ts";
import { checkPlan, understand, type PlanFn, type Step } from "../../apps/desktop/src/renderer/src/voice/understand/index.ts";
import { runPlan, type Bindings } from "../../apps/desktop/src/renderer/src/voice/understand/executor.ts";
import { PLANNER_MODEL } from "../../apps/desktop/src/main/voice-planner-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T>(f: string): T => JSON.parse(readFileSync(join(HERE, f), "utf8")) as T;

export interface Item {
  id: string;
  lang: string;
  text: string;
  plan: Step[];
  noisy?: boolean;
  wav?: string;
  dur?: number;
}
export const CONTEXT = read<LiveContext>("context.json");
export const CORPUS = read<Item[]>("corpus.json");
export const HELDOUT = read<Item[]>("heldout.json");
export const NEARMISS = read<Item[]>("nearmiss.json");
export const HALLUCINATIONS = read<{ text: string; planner: unknown; expect: Step[] }[]>("hallucinations.json");

export const GATES = {
  heldoutGrammar: 0.47, // phase 1
  heldoutCascade: 0.85, // phase 2
  plannerP95Ms: 1000, // phase 2, warm
  recordings: { en: 0.9, hinglish: 0.8, hi: 0.8, other: 0.75 } as Record<string, number>, // phase 3 on your voice
  wrongSafe: 0.05,
};

export const group = (lang: string, noisy?: boolean): string => (noisy ? "noisy" : lang.startsWith("hinglish") ? "hinglish" : lang === "en" || lang === "hi" ? lang : "other");
const RISKY = (a: string) => ["outward", "destructive"].includes(BY_ID.get(a)?.risk ?? "");

/** Right actions, right order, right slots; free text only has to be there. */
export function correct(pred: Step[] | null, gold: Step[]): boolean {
  if (!gold.length) return !pred?.length;
  if (!pred || pred.length !== gold.length) return false;
  return gold.every((g, i) => {
    const p = pred[i]!;
    if (p.action !== g.action) return false;
    return Object.entries(g.slots).every(([k, v]) => (k === "text" ? !!String(p.slots[k] ?? "").trim() : p.slots[k] === v));
  });
}

export interface Row {
  source: string;
  router: string;
  group: string;
  n: number;
  acc: number;
  abstain: number;
  wrong: number;
  wrongRisky: number;
  wrongSafe: number;
  p50: number;
  p95: number;
  planner: number; // how many went to the planner
}

const pct = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};

export interface Pred {
  item: Item;
  steps: Step[] | null;
  ms: number;
  source?: "grammar" | "planner";
}

export async function predict(items: Item[], plan?: PlanFn): Promise<Pred[]> {
  const out: Pred[] = [];
  for (const item of items) {
    const u = await understand(item.text, CONTEXT, plan);
    out.push({ item, steps: u.kind === "plan" ? u.steps : null, ms: u.ms, ...(u.kind === "plan" ? { source: u.source } : {}) });
  }
  return out;
}

export function score(source: string, router: string, preds: Pred[]): Row[] {
  const groups = new Map<string, Pred[]>();
  for (const p of preds) for (const g of [group(p.item.lang, p.item.noisy), "ALL"]) groups.set(g, [...(groups.get(g) ?? []), p]);
  return [...groups].map(([g, ps]) => {
    const ok = ps.filter((p) => correct(p.steps, p.item.plan)).length;
    const abst = ps.filter((p) => !p.steps).length;
    const wrongs = ps.filter((p) => p.steps && !correct(p.steps, p.item.plan));
    return {
      source, router, group: g, n: ps.length, acc: ok / ps.length, abstain: abst / ps.length, wrong: wrongs.length / ps.length,
      wrongRisky: wrongs.filter((p) => p.steps!.some((s) => RISKY(s.action))).length,
      wrongSafe: wrongs.filter((p) => p.steps!.every((s) => BY_ID.get(s.action)?.risk === "safe")).length / ps.length,
      p50: pct(ps.map((p) => p.ms), 0.5), p95: pct(ps.map((p) => p.ms), 0.95), planner: ps.filter((p) => p.source === "planner").length,
    };
  });
}

/** Every predicted plan through the real executor with recording bindings: outward or destructive steps that ran before a yes. */
export async function outwardWithoutCard(preds: Pred[]): Promise<number> {
  let ran = 0;
  for (const p of preds) {
    if (!p.steps?.length) continue;
    const done: string[] = [];
    const bindings: Bindings = { run: async (s) => (done.push(s.action), { echo: "ok" }), pre: (s) => s };
    await runPlan(p.steps, { heard: p.item.text, source: p.source ?? "grammar" }, bindings, () => {});
    ran += done.filter(RISKY).length;
  }
  return ran;
}

// ---------- your recordings ----------

const REC = join(HERE, "recordings");
const HELPER = process.env.SHRIKE_VOICE_BIN ?? join(HERE, "../../apps/desktop/native/voice/build/ShrikeVoice.app/Contents/MacOS/ShrikeVoice");
const LANG_HINT: Record<string, string> = { en: "en", hi: "hi", hinglish: "hi", "hinglish-roman": "en", es: "es", fr: "fr", de: "de", ja: "ja" };

function wavSeconds(path: string): number {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(28);
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "data") return size / rate;
    i += 8 + size + (size % 2);
  }
  return (b.length - 44) / rate;
}

/** Recordings named after a corpus or held-out id ("en07.wav", "hx02-fan.wav"), or with a <name>.json {lang, plan} beside them. */
export function recordings(): { items: Item[]; unknown: string[] } {
  if (!existsSync(REC)) return { items: [], unknown: [] };
  const byId = new Map([...CORPUS, ...HELDOUT].map((i) => [i.id, i]));
  const items: Item[] = [];
  const unknown: string[] = [];
  for (const f of readdirSync(REC).filter((x) => x.toLowerCase().endsWith(".wav")).sort()) {
    const stem = f.replace(/\.wav$/i, "");
    const side = join(REC, `${stem}.json`);
    const known = byId.get(stem.split(/[-_ ]/)[0]!);
    const meta = existsSync(side) ? (JSON.parse(readFileSync(side, "utf8")) as Partial<Item>) : known;
    if (!meta?.plan || !meta.lang) {
      unknown.push(f);
      continue;
    }
    items.push({ id: stem, lang: meta.lang, text: "", plan: meta.plan, wav: join(REC, f), noisy: /noisy|fan|music|tv/i.test(stem) || undefined, dur: wavSeconds(join(REC, f)) });
  }
  return { items, unknown };
}

/** A 16 kHz mono 16-bit WAV of brown (fan) and pink-ish noise. */
export function noiseWav(seconds: number): string {
  const n = 16_000 * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24); b.writeUInt32LE(32_000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = (brown + (Math.random() * 2 - 1) * 0.02) * 0.998;
    const v = brown * 3 + (Math.random() * 2 - 1) * 0.02 * (i < n / 2 ? 0.5 : 1);
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767 * 0.5))), 44 + i * 2);
  }
  const f = join(mkdtempSync(join(tmpdir(), "shrike-noise-")), "noise.wav");
  writeFileSync(f, b);
  return f;
}

/** Transcribes recordings through the real helper (--wav), cached by file and size; a <name>.txt beside a WAV wins. */
export async function transcribe(items: Item[]): Promise<{ items: Item[]; engine: string; finalMs: number[] }> {
  const cacheFile = join(REC, ".transcripts.json");
  const cache: Record<string, string> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const key = (i: Item) => `${basename(i.wav!)}:${statSync(i.wav!).size}`;
  for (const i of items) {
    const txt = i.wav!.replace(/\.wav$/i, ".txt");
    if (existsSync(txt)) cache[key(i)] = readFileSync(txt, "utf8").trim();
  }
  const todo = items.filter((i) => cache[key(i)] === undefined);
  const finalMs: number[] = [];
  if (todo.length && existsSync(HELPER)) {
    const p = spawn(HELPER, ["--wav", todo.map((i) => i.wav!).join("|")], { stdio: ["pipe", "pipe", "ignore"] });
    const waiters = new Map<number, (t: string) => void>();
    let ready: () => void = () => {};
    const isReady = new Promise<void>((r) => (ready = r));
    let buf = "";
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line) as { type: string; id?: number; text?: string };
          if (m.type === "ready") ready();
          if (m.type === "final" && m.id !== undefined) waiters.get(m.id)?.(m.text ?? "");
        } catch {}
      }
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    await Promise.race([isReady, new Promise((r) => setTimeout(r, 20_000))]);
    for (const [n, i] of todo.entries()) {
      const id = n + 1;
      send({ cmd: "config", langs: [LANG_HINT[i.lang] ?? "en"] });
      const text = new Promise<string>((r) => {
        waiters.set(id, r);
        setTimeout(() => r(""), (i.dur ?? 3) * 1000 + 4000);
      });
      send({ cmd: "start", id });
      await new Promise((r) => setTimeout(r, (i.dur ?? 3) * 1000 + 300));
      const t = performance.now();
      send({ cmd: "stop" });
      cache[key(i)] = (await text).trim();
      finalMs.push(performance.now() - t);
    }
    send({ cmd: "quit" });
    p.kill();
    writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  }
  return { items: items.filter((i) => cache[key(i)] !== undefined).map((i) => ({ ...i, text: cache[key(i)]! })), engine: existsSync(HELPER) ? basename(HELPER) : "none", finalMs };
}

// ---------- the planner ----------

export const plannerPath = (): string => join(process.env.SHRIKE_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models"), PLANNER_MODEL.file);

export async function loadPlanner(): Promise<{ plan: PlanFn; warmMs: number; loadMs: number; dispose: () => Promise<void> } | null> {
  if (!existsSync(plannerPath())) return null;
  const { createPlanner } = await import("../../apps/desktop/src/main/voice-planner-worker.ts");
  const { PLANNER_PREFIX } = await import("../../apps/desktop/src/renderer/src/voice/understand/plan.ts");
  const t = performance.now();
  const pl = await createPlanner(plannerPath());
  const loadMs = performance.now() - t;
  const warmMs = await pl.warm(PLANNER_PREFIX);
  const plan: PlanFn = async (ask) => {
    try {
      return { json: (await pl.plan(ask)).json };
    } catch (e) {
      return { error: (e as Error)?.name === "AbortError" ? "timeout" : "failed" };
    }
  };
  return { plan, warmMs, loadMs, dispose: () => pl.dispose() };
}

// ---------- the report ----------

const fmt = (r: Row | undefined) => (r ? `${Math.round(100 * r.acc)}`.padStart(4) : "   -");

export function table(rows: Row[]): string {
  const out: string[] = [];
  for (const src of [...new Set(rows.map((r) => r.source))]) {
    out.push(`\n== ${src}: full-plan accuracy %`);
    out.push(`${"router".padEnd(10)}   en hing   hi othr nois  ALL    n  abst wrong risky wsafe   p50ms   p95ms  planner`);
    for (const router of [...new Set(rows.filter((r) => r.source === src).map((r) => r.router))]) {
      const by = new Map(rows.filter((r) => r.source === src && r.router === router).map((r) => [r.group, r]));
      const a = by.get("ALL")!;
      out.push(`${router.padEnd(10)} ${["en", "hinglish", "hi", "other", "noisy", "ALL"].map((g) => fmt(by.get(g))).join(" ")} ${String(a.n).padStart(4)}  ${Math.round(100 * a.abstain).toString().padStart(4)}  ${Math.round(100 * a.wrong).toString().padStart(4)}  ${String(a.wrongRisky).padStart(4)}  ${Math.round(100 * a.wrongSafe).toString().padStart(4)} ${a.p50.toFixed(1).padStart(7)} ${a.p95.toFixed(1).padStart(7)}  ${String(a.planner).padStart(5)}`);
    }
  }
  return out.join("\n");
}

export interface Gate {
  gate: string;
  target: string;
  measured: string;
  pass: boolean | null; // null: can't run yet (no recordings, no model)
}

export async function runEval(o: { planner?: boolean } = {}): Promise<{ rows: Row[]; gates: Gate[]; text: string }> {
  const sources: [string, Item[]][] = [
    ["script", CORPUS.filter((i) => !i.noisy)],
    ["heldout", HELDOUT],
    ["near-miss", NEARMISS],
    ...(["nemotron35-160ms", "apple", "whisper-turbo-prompt"] as const).map((e): [string, Item[]] => {
      const tx = read<Record<string, { text: string }>>(`transcripts/${e}.json`);
      return [`asr:${e}`, CORPUS.filter((i) => tx[i.id]).map((i) => ({ ...i, text: tx[i.id]!.text }))];
    }),
  ];
  const rec = recordings();
  const tr = rec.items.length ? await transcribe(rec.items) : { items: [], engine: "none", finalMs: [] };
  if (tr.items.length) sources.push([`recordings:${tr.engine}`, tr.items]);
  const planner = o.planner ? await loadPlanner() : null;
  const rows: Row[] = [];
  const all: Pred[] = [];
  for (const [name, items] of sources) {
    const g = await predict(items);
    rows.push(...score(name, "grammar", g));
    all.push(...g);
    if (planner) {
      const c = await predict(items, planner.plan);
      rows.push(...score(name, "cascade", c));
      all.push(...c);
    }
  }
  const get = (src: string, router: string, grp = "ALL") => rows.find((r) => r.source === src && r.router === router && r.group === grp);
  const gates: Gate[] = [];
  const hg = get("heldout", "grammar")!;
  gates.push({ gate: "Phase 1: held-out text, grammar alone", target: `>= ${GATES.heldoutGrammar * 100}%`, measured: `${(hg.acc * 100).toFixed(0)}% (${hg.n})`, pass: hg.acc >= GATES.heldoutGrammar });
  const card = await outwardWithoutCard(all);
  gates.push({ gate: "Outward or destructive steps run without a card (every predicted plan)", target: "0", measured: String(card), pass: card === 0 });
  const halluc = HALLUCINATIONS.map((h) => ({ h, got: checkPlan(h.planner, h.text, CONTEXT).steps }));
  const kept = halluc.filter((x) => JSON.stringify(x.got) !== JSON.stringify(x.h.expect));
  gates.push({ gate: "Hallucinated-step fixtures all dropped", target: `${halluc.length}/${halluc.length}`, measured: `${halluc.length - kept.length}/${halluc.length}`, pass: !kept.length });
  const hc = get("heldout", "cascade");
  gates.push({ gate: "Phase 2: held-out text, grammar + planner", target: `>= ${GATES.heldoutCascade * 100}%`, measured: hc ? `${(hc.acc * 100).toFixed(0)}% (${hc.n})` : "planner not run", pass: hc ? hc.acc >= GATES.heldoutCascade : null });
  const plannerMs = all.filter((p) => p.source === "planner").map((p) => p.ms);
  gates.push({ gate: "Phase 2: planner p95, warm", target: `< ${GATES.plannerP95Ms} ms`, measured: plannerMs.length ? `${pct(plannerMs, 0.95).toFixed(0)} ms p95, ${pct(plannerMs, 0.5).toFixed(0)} ms p50 (${plannerMs.length} calls)` : "planner not run", pass: plannerMs.length ? pct(plannerMs, 0.95) < GATES.plannerP95Ms : null });
  const recSrc = tr.items.length ? `recordings:${tr.engine}` : "";
  for (const [g, target] of Object.entries(GATES.recordings)) {
    const r = recSrc ? (get(recSrc, "cascade", g) ?? get(recSrc, "grammar", g)) : undefined;
    gates.push({ gate: `Your recordings, ${g}`, target: `>= ${target * 100}%`, measured: r ? `${(r.acc * 100).toFixed(0)}% (${r.n}, ${r.router})` : "waiting for recordings", pass: r ? r.acc >= target : null });
  }
  const rs = recSrc ? (get(recSrc, "cascade") ?? get(recSrc, "grammar")) : undefined;
  gates.push({ gate: "Your recordings: wrong safe action", target: `<= ${GATES.wrongSafe * 100}%`, measured: rs ? `${(rs.wrongSafe * 100).toFixed(0)}%` : "waiting for recordings", pass: rs ? rs.wrongSafe <= GATES.wrongSafe : null });
  let text = table(rows);
  if (planner) text += `\n\nplanner: ${PLANNER_MODEL.name}, load ${planner.loadMs.toFixed(0)} ms, prefix warm-up ${planner.warmMs.toFixed(0)} ms`;
  if (rec.unknown.length) text += `\n\nrecordings without a plan (name them after a corpus id, or add <name>.json {lang, plan}): ${rec.unknown.join(", ")}`;
  if (tr.finalMs.length) text += `\nhelper final after stop: p50 ${pct(tr.finalMs, 0.5).toFixed(0)} ms, p95 ${pct(tr.finalMs, 0.95).toFixed(0)} ms`;
  if (kept.length) text += `\n\nhallucinations kept: ${kept.map((k) => `${k.h.text} -> ${JSON.stringify(k.got)}`).join("; ")}`;
  text += `\n\nGATES\n${gates.map((g) => `${g.pass === null ? "WAIT" : g.pass ? "PASS" : "FAIL"}  ${g.gate}: ${g.measured} (target ${g.target})`).join("\n")}`;
  await planner?.dispose();
  return { rows, gates, text };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--prompts")) {
    for (const i of [...CORPUS.filter((x) => !x.noisy), ...HELDOUT]) console.log(`${i.id}.wav  (${i.lang})  ${i.text}`);
    console.log("\nAdd -fan, -music or -noisy to a name for a noisy take (en07-fan.wav). Drop the files in fixtures/voice/recordings/.");
  } else {
    const r = await runEval({ planner: process.argv.includes("--planner") });
    console.log(r.text);
    if (process.argv.includes("--misses")) {
      // never the held-out set: it stays a measurement, not a tuning target
      const tx = read<Record<string, { text: string }>>("transcripts/nemotron35-160ms.json");
      const sets: [string, Item[]][] = [["script", CORPUS.filter((i) => !i.noisy)], ["nemotron", CORPUS.filter((i) => tx[i.id]).map((i) => ({ ...i, text: tx[i.id]!.text }))], ["near-miss", NEARMISS]];
      for (const [name, items] of sets) for (const p of await predict(items)) if (!correct(p.steps, p.item.plan)) console.log(`${name} ${p.item.id}: ${p.item.text} -> ${JSON.stringify(p.steps)}`);
    }
  }
}
