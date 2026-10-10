import { useEffect } from "react";
import { create } from "zustand";
import type { ScmFile, ScmState, ScmTarget } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";

// SC: the Changes dock's state. Main pushes "scm:update" (it watches the repo); every action returns fresh state too.

export type ScmBusy = null | "load" | "stage" | "unstage" | "discard" | "commit" | "undo" | "write" | "sync";

interface ScmStore {
  state: ScmState | null;
  busy: ScmBusy;
  note: { text: string; tone: "info" | "error" | "ok" } | null;
  message: string; // the commit box draft
  written: boolean; // the draft came from Write it for me
  committed: string | null; // the full message of the commit just made, offered back on Undo
  diff: ScmTarget | null; // the open diff view
  load(): Promise<void>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  discard(paths: string[]): Promise<void>;
  commit(): Promise<void>;
  undo(): Promise<void>;
  write(): Promise<void>;
  sync(): Promise<void>;
  openDiff(f: Pick<ScmFile, "path" | "area"> | ScmTarget): void;
}

const GENTLE = /^(Not thrown away|Not sent)\b/;

export const useScm = create<ScmStore>((set, get) => {
  const run = async (busy: ScmBusy, fn: () => Promise<ScmState>, ok?: (s: ScmState) => string | null): Promise<ScmState | undefined> => {
    if (get().busy && get().busy !== "load") return undefined;
    set({ busy, note: null });
    try {
      const s = await fn();
      const text = ok?.(s);
      set({ state: s, ...(text ? { note: { text, tone: "ok" } } : {}) });
      return s;
    } catch (e) {
      const text = errorMessage(e);
      set({ note: { text, tone: GENTLE.test(text) ? "info" : "error" } });
      return undefined;
    } finally {
      set({ busy: null });
    }
  };
  return {
    state: null,
    busy: null,
    note: null,
    message: "",
    written: false,
    committed: null,
    diff: null,
    async load() {
      if (!get().state) set({ busy: "load" });
      const s = await api().scmState().catch((e: unknown) => (set({ note: { text: errorMessage(e), tone: "error" } }), null));
      set((st) => ({ state: s ?? st.state, busy: st.busy === "load" ? null : st.busy }));
    },
    async stage(p) {
      await run("stage", () => api().scmStage(p));
    },
    async unstage(p) {
      await run("unstage", () => api().scmUnstage(p));
    },
    async discard(p) {
      await run("discard", () => api().scmDiscard(p), () => "Thrown away.");
    },
    async commit() {
      const msg = get().message;
      const s = await run("commit", () => api().scmCommit(msg), (st) => `Committed "${msg.split("\n")[0]}". It's saved on this computer${st.remote ? ", not on GitHub yet" : ""}.`);
      if (s) set({ message: "", written: false, committed: msg });
    },
    async undo() {
      const { committed, state } = get();
      const back = committed && committed.split("\n")[0]!.trim() === state?.undo ? committed : (state?.undo ?? "");
      const s = await run("undo", () => api().scmUndoCommit(), () => "Undone. Your changes are staged again, with the message back in the box.");
      if (s && !get().message.trim()) set({ message: back, committed: null });
    },
    async write() {
      if (get().busy) return;
      set({ busy: "write", note: null });
      try {
        const text = await api().scmWriteMessage();
        set({ message: text, written: true });
      } catch (e) {
        set({ note: { text: errorMessage(e), tone: "error" } });
      } finally {
        set({ busy: null });
      }
    },
    async sync() {
      await run("sync", () => api().scmSync(), (s) => (s.ahead || s.behind ? null : "In step with GitHub."));
    },
    openDiff: (f) => set({ diff: { path: f.path, area: f.area, ...("sha" in f && f.sha ? { sha: f.sha } : {}) } }),
  };
});

/** Keeps the store in step with main while the dock is mounted. */
export function useScmBridge(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    void useScm.getState().load();
    const off = api().on("scm:update", (s) => s && typeof s.isRepo === "boolean" && useScm.setState({ state: s }));
    const focus = () => void useScm.getState().load(); // commits made in a terminal
    window.addEventListener("focus", focus);
    return () => {
      off();
      window.removeEventListener("focus", focus);
    };
  }, [active]);
}
