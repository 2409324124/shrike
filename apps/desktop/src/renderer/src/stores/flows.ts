import { create } from "zustand";
import type { Flow, FlowStep } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { viewTrip } from "../hud/commands.ts";
import { useActions } from "./actions.ts";
import { useAgent } from "./agent.ts";
import { useProject } from "./project.ts";
import { toast, useUi } from "./ui.ts";

// B1-B3 in the renderer. The flow list itself lives in useUi.flows (kept fresh by the sdlc bridge's flows:update).

interface FlowsState {
  recording: FlowStep[] | null; // live steps while recording
  naming: boolean; // Stop was pressed: asking for a name
  running: Record<string, boolean>;
  start(): Promise<void>;
  stop(name: string): Promise<void>;
  run(f: Flow): Promise<void>;
  remove(id: string): Promise<void>;
  watch(id: string, w: Flow["watch"] | null): Promise<void>;
}

export const useFlows = create<FlowsState>((set, get) => ({
  recording: null,
  naming: false,
  running: {},
  async start() {
    if (await call((a) => a.startFlowRecording().then(() => true), "Couldn't start recording")) {
      set({ recording: [], naming: false });
      useUi.setState({ panel: null, appVisible: true });
    }
  },
  async stop(name) {
    const saved = await call((a) => a.stopFlowRecording(name), "Couldn't save the flow");
    set({ recording: null, naming: false });
    if (saved) toast(`Saved "${saved.name}". Press W to run it.`, "ok");
    else if (name.trim()) toast("Nothing was recorded, so there's nothing to save.");
  },
  async run(f) {
    if (get().running[f.id]) return;
    set((s) => ({ running: { ...s.running, [f.id]: true } }));
    if (f.steps.some((s) => s.type !== "request")) useUi.setState({ appVisible: true }); // the ghost cursor shows in the app
    await call((a) => a.runFlow(f.id), `Couldn't run "${f.name}"`);
    set((s) => ({ running: { ...s.running, [f.id]: false } }));
  },
  async remove(id) {
    await call((a) => a.deleteFlow(id), "Couldn't delete the flow");
  },
  async watch(id, w) {
    await call((a) => a.setFlowWatch(id, w), "Couldn't change Keep watching");
  },
}));

/** One step in plain words. */
export function stepText(s: FlowStep): string {
  if (s.type === "click") return `Click "${s.name ?? "?"}"`;
  if (s.type === "type") return s.secret ? `Type a password in "${s.name}"${s.submit ? ", then Enter" : ""}` : `Type "${s.text ?? ""}" in "${s.name}"${s.submit ? ", then Enter" : ""}`;
  if (s.type === "navigate") return `Open ${s.url ?? "/"}`;
  if (s.type === "wait") return `Wait ${((s.ms ?? 500) / 1000).toFixed(1)}s`;
  return `${s.request?.method ?? "GET"} ${s.request?.url ?? ""}`;
}

export const watchWords = (w: Flow["watch"]): string => (!w ? "Off" : w.mode === "save" ? "On every save" : `Every ${w.minutes ?? 5} min`);

let connected = false;

/** Main's flow, B5 and session pushes. Idempotent; the shelf, the recording bar and the welcome card all call it. */
export function connectFlows(): void {
  if (connected || !window.shrike) return;
  connected = true;
  const a = api();
  a.on("flow:recording", (r) => useFlows.setState(r && Array.isArray(r.steps) ? { recording: r.steps } : { recording: null, naming: false }));
  a.on("flow:result", (r) => {
    if (!r || typeof r.flowId !== "string") return;
    const name = useUi.getState().flows.find((f) => f.id === r.flowId)?.name ?? r.flowId;
    if (r.ok) return void (!r.watched && toast(`"${name}" worked.`, "ok"));
    // B3: a red flow raises the unread dot on the trip that broke (O9).
    const broke = r.actionIds.find((id) => useActions.getState().byId[id]?.status === "error") ?? r.actionIds.at(-1);
    if (broke) useAgent.setState((s) => ({ unread: { ...s.unread, [broke]: "trip" } }));
    toast(`"${name}" broke.${broke ? " Its trip is marked." : ""}`, "error");
  });
  a.on("trip:focus", (p) => p && typeof p.actionId === "string" && viewTrip(p.actionId));
  a.on("file:open", (p) => p && typeof p.path === "string" && useUi.getState().openFile({ path: p.path, line: p.line || 1 }));
  a.on("project:opened", (p) => p && typeof p.root === "string" && useProject.getState().setProject(p));
}
