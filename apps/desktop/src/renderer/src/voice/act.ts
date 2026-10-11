import type { VoiceChip } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { sentence } from "../hud/logic.ts";
import { useAgent } from "../stores/agent.ts";
import { useThread } from "../stores/thread.ts";
import { BINDINGS, liveContext } from "../actions/run.ts";
import { Executor, type ExecState } from "./understand/executor.ts";
import { PLANNER_PREFIX, type PlanFn, type Step } from "./understand/index.ts";
import type { Echo, RouterDeps } from "./router.ts";
import { useVoiceStore } from "./store.ts";

// The plan executor wired to the real actions (docs/16 §2.6). The card (V8, store.ts) gets every change through onPlan;
// its buttons and the spoken answers call controls.

export { refreshFiles } from "../actions/run.ts";

let sink: (s: ExecState) => void = () => {};
export const executor = new Executor(BINDINGS, (s) => sink(s));

/** Where plan changes go: useVoice passes store.ts fromExecutor. */
export function onPlan(fn: (s: ExecState) => void): void {
  sink = fn;
}

/** A chip picked by tap or by voice: its plan through the same gates. */
export const runChip = (c: VoiceChip): Promise<ExecState> | null =>
  c.plan?.length ? executor.start(c.plan as Step[], { heard: c.label, source: "grammar" }) : c.action ? executor.start([{ action: c.action, slots: {} }], { heard: c.label, source: "grammar" }) : null;

/** The card's buttons and the spoken yes / no / stop / undo. */
export const controls = {
  yes: (how: "voice" | "click", words?: string): void => void executor.confirm(how, words),
  no: (): void => executor.cancel(),
  stop: (): void => executor.stop(),
  pick: (c: VoiceChip): void => void runChip(c),
  undo: (): Promise<string | null> => executor.undo(),
};

let toldBroken = false;

/** The bundled planner through main; "missing" until its model is downloaded (asked each turn, so a download mid-session counts). */
const plan: PlanFn = async (ask) => {
  const r = await api().voicePlan(ask).catch(() => ({ ok: false as const, error: "failed" as const }));
  if (r.ok) return { json: r.json };
  if (r.error !== "broken") return { error: r.error };
  if (!toldBroken) useVoiceStore.setState({ problem: { text: "Voice couldn't load its command model, so only set phrases work. Delete it in Voice settings and download it again." } });
  toldBroken = true;
  return { error: "failed" };
};

/** Voice turned on (or the app opened with voice on): load the planner and its fixed prompt in the background. */
export function warmPlanner(): void {
  void api().voicePlanWarm(PLANNER_PREFIX).catch(() => {});
}

/** Answers the agent's own approval card, the same as clicking it. */
function approve(yes: boolean): string | null {
  const ag = useAgent.getState();
  const req = ag.approvals[0];
  if (!req) return null;
  if (!yes && req.patch) useThread.getState().setProbe(null);
  void ag.answer(req.id, yes);
  return yes ? `Approved: ${sentence(req.title, 60)}` : "Rejected";
}

/** Everything a Turn needs. show is the caption (useVoice); help and voiceOff are the shell's. */
export function voiceDeps(o: { show(e: Echo): void; help(): void; voiceOff(): void }): RouterDeps {
  return {
    context: liveContext,
    plan,
    exec: executor,
    approve,
    agentBusy: () => useAgent.getState().run?.status === "running",
    stopAgent: () => void useAgent.getState().stop(),
    help: o.help,
    voiceOff: o.voiceOff,
    show: o.show,
  };
}
