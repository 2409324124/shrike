import { useEffect, useRef } from "react";
import type { ActionView } from "@shrike/schema";
import { useActions } from "../stores/actions.ts";
import { useAgent } from "../stores/agent.ts";
import { firstFailure, tripFor, tripOrder, useThread } from "../stores/thread.ts";
import { lastStation } from "../lib/thread-layout.ts";
import { useUi } from "../stores/ui.ts";
import { isBackgroundAction } from "../lib/format.ts";
import { isTyping } from "./commands.ts";
import { chosenFinding, matchStation, probeCap, sentence, sharpen } from "./logic.ts";

// Drives the Thread from the outside: new trips (M1-M4), the agent's probe (M7) and the re-knit (M8).

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let rerun: { at: number; label: string } | null = null; // after Apply: the verifying re-run is the next click with the broken trip's label
let captionTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string | null, holdMs = 0): void {
  clearTimeout(captionTimer);
  useUi.setState({ agentCaption: text });
  if (text && holdMs) captionTimer = setTimeout(() => useUi.setState({ agentCaption: null }), holdMs);
}

/** Take focus at once (pending: title and BEFORE shot), play the drop once the trip completes, then land on its failure or end. */
function play(id: string, knit = false): void {
  const th = useThread.getState();
  useUi.getState().setNewTrip(null);
  th.setFocus(id, 0);
  th.arrive(id); // before markKnit, so the Thread plays one arrival with the knit, not two plays
  if (knit) th.markKnit(id);
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    off();
    offActions();
    clearTimeout(t);
    const s = useThread.getState();
    if (s.arriving === id) s.arrive(null);
    if (s.focus.actionId !== id || s.focus.station !== 0 || s.dived) return; // the user moved on
    const trip = tripFor(id);
    if (!trip) return;
    if (trip.status === "error") {
      s.setFocus(id, firstFailure(trip));
      if (s.autoDive) useThread.getState().dive();
    } else s.setFocus(id, lastStation(trip));
  };
  // Thread clears `arriving` when M1-M3 finish; the timer, armed once the trip is complete, covers a Thread that doesn't.
  let t: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!t && !done && useActions.getState().byId[id]?.complete) t = setTimeout(settle, reduced() ? 0 : knit ? 2400 : 1900);
  };
  const off = useThread.subscribe((s) => s.arriving !== id && settle());
  const offActions = useActions.subscribe(arm);
  arm();
}

export function useTrips(): void {
  const order = useActions((s) => s.order);
  const byId = useActions((s) => s.byId);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const first = !seen.current;
    seen.current ??= new Set();
    const fresh: string[] = [];
    for (const id of order) {
      const a = byId[id];
      if (!a || isBackgroundAction(a) || seen.current.has(id)) continue;
      seen.current.add(id); // incomplete trips too: focus moves at the click, the drop waits for completion (Thread `pending`)
      fresh.push(id);
    }
    const newest = fresh[0];
    if (!newest) return;
    const th = useThread.getState();
    if (first) {
      const t = tripFor(newest);
      return th.setFocus(newest, t?.status === "error" ? firstFailure(t) : 0);
    }
    const verify = rerun && fresh.find((id) => isRerun(byId[id]!));
    if (verify) {
      rerun = null;
      say(null); // "Running it again to check…" is answered by the re-run itself
      return play(verify, true);
    }
    if (th.probe || useAgent.getState().run?.status === "running") return; // the agent's own clicks: it narrates them
    const busy = th.dived || useAgent.getState().open || isTyping(document.activeElement) || !!useUi.getState().sheet;
    if (busy) useUi.getState().setNewTrip(newest);
    else play(newest);
  }, [order, byId]);
}

const isRerun = (a: ActionView): boolean => !!rerun && a.trigger !== "navigation" && a.label === rerun.label && a.startMs >= rerun.at;

/** The most recent trip that broke. */
const lastFailing = (): string | undefined => tripOrder().reverse().find((id) => tripFor(id)?.status === "error");

