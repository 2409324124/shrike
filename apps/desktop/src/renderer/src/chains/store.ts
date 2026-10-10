import { useEffect } from "react";
import { create } from "zustand";
import type { ChainDef, ChainEvent, ChainsState, UpNextItem, UpNextWhen } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { mainHead, useAgent } from "../stores/agent.ts";
import { useProject } from "../stores/project.ts";
import { toast } from "../stores/ui.ts";
import { blankChain, enqueueToast, pickChain } from "./logic.ts";

// P: up next, schedules and chains in the renderer. main/chains.ts runs them; this mirrors its state and holds the editor's draft.

interface ChainsUi extends ChainsState {
  defs: ChainDef[]; // P4: built-in and saved chains
  editing: ChainDef | null; // P3: the editor's draft
  open: boolean; // the chain panel
  mode: "edit" | "run"; // the editor, or the chain going now (or the last one)
  askWhen: UpNextWhen; // the Ask pill's "when" chip
  toast: ChainEvent | null; // P5: the one on screen
  toasts: ChainEvent[];
  apply(s: ChainsState | undefined): void;
  load(): Promise<void>;
  queue(prompt: string, when?: UpNextWhen, target?: UpNextItem["target"]): Promise<boolean>;
  edit(id: string, patch: { prompt?: string; when?: UpNextWhen; target?: UpNextItem["target"] } | null): Promise<void>;
  move(id: string, index: number): Promise<void>;
  pause(p: boolean): Promise<void>;
  answerMissed(id: string, run: boolean): Promise<void>;
  openEditor(def?: ChainDef): void;
  close(): void;
  start(def: ChainDef): Promise<boolean>;
  stop(): Promise<void>;
  save(def: ChainDef, scope: "project" | "personal"): Promise<ChainDef | undefined>;
  push(e: ChainEvent): void;
  next(): void;
}

const STALE_MS = 10_000;

export const useChains = create<ChainsUi>((set, get) => ({
  items: [],
  paused: false,
  chain: null,
  defs: [],
  editing: null,
  open: false,
  mode: "edit",
  askWhen: { on: "finished" },
  toast: null,
  toasts: [],
  apply(s) {
    if (s && Array.isArray(s.items)) set({ items: s.items, paused: !!s.paused, chain: s.chain ?? null });
  },
  async load() {
    const [st, defs] = await Promise.all([api().getChains().catch(() => undefined), api().listChains().catch(() => undefined)]);
    get().apply(st);
    if (Array.isArray(defs)) set({ defs });
  },
  async queue(prompt, when = get().askWhen, target = "main") {
    if (!prompt.trim()) return false;
    const st = await call((a) => a.queuePrompt(prompt.trim().slice(0, 4000), when, target), "Couldn't add it to up next");
    get().apply(st);
    if (st && when.on === "time") set({ askWhen: { on: "finished" } }); // a time is used once
    return !!st;
  },
  async edit(id, patch) {
    get().apply(await call((a) => a.editUpNext(id, patch), patch ? "Couldn't change it" : "Couldn't remove it"));
  },
  async move(id, index) {
    get().apply(await call((a) => a.moveUpNext(id, index), "Couldn't move it"));
  },
  async pause(p) {
    get().apply(await call((a) => a.pauseUpNext(p), p ? "Couldn't pause up next" : "Couldn't resume up next"));
  },
  async answerMissed(id, run) {
    get().apply(await call((a) => a.answerMissed(id, run), "Couldn't answer"));
  },
  openEditor(def) {
    const goal = useAgent.getState().goal.trim();
    set({ open: true, mode: "edit", editing: def ? { ...def } : (get().editing ?? blankChain(goal)) });
  },
  close: () => set({ open: false }),
  async start(def) {
    const st = await call((a) => a.startChain(def), "Couldn't start the chain");
    get().apply(st);
    if (st) set({ open: true, mode: "run", editing: def });
    return !!st;
  },
  async stop() {
    get().apply(await call((a) => a.stopChain(), "Couldn't stop the chain"));
  },
  async save(def, scope) {
    const saved = await call((a) => a.saveChain(def, scope), "Couldn't save the chain");
    if (!saved) return undefined;
    set((s) => ({ editing: saved, defs: [...s.defs.filter((d) => d.id !== saved.id), saved] }));
    get().push({ kind: "saved", text: `Run it any time with /chain ${saved.id.replace(/^chain-/, "")}.`, at: Date.now() }); // P5: through the one toast queue, so it never sits on another window
    return saved;
  },
  push(e) {
    set((s) => ({ toasts: enqueueToast(s.toasts, e) }));
    if (!get().toast) get().next();
  },
  next: () =>
    set((s) => {
      const fresh = s.toasts.filter((e) => Date.now() - e.at < STALE_MS); // ponytail: news that waited this long behind other windows is old news
      return { toast: fresh[0] ?? null, toasts: fresh.slice(1) };
    }),
}));

/** /chain name, a chain skill from the shelf or voice: start it, or open it in the editor when it needs a prompt. */
export async function runChain(text: string): Promise<void> {
  const st = useChains.getState();
  if (!st.defs.length) await st.load();
  const hit = pickChain(useChains.getState().defs, text);
  if (!hit) {
    if (text.trim()) toast(`There's no chain called ${text.trim().split(/\s+/)[0]}. Here's a new one.`, "info");
    return useChains.getState().openEditor();
  }
  const def = { ...hit.def, prompt: hit.prompt || hit.def.prompt };
  const ag = useAgent.getState();
  if (!def.prompt.trim() && !mainHead(ag)) return useChains.getState().openEditor({ ...def, prompt: ag.goal.trim() });
  await useChains.getState().start(def);
}

export const isValidEvent = (e: unknown): e is ChainEvent => !!e && typeof e === "object" && typeof (e as ChainEvent).kind === "string" && typeof (e as ChainEvent).text === "string";

/** Mount once (ChainsLayer). */
export function useChainsBridge(): void {
  useEffect(() => {
    const a = api();
    const offs = [
      a.on("chains:update", (s) => useChains.getState().apply(s)),
      a.on("chains:event", (e) => isValidEvent(e) && useChains.getState().push(e)),
      a.on("skills:update", () => void a.listChains().then((defs) => Array.isArray(defs) && useChains.setState({ defs }), () => {})),
      useProject.subscribe((st, prev) => void (st.project?.root !== prev.project?.root && useChains.getState().load())),
    ];
    void useChains.getState().load();
    return () => offs.forEach((off) => off());
  }, []);
}
