import { api, call } from "../lib/api.ts";
import { useActions } from "./actions.ts";
import { useAgent } from "./agent.ts";
import { useProject } from "./project.ts";
import { useRun } from "./run.ts";
import { useThread } from "./thread.ts";
import { useUi } from "./ui.ts";

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** Wires main-process push channels into the stores. Returns an unsubscribe. */
export function connectBridge(): () => void {
  const a = api();
  const offs = [
    a.on("run:status", (s) => useRun.getState().setStatus(s)),
    a.on("run:output", (chunk) => typeof chunk === "string" && useRun.getState().append(chunk)),
    a.on("actions:update", (list) => Array.isArray(list) && useActions.getState().upsert(list)),
    a.on("actions:cleared", () => {
      useActions.getState().clear();
      useThread.setState({ focus: { actionId: null, station: 0 }, dived: false, arriving: null, probe: null });
      useUi.getState().setNewTrip(null);
    }),
    a.on("agent:status", (info) => useAgent.getState().onStatus(info)),
    a.on("agent:step", (step) => useAgent.getState().onStep(step)),
    a.on("approval:request", (req) => useAgent.getState().onApproval(req)),
    a.on("approval:resolved", ({ id, approved }) => useAgent.getState().onResolved(id, approved)),
    a.on("patch:update", (p) => useAgent.getState().onPatch(p)),
    a.on("file:changed", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void useProject.getState().refreshFiles(), 250);
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Pulls current state from main (after a reload of the renderer, main still has it). */
export async function hydrate(): Promise<void> {
  const [project, status, actions] = await Promise.all([
    call((a) => a.getProject(), "Couldn't load the project"),
    call((a) => a.getRunStatus(), "Couldn't read the run status"),
    call((a) => a.getActions(), "Couldn't load recordings"),
  ]);
  if (status) useRun.getState().setStatus(status);
  if (actions) useActions.getState().replaceAll(actions);
  if (project) useProject.getState().setProject(project);
}
