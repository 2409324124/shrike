import { getLlama, LlamaChatSession, QwenChatWrapper, type LlamaContextSequence, type LlamaJsonSchemaGrammar } from "node-llama-cpp";

// V9 planner, the utilityProcess side (docs/16 §2.4): a small local model that can only answer with a plan
// over the closed action list. The prompt prefix stays evaluated between turns; each turn's schema becomes a grammar.
// fixtures/voice/eval.ts imports createPlanner directly (plain Node, no Electron).

export interface PlanAsk {
  prefix: string;
  context: string;
  text: string;
  schema: Record<string, unknown>;
}

export interface Planner {
  plan(ask: PlanAsk, timeoutMs?: number): Promise<{ json: unknown; ms: number }>;
  warm(prefix: string): Promise<number>;
  dispose(): Promise<void>;
}

type Grammar = LlamaJsonSchemaGrammar<never, never>;

export async function createPlanner(modelPath: string): Promise<Planner> {
  const llama = await getLlama({ build: "never" });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 4096 });
  const seq: LlamaContextSequence = context.getSequence();
  let session: LlamaChatSession | null = null;
  let prefixNow = "";
  const grammars = new Map<string, Promise<Grammar>>();

  const sessionFor = (prefix: string): LlamaChatSession => {
    if (session && prefixNow === prefix) {
      session.resetChatHistory();
      return session;
    }
    session?.dispose({ disposeSequence: false });
    session = new LlamaChatSession({ contextSequence: seq, systemPrompt: prefix, chatWrapper: new QwenChatWrapper({ thoughts: "discourage" }) });
    prefixNow = prefix;
    return session;
  };

  const grammarFor = (schema: Record<string, unknown>): Promise<Grammar> => {
    const key = JSON.stringify(schema);
    let g = grammars.get(key);
    if (!g) {
      if (grammars.size > 8) grammars.delete(grammars.keys().next().value!);
      g = llama.createGrammarForJsonSchema(schema as never) as Promise<Grammar>;
      grammars.set(key, g);
    }
    return g;
  };

  let queue: Promise<unknown> = Promise.resolve(); // one sequence: turns and warm-ups take it in order
  const one = <T>(f: () => Promise<T>): Promise<T> => {
    const r = queue.then(f, f);
    queue = r.catch(() => {});
    return r;
  };

  return {
    plan: (ask, timeoutMs = 1500) => one(async () => {
      const t = performance.now();
      const grammar = await grammarFor(ask.schema);
      const s = sessionFor(ask.prefix);
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), timeoutMs);
      try {
        const out = await s.prompt(`${ask.context ? `App state:\n${ask.context}\n` : ""}Command: ${ask.text}`, { grammar, maxTokens: 96, temperature: 0, signal: stop.signal, budgets: { thoughtTokens: 0 } });
        return { json: grammar.parse(out), ms: performance.now() - t };
      } finally {
        clearTimeout(timer);
      }
    }),
    warm: (prefix) => one(async () => {
      const t = performance.now();
      await sessionFor(prefix).prompt("Command: ok", { maxTokens: 1, temperature: 0, budgets: { thoughtTokens: 0 } });
      return performance.now() - t;
    }),
    async dispose() {
      session?.dispose({ disposeSequence: false });
      await context.dispose();
      await model.dispose();
    },
  };
}

// ---------- as an Electron utilityProcess ----------

type In = { type: "load"; modelPath: string } | ({ type: "plan"; id: number; timeoutMs?: number } & PlanAsk) | { type: "warm"; id: number; prefix: string };
interface Port {
  on(ev: "message", cb: (e: { data: In }) => void): void;
  postMessage(m: unknown): void;
}

const port = (process as unknown as { parentPort?: Port }).parentPort;
if (port) {
  let planner: Promise<Planner> | null = null;
  port.on("message", ({ data }) => {
    if (data.type === "load") {
      const t = performance.now();
      planner = createPlanner(data.modelPath);
      planner.then(() => port.postMessage({ type: "ready", ms: performance.now() - t }), (e: unknown) => port.postMessage({ type: "error", message: String(e) }));
      return;
    }
    if (!planner) return port.postMessage({ type: "reply", id: data.id, ok: false, error: "not loaded" });
    const p = planner;
    void (async () => {
      try {
        const pl = await p;
        if (data.type === "warm") port.postMessage({ type: "reply", id: data.id, ok: true, ms: await pl.warm(data.prefix) });
        else port.postMessage({ type: "reply", id: data.id, ok: true, ...(await pl.plan(data, data.timeoutMs)) });
      } catch (e) {
        port.postMessage({ type: "reply", id: data.id, ok: false, error: (e as Error)?.name === "AbortError" ? "timeout" : String(e) });
      }
    })();
  });
}