function startProbe(actionId: string): void {
  const th = useThread.getState();
  th.setProbe({ actionId, station: 0, ticks: [] });
  th.setFocus(actionId, 0);
  say("Your agent is retracing your click…");
}

export function useAgentWalk(): void {
  const run = useAgent((s) => s.run);
  const steps = useAgent((s) => s.steps);
  const patches = useAgent((s) => s.patches);
  const handled = useRef(0);
  const runId = useRef<string | null>(null);
  const walked = useRef(false); // one walk per run; after Apply the probe is gone on purpose

  // A new run: walk the latest failing trip (or the first one the agent produces).
  useEffect(() => {
    if (!run) return;
    if (run.status === "running" && runId.current !== run.id) {
      runId.current = run.id;
      const own = useAgent.getState().steps.findIndex((x) => x.runId === run.id);
      handled.current = own >= 0 ? own : useAgent.getState().steps.length; // a continued conversation keeps its old steps: don't replay them
      const id = lastFailing();
      walked.current = !!id;
      if (id) startProbe(id);
      else say("Your agent is looking…");
    }
    if (run.status === "stopped" || run.status === "failed") {
      const th = useThread.getState();
      if (th.probe && th.probe.found == null) th.setProbe(null);
      say(run.status === "failed" ? "Your agent stopped with a problem." : null, 6000);
    }
  }, [run?.id, run?.status]);

  // Fresh failing trip while no probe yet: walk that one.
  const order = useActions((s) => s.order);
  useEffect(() => {
    if (walked.current || useAgent.getState().run?.status !== "running" || useThread.getState().probe) return;
    const id = lastFailing();
    if (id && useActions.getState().byId[id]?.complete) {
      walked.current = true;
      startProbe(id);
    }
  }, [order]);

  useEffect(() => {
    const fresh = steps.slice(handled.current);
    handled.current = steps.length;
    for (const s of fresh) {
      const th = useThread.getState();
      const p = th.probe;
      const trip = p ? tripFor(p.actionId) : undefined;
      if (s.kind === "tool_call" && p && trip && p.found == null) {
        const next = Math.min(p.station + 1, probeCap(trip));
        if (next === p.station) continue;
        th.setProbe({ ...p, station: next, ticks: [...p.ticks, p.station] });
        if (!th.dived) th.setFocus(p.actionId, next);
        say(`Checking ${trip.stations[next]?.label ?? "the next step"}…`);
      } else if (s.kind === "findings" && s.findings?.length) {
        const id = p?.actionId ?? lastFailing();
        const t = id ? tripFor(id) : undefined;
        const view = id ? useActions.getState().byId[id] : undefined;
        if (!id || !t || !view) continue;
        const best = chosenFinding(s, useAgent.getState().picked, t, view)!;
        useAgent.setState((a) => ({ picked: { ...a.picked, [s.id]: best } }));
        const hit = matchStation(t, view, best);
        const found = hit >= 0 ? sharpen(t, view, hit, best) : firstFailure(t);
        const ticks = (p?.actionId === id ? p.ticks : []).filter((i) => i < found);
        th.setProbe({ actionId: id, station: found, ticks, found });
        th.setFocus(id, found); // no dive: the Found it card is the one focal point
        say("Found it.");
      } else if (s.kind === "done") {
        say(sentence(s.summary ?? s.text, 140, true), 9000);
      } else if (s.kind === "error") {
        say(sentence(s.text), 6000);
      }
    }
  }, [steps]);

  // Applied: drop the probe and wait for the verifying re-run (useTrips knits it).
  const applied = Object.values(patches).some((x) => x.status === "applied");
  useEffect(() => {
    if (!applied) return;
    const th = useThread.getState();
    const broken = th.probe?.actionId ?? lastFailing();
    const label = broken ? useActions.getState().byId[broken]?.label : undefined;
    rerun = label ? { at: Date.now() - 1500, label } : null; // slack: the patch status can reach us just after the re-run started
    th.setProbe(null);
    say("Applied. Running it again to check…", 12000); // the done step or the re-run takes over; never left behind
  }, [applied]);
}
