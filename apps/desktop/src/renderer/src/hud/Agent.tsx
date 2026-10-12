import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GitBranch, MessageSquarePlus, RotateCcw, Send, Square, Undo2, X } from "lucide-react";
import type { AgentStep, AgentUsage, ApprovalRequest, Checkpoint, Patch, ShrikeEvents } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";
import { api } from "../lib/api.ts";
import { branchLines, mainHead, planRoute, shownUsage, useAgent, useAgentBridge, usePlan } from "../stores/agent.ts";
import { useActions } from "../stores/actions.ts";
import { tripFor, tripOrder, useThread } from "../stores/thread.ts";
import { lineDiff } from "../lib/hud.ts";
import { cx, IconButton, Spinner } from "../components/ui.tsx";
import { Elapsed } from "../components/Activity.tsx";
import { useUi } from "../stores/ui.ts";
import { useWorktrees } from "../stores/worktrees.ts";
import { chosenFinding, sentence, stationLoc } from "./logic.ts";
import { ReviewFixButton } from "./Sdlc.tsx";
import { SandboxButton } from "./Worktrees.tsx";
import { AsideBubble, AsideInput, BranchActions, BranchMap, BranchProbes, branchTone, Compare, ForkInput } from "./Branches.tsx";
import { UpNextStack } from "../chains/UpNext.tsx"; // chains: P1
import { ApprovedMockup } from "../options/OptionsLayer.tsx"; // options: M4
import { recede } from "../thread/DiveCard.tsx";
import { useChains } from "../chains/store.ts";
import { isOpenItem } from "../chains/logic.ts";
import { ActivityLine, ContextMapPanel, FileChips, McpMark, SkillChip, ThinkingStrip, toggleContextMap, TokensBadge, ToolsUsed, useContextMapUi } from "./Xray.tsx"; // X (xray), MCP6

const LIVE_KINDS = new Set<AgentStep["kind"]>(["message", "tool_call", "error", "done"]);
import { keys } from "../lib/platform.ts";

/**
 * The agent as one small pill top right (prototype: "Bad value playbook • • •"): the lit playbook and three plan dots.
 * Hover or focus opens the playbooks, the plan and the latest steps. It fades a few seconds after the last step.
 */
export function AgentStream() {
  const live = useAgent((s) => !!s.run);
  const viewing = useAgent((s) => s.viewing); // C2: a branch on show
  const run = useAgent((s) => (s.viewing ? s.runs[s.viewing] : mainHead(s))); // after a relaunch, main is the newest run on record
  const steps = useAgent((s) => (!run ? NO_STEPS : run.id === s.run?.id ? s.steps : (s.runSteps[run.id] ?? NO_STEPS)));
  useEffect(() => void (run && useAgent.getState().loadSteps(run.id)), [run?.id]);
  const skills = useAgent((s) => s.skills);
  const asking = useAgent((s) => s.approvals.length > 0) && !viewing;
  const hasBranches = useAgent((s) => branchLines(s).branches.length > 0 || !!s.forking);
  const aside = useAgent((s) => !!s.aside);
  const queued = useChains((s) => s.items.some(isOpenItem)); // P1: up next keeps the pill on show
  const waiting = asking || run?.status !== "running"; // a card or the caption has it now
  const dived = useThread((s) => s.dived);
  const [awake, setAwake] = useState(false);
  const [hover, setHover] = useState(false);
  const [forkAt, setForkAt] = useState<string | null>(null); // C1: the step whose "Ask differently…" is open
  const [side, setSide] = useState(false); // C3: the aside field is open
  const open = hover || !!forkAt || side;
  const plan = usePlan();
  const shown = useMemo(
    () => steps.filter((s, i, all) => LIVE_KINDS.has(s.kind) && !(plan?.plan?.length && /^my plan\b/i.test(s.text)) && s.text !== all.slice(0, i).findLast((p) => LIVE_KINDS.has(p.kind))?.text).slice(-4),
    [steps, plan],
  ); // the plan is drawn, not repeated as prose; a step said twice in a row shows once
  const last = steps[steps.length - 1]?.id;
  const loaded = useMemo(() => steps.findLast((x) => x.skill)?.skill, [steps]);

  useEffect(() => {
    if (!last) return;
    setAwake(!waiting); // a card or the caption has it now: the pill stays off the Thread
    if (open || waiting) return;
    const t = setTimeout(() => setAwake(false), 6000);
    return () => clearTimeout(t);
  }, [last, open, waiting]);

  if (!run || (((shown.length === 0 && !hasBranches && !aside) || (!live && !hasBranches)) && !queued)) return null;
  const busy = run.status === "running";
  const failed = run.status === "failed" && !viewing ? steps.findLast((s) => s.kind === "error") : undefined; // the reason and Try again stay on show
  const skill = skills.find((k) => k.id === loaded);
  const state = asking ? "Agent waiting for you" : busy ? "Agent working" : run.status === "done" ? "Agent done" : run.status === "failed" ? "Agent failed" : "Agent stopped";
  const tone = viewing ? branchTone(run) : color.violet;

  return (
    <aside
      aria-label="Agent"
      tabIndex={0}
      className={cx(
        "glass solid absolute top-14 right-4 flex max-w-[300px] flex-col gap-2 rounded-[var(--r-card)] px-2.5 py-1.5 transition-opacity duration-700 outline-none",
        (awake && !dived) || open || aside || queued || failed ? "opacity-100" : "opacity-0 hover:opacity-100",
        (hasBranches || queued) && "w-[300px]",
        open ? "z-30" : "z-10", // open, it sits over the FOUND IT card
      )}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHover(false)}
    >
      <BranchMap />
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ color: tone }} aria-hidden>
          ✦
        </span>
        <span data-skill={skill?.id} className={cx("lbl truncate text-[9.5px]", skill && "skill-chip on", asking ? "text-slow" : busy ? "text-violet" : run.status === "failed" ? "text-fail" : "text-dim")} style={viewing ? { color: tone } : undefined}>
          {viewing ? `${run.name ?? "Branch"} · ${state.replace(/^Agent /, "")}` : skill ? `${skill.name} playbook` : state}
        </span>
        {!viewing && <PlanDots />}
        {skill && !viewing && <span className={cx("lbl text-[9px] whitespace-nowrap text-faint", !open && "sr-only")}>{state}</span>}
        <span className="flex-1" />
        {open && !side && (
          <button type="button" className="hud-btn h-5 px-1.5 text-[9.5px]" title="Ask a side question that main won't see" onClick={() => setSide(true)}>
            Aside
          </button>
        )}
        {busy && (
          <button type="button" className="hud-btn h-5 px-1.5 text-[9.5px]" aria-label={viewing ? "Stop this branch" : "Stop the agent"} onClick={() => void (viewing ? api().stopAgent(run.id) : useAgent.getState().stop())}>
            <Square size={7} className="fill-current" />
          </button>
        )}
      </div>
      <AsideBubble />
      {failed && (
        <div data-id="A19" className="flex items-start gap-2">
          <p role="alert" className="flex-1 text-[12px] leading-snug text-fail">
            {sentence(failed.text)}
          </p>
          <button type="button" className="hud-btn h-5 shrink-0 px-1.5 text-[9.5px]" onClick={() => void useAgent.getState().retry()}>
            Try again
          </button>
        </div>
      )}
      {busy && <ActivityLine steps={steps} running={steps.at(-1)?.kind !== "done"} quiet={open} />}
      {!viewing && <UpNextStack />}
      {open && (
        <>
          <ThinkingStrip steps={steps} />
          <div className="flex flex-wrap items-center gap-1.5">
            <SkillChip steps={steps} />
            <FileChips steps={steps} max={4} />
            <ToolsUsed steps={steps} />
          </div>
          {!viewing && !loaded && <Skills loaded={loaded} />}
          {!viewing && <PlanList />}
          <ol aria-live="polite" className="flex flex-col gap-1.5 border-l pl-2.5" style={{ borderColor: `color-mix(in srgb, ${tone} 40%, transparent)` }}>
            {shown.filter((s) => s.id !== failed?.id).map((s, i, all) => (
              <li key={s.id} className={cx("group fade-in relative pr-5 text-[12px] leading-snug", s.kind === "error" ? "text-fail" : s.kind === "done" ? "text-ok" : i === all.length - 1 ? "text-ink" : "text-dim")}>
                <McpMark steps={steps} step={s} />
                {s.kind === "done" ? sentence(s.summary ?? s.text) : sentence(s.text)}
                <TokensBadge steps={steps} stepId={s.id} className="ml-1.5" />
                <button
                  type="button"
                  aria-label="Branch from here"
                  title="Branch from here: ask differently"
                  className={cx("absolute top-0 right-0 grid size-4 place-items-center text-dim transition-opacity hover:text-ink", forkAt === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
                  onClick={() => setForkAt(forkAt === s.id ? null : s.id)}
                >
                  <GitBranch size={10} />
                </button>
                {forkAt === s.id && <ForkInput runId={run.id} stepId={s.id} onDone={() => setForkAt(null)} />}
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2">
            <TokensBadge steps={steps} className="min-w-0 flex-1" />
            <button type="button" className="hud-btn h-5 px-1.5 text-[9.5px]" title="What fills your agent's context" onClick={() => toggleContextMap()}>
              Context
            </button>
          </div>
          {side && <AsideInput onDone={() => setSide(false)} />}
          {viewing && <BranchActions id={viewing} />}
        </>
      )}
    </aside>
  );
}

const NO_STEPS: AgentStep[] = [];

const CARD_W = 420;

/** Station node in the Thread (TripView: .th-trip > .th-st[data-i]); cards only anchor on the focused trip. */
function stationEl(actionId: string, i: number): Element | null {
  if (useThread.getState().focus.actionId !== actionId) return null;
  return document.querySelector(`.th-trip.focus .th-st[data-i="${i}"]`);
}

/** Floating layers that keep their spot: the agent pill, the conversation, System windows, an open sheet. The cards go round them. */
const LAYERS = 'aside[aria-label="Agent"], section[aria-label="Conversation"], .sys:not(.sys-leave), section.sheet-in';
const layers = () =>
  [...document.querySelectorAll(LAYERS)]
    .filter((e) => parseFloat(getComputedStyle(e).opacity) > 0.5)
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .sort((a, b) => a.top - b.top);

/** Keeps the cards next to the station (and beside the dive card when it is open) as the feed scrolls. */
function useAnchor(stage: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, on: boolean, actionId: string | undefined, station: number | undefined) {
  const [pos, setPos] = useState<{ left: number; top: number; off: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!on) return setPos(null); // no trip to sit beside (e.g. a patch with the app stopped): the stage's bottom-right corner
    let raf = 0;
    let seen = "";
    let n = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = stage.current?.getBoundingClientRect();
      const el = actionId && station != null ? stationEl(actionId, station)?.getBoundingClientRect() : undefined;
      if (!s) return;
      const h = box.current?.offsetHeight ?? 200;
      const room = { right: s.right - 14, bottom: s.bottom - 72 };
      const dive = document.querySelector(".th-dive")?.getBoundingClientRect();
      const live = document.querySelector(".th-dive .th-ln.live")?.getBoundingClientRect();
      let left: number;
      let top: number;
      if (dive && room.right - dive.right >= CARD_W + 12) [left, top] = [dive.right + 12, dive.top];
      else if (dive && dive.left - s.left >= CARD_W + 26) [left, top] = [dive.left - CARD_W - 12, dive.top];
      else if (dive && live) {
        // No room beside the code: sit under the live line (or above it), never on it.
        left = dive.right - CARD_W - 16;
        top = live.bottom + h + 10 <= room.bottom ? live.bottom + 10 : live.top - h - 10;
      } else if (el) [left, top] = [el.left + el.width / 2 - 180, el.bottom + 30];
      else [left, top] = [room.right - CARD_W, room.bottom - h];
      left = Math.max(s.left + 14, Math.min(left, room.right - CARD_W));
      top = Math.max(s.top + 52, Math.min(top, room.bottom - h));
      const w = box.current?.offsetWidth ?? CARD_W;
      let off = false; // no room clear of them: wait out of sight until they go
      const over = layers();
      for (const o of over) {
        if (left >= o.right || left + w <= o.left || top >= o.bottom || top + h <= o.top) continue;
        if (o.bottom + 12 + h <= room.bottom) top = o.bottom + 12;
        else if (o.top - 12 - h >= s.top + 52) top = o.top - 12 - h;
        else off = true;
      }
      const feed = document.querySelector(".th-feed");
      const key = `${left},${top},${w},${h},${off},${feed?.scrollTop},${feed?.clientWidth},${feed?.scrollHeight}`; // a relayout moves the labels too
      if (key !== seen || ++n % 10 === 0) recede(feed, off ? over : [...over, { left, top, right: left + w, bottom: top + h }], "under-card"); // also re-checks after a re-render resets a label's class
      seen = key;
      const next = { left: Math.round(left - s.left), top: Math.round(top - s.top), off };
      setPos((p) => (p && p.left === next.left && p.top === next.top && p.off === off ? p : next));
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      recede(document.querySelector(".th-feed"), [], "under-card");
    };
  }, [on, actionId, station]);
  return pos;
}

/** A4: every playbook as a chip, dim; the one the agent loaded is lit. */
function Skills({ loaded }: { loaded?: string }) {
  const all = useAgent((s) => s.skills);
  const skills = all.filter((k) => k.id === loaded || (k.source !== "claude" && k.kind !== "git")); // imported and git skills only when loaded
  if (!skills.length) return null;
  return (
    <ul aria-label="Playbooks" className="flex flex-wrap gap-1">
      {skills.map((k) => {
        const on = k.id === loaded;
        return (
          <li
            key={k.id}
            title={k.when}
            data-skill={k.id}
            aria-current={on || undefined}
            className={cx("skill-chip rounded-[5px] border px-1.5 py-px font-mono text-[9px] tracking-[0.08em] uppercase transition-colors duration-500", on ? "on text-ink" : "border-hair text-faint")}
            style={on ? { borderColor: color.violet, background: `color-mix(in srgb, ${color.violet} 28%, transparent)`, boxShadow: `0 0 12px color-mix(in srgb, ${color.violet} 55%, transparent)` } : undefined}
          >
            {k.name}
          </li>
        );
      })}
    </ul>
  );
}

const DOTS = 3; // A2: a three-dot progress, whatever the plan's length

/** How far the probe has walked the planned route: checks done of the plan, and the same as 0..3 dots. */
function usePlanDone(): { checks: string[]; done: number; dots: number } {
  const plan = usePlan();
  const probe = useThread((s) => s.probe);
  const checks = plan?.plan ?? [];
  const trip = probe ? tripFor(probe.actionId) : undefined;
  const route = trip && plan ? planRoute(trip.stations, plan) : [];
  const walked = probe ? route.filter((i) => probe.ticks.includes(i) || i < probe.station || (probe.found != null && i <= probe.found)).length : 0;
  const frac = route.length ? walked / route.length : 0;
  return { checks, done: Math.round(frac * checks.length), dots: Math.round(frac * DOTS) };
}

/** A1/A2: three dots, filled as the probe walks the planned route. */
function PlanDots() {
  const { checks, done, dots } = usePlanDone();
  if (!checks.length) return null;
  return (
    <span className="plan flex items-center gap-1" aria-label={`${done} of ${checks.length} checks done`}>
      {Array.from({ length: DOTS }, (_, i) => (
        <span key={i} className="size-[6px] rounded-full border" style={{ borderColor: color.violet, background: i < dots ? color.violet : "transparent", boxShadow: i < dots ? `0 0 6px ${color.violet}` : undefined }} />
      ))}
    </span>
  );
}

/** The planned checks, crossed off as they are done (shown when the pill opens). */
function PlanList() {
  const { checks, done } = usePlanDone();
  if (!checks.length) return null;
  return (
    <ol aria-label="Plan" className="flex flex-col gap-0.5 text-[11px] leading-snug">
      {checks.slice(0, 5).map((c, i) => (
        <li key={i} className={i < done ? "text-dim line-through decoration-[color-mix(in_srgb,var(--violet)_60%,transparent)]" : i === done ? "text-ink" : "text-faint"}>
          {sentence(c)}
        </li>
      ))}
    </ol>
  );
}

/** The agent's cards; also subscribes the agent's extra channels (Shell mounts CheckpointRail and AgentCursor itself). */
export function AgentCards({ stage }: { stage: RefObject<HTMLElement | null> }) {
  useAgentBridge();
  return (
    <>
      <Cards stage={stage} />
      <BranchProbes stage={stage} />
      <Compare />
    </>
  );
}

/** FOUND IT and the proposed fix, as one violet card beside the station (M7, then Apply leads to M8). */
function Cards({ stage }: { stage: RefObject<HTMLElement | null> }) {
  const steps = useAgent((s) => s.steps);
  const approvals = useAgent((s) => s.approvals);
  const inline = useAgent((s) => s.inline);
  const patches = useAgent((s) => s.patches);
  const probe = useThread((s) => s.probe);
  const focus = useThread((s) => s.focus);
  const latest = useMemo(() => [...steps].reverse().find((s) => s.kind === "findings" && s.findings?.length), [steps]);
  const patchId = useMemo(() => [...steps].reverse().find((s) => s.kind === "patch" && s.patchId)?.patchId, [steps]);
  const pending = approvals.find((a) => !inline.includes(a.id));
  const patch = pending?.patch ?? (patchId ? patches[patchId] : undefined);
  // A Found it outlives its run: a later run keeps it up until Hide, a newer Found it, or a fix of its own.
  const [kept, setKept] = useState<AgentStep>();
  useEffect(() => void (latest && setKept(latest)), [latest]);
  const findingStep = latest ?? (patch || pending ? undefined : kept);
  const doneStep = patch?.status === "applied" ? steps.find((x) => x.kind === "done" && x.patchId === patch.id) : undefined;
  const verified = doneStep?.summary === "Fixed and verified"; // the agent's own verdict: a done step alone isn't a passing re-run
  const [hidden, setHidden] = useState<string | null>(null);
  const revising = useAgent((s) => s.revising);
  const [forking, setForking] = useState(false); // C1: "Ask differently…" from the finding
  const box = useRef<HTMLDivElement>(null);

  const picked = useAgent((s) => s.picked);
  const finding = useMemo(() => {
    if (!findingStep) return undefined;
    const id = probe?.actionId;
    return chosenFinding(findingStep, picked, id ? tripFor(id) : undefined, id ? useActions.getState().byId[id] : undefined);
  }, [findingStep, probe?.actionId, picked]);

  // The line FOUND IT sits on (sharpened to the call that got the bad value), else the line the agent cited.
  const where = useMemo(() => {
    const v = probe?.found != null ? useActions.getState().byId[probe.actionId] : undefined;
    const st = v && probe?.found != null ? tripFor(probe.actionId)?.stations[probe.found] : undefined;
    const loc = v && st ? stationLoc(v, st) : undefined;
    return loc ?? (finding?.file && finding.line ? { file: finding.file, line: finding.line } : undefined);
  }, [probe, finding]);

  const key = findingStep?.id ?? patch?.id ?? pending?.id ?? null;
  const afterFix = patch && (patch.status === "applied" || patch.status === "reverted");
  useEffect(() => void (afterFix && setKept(undefined)), [afterFix]);
  const showFinding = !!finding && !afterFix;
  const showPatch = !!patch && patch.status !== "rejected";
  const waitingRevision = !!revising && !pending;
  const checkpointOpen = useUi((s) => !!s.checkpoint);
  const raceOpen = useWorktrees((s) => !!s.open);
  const covered = checkpointOpen || raceOpen; // the checkpoint or race card is the focal point
  const show = (waitingRevision || showFinding || showPatch || (pending && !pending.patch)) && hidden !== key && (!covered || !!pending); // one card at a time; a question still shows
  const anchorId = probe?.found != null ? probe.actionId : afterFix ? (focus.actionId ?? undefined) : (probe?.actionId ?? focus.actionId ?? undefined);
  const anchorAt = probe?.found != null ? probe.found : focus.station;
  const pos = useAnchor(stage, box, !!show, show ? anchorId : undefined, show ? anchorAt : undefined);

  if (!show) return null;
  return (
    <div
      ref={box}
      className={`absolute ${pending ? "z-[35]" : "z-20"} flex flex-col gap-2.5`} // a question stays above the agent aside
      style={{ width: `min(${CARD_W}px, calc(100% - 80px))`, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos && !pos.off ? "visible" : "hidden" }}
    >
      {pending && !pending.patch ? (
        <RequestCard req={pending} />
      ) : waitingRevision ? (
        <section aria-label="Revising" className="agentcard">
          <div className="flex items-center gap-2">
            <span className="text-violet">✦</span>
            <b className="font-semibold">Comments sent</b>
            <Elapsed />
          </div>
          <p className="m-0 mt-1.5 text-[13.5px] leading-snug text-ink">Your agent is revising the fix.</p>
        </section>
      ) : (
        <section aria-label={showFinding ? "Found it" : "Fix"} className={cx("agentcard", verified && "ok")}>
          <div className="mb-1.5 flex items-center gap-2">
            {verified ? <span className="text-ok">✓</span> : <span className="text-violet">✦</span>}
            <b className="font-semibold whitespace-nowrap">{verified ? "Fixed and verified" : patch?.status === "applied" ? "Applied" : patch?.status === "reverted" ? "Undone" : showFinding ? "Found it" : "Proposed fix"}</b>
            {showFinding && (
              <span className="text-[12px] text-dim">{finding.confidence}</span>
            )}
            {!showFinding && pending?.patch && pending.from && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-dim">From {pending.from}</span>}
            {patch?.status === "applied" && !doneStep && <Elapsed />}
            <span className="flex-1" />
            {showFinding && where ? (
              <button type="button" className="min-w-0 truncate font-mono text-[11.5px] text-dim hover:text-ink" onClick={() => useUi.getState().openFile({ path: where.file, line: where.line, error: true })} title="Open the file here">
                {where.file.split("/").pop()}:{where.line}
              </button>
            ) : (
              patch && <span className="min-w-0 truncate font-mono text-[11.5px] text-dim">{patch.files[0]?.path.split("/").pop()}</span>
            )}
            {showFinding && findingStep && (
              <IconButton label="Branch from here" title="Branch from here: ask differently" className="size-5" onClick={() => setForking(!forking)}>
                <GitBranch size={11} />
              </IconButton>
            )}
            <IconButton label="Hide" className="size-5" onClick={() => setHidden(key)}>
              <X size={12} />
            </IconButton>
          </div>
          <p className="m-0 mb-2.5 text-[13.5px] leading-snug text-ink last:mb-0">
            {afterFix ? (verified ? "Ran it again and it works now." : doneStep ? (/still shows a problem/.test(doneStep.summary ?? "") ? "Ran it again and it still shows a problem." : "Applied. It wasn't run again to check yet.") : patch.status === "reverted" ? "Your file is back the way it was." : "Running it again to check…") : showFinding ? finding.claim : patch?.rationale}
          </p>
          {forking && showFinding && findingStep && (
            <div className="mb-2.5">
              <ForkInput runId={findingStep.runId} stepId={findingStep.id} onDone={() => setForking(false)} />
            </div>
          )}
          {showPatch && <ApprovedMockup />}
          {showPatch && patch.status === "proposed" && <Diff patch={patch} />}
          {pending?.patch ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn go" autoFocus onClick={() => void useAgent.getState().answer(pending.id, true)}>
                Apply fix {keys("⌘↵")}
              </button>
              <ReviewFixButton patchId={pending.patch.id} />
              <SandboxButton patchId={pending.patch.id} actionId={probe?.actionId ?? focus.actionId ?? undefined} />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void useAgent.getState().answer(pending.id, false);
                  useThread.getState().setProbe(null);
                }}
              >
                Not now
              </button>
            </div>
          ) : patch?.status === "applied" ? (
            <button type="button" className="btn" onClick={() => void useAgent.getState().revert(patch.id)}>
              <Undo2 size={11} />
              Undo
            </button>
          ) : null}
        </section>
      )}
    </div>
  );
}

/** The changed part of a replaced line: same start and end as its old line are left plain. */
function changed(text: string, other: string | undefined): [string, string, string] {
  if (other === undefined) return [text, "", ""];
  let a = 0;
  while (a < text.length && a < other.length && text[a] === other[a]) a++;
  let b = 0;
  while (b < text.length - a && b < other.length - a && text[text.length - 1 - b] === other[other.length - 1 - b]) b++;
  return [text.slice(0, a), text.slice(a, text.length - b), text.slice(text.length - b)];
}

/** Diff rows, wrapped (never scrolled sideways), with the -/+ marker in a fixed gutter and the changed words lit. */
function DiffRows({ lines, max, row }: { lines: ReturnType<typeof lineDiff>; max: number; row?: (i: number, el: ReactNode) => ReactNode }) {
  const indent = Math.min(...lines.map((l) => (l.text.trim() ? l.text.length - l.text.trimStart().length : Infinity)));
  const cut = Number.isFinite(indent) ? indent : 0;
  const dels = lines.filter((l) => l.kind === "del");
  const adds = lines.filter((l) => l.kind === "add");
  return (
    <>
      {lines.slice(0, max).map((l, i) => {
        const text = l.text.slice(cut);
        const pair = l.kind === "del" ? adds[dels.indexOf(l)]?.text.slice(cut) : l.kind === "add" ? dels[adds.indexOf(l)]?.text.slice(cut) : undefined;
        const [pre, mid, post] = l.kind === "ctx" ? [text, "", ""] : changed(text, pair);
        const el = (
          <>
            <span className="m" aria-hidden>
              {l.kind === "del" ? "-" : l.kind === "add" ? "+" : " "}
            </span>
            {pre}
            {mid && <mark>{mid}</mark>}
            {post}
          </>
        );
        return row ? row(i, el) : <div key={i} className={l.kind === "del" ? "d" : l.kind === "add" ? "a" : "c"}>{el}</div>;
      })}
    </>
  );
}

function Diff({ patch }: { patch: Patch }) {
  const f = patch.files[0];
  const lines = useMemo(() => (f ? lineDiff(f.before, f.after, 0) : []), [f]);
  const [notes, setNotes] = useState<Record<number, string>>({}); // A13: diff row -> comment
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const sent = useAgent((s) => s.sentNotes);
  if (!f) return null;
  const save = (i: number) => {
    const t = draft.trim();
    setNotes((n) => {
      const { [i]: _, ...rest } = n;
      return t ? { ...rest, [i]: t } : rest;
    });
    setEditing(null);
    setDraft("");
  };
  const comments = Object.entries(notes).map(([i, text]) => ({ file: f.path, line: lines[Number(i)]?.line ?? 1, text }));
  return (
    <>
      {sent.length > 0 && (
        <ul aria-label="Your comments" className="m-0 mb-2 flex list-none flex-col gap-1 p-0">
          {sent.map((n, i) => (
            <li key={i} className="diff-sent rounded-md px-2 py-1 text-[12px] text-ink">
              <b className="font-semibold text-violet">You:</b> {n.text} <span className="lbl text-[9px]">line {n.line}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="diff selectable mb-2.5">
        <DiffRows
          lines={lines}
          max={10}
          row={(i, el) => {
            const l = lines[i]!;
            return (
              <div key={i} className="contents">
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Comment on line ${l.line}`}
                  title="Click to comment on this line"
                  className={cx(l.kind === "del" ? "d" : l.kind === "add" ? "a" : "c", "group relative cursor-text")}
                  style={notes[i] ? { boxShadow: `inset 2px 0 0 ${color.violet}` } : undefined}
                  onClick={() => (setEditing(i), setDraft(notes[i] ?? ""))}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setEditing(i), setDraft(notes[i] ?? ""))}
                >
                  {el}
                  <MessageSquarePlus size={11} className="absolute top-1 right-1.5 text-violet opacity-0 group-hover:opacity-80" aria-hidden />
                </div>
                {editing === i ? (
                  <div className="diff-note">
                    <input
                      autoFocus
                      aria-label={`Your comment on line ${l.line}`}
                      className="field w-full rounded-md border border-[color-mix(in_srgb,var(--violet)_50%,transparent)] bg-abyss px-2 py-1 font-sans text-[12px] text-ink"
                      placeholder="What should change here? Enter to save"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") save(i);
                        else if (e.key === "Escape") (setEditing(null), setDraft(""));
                      }}
                      onBlur={() => save(i)}
                    />
                  </div>
                ) : notes[i] ? (
                  <div className="diff-note diff-sent font-sans text-[12px] text-ink">{notes[i]}</div>
                ) : null}
              </div>
            );
          }}
        />
      </div>
      {comments.length > 0 && (
        <div className="mb-2.5 flex items-center gap-2">
          <span className="lbl flex-1">
            {comments.length} comment{comments.length === 1 ? "" : "s"}
          </span>
          <button type="button" className="btn" style={{ borderColor: color.violet }} onClick={() => void useAgent.getState().reviseFix(patch.id, comments).then((ok) => ok && setNotes({}))}>
            <Send size={10} />
            Send to agent
          </button>
        </div>
      )}
    </>
  );
}

function RequestCard({ req }: { req: ApprovalRequest }) {
  return (
    <section aria-label="Agent request" className="agentcard">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-violet">✦</span>
        <b className="font-semibold">Allow this?</b>
      </div>
      <p className="m-0 text-[13.5px] text-ink">{req.title}</p>
      {req.request && (
        <p className="mt-1 font-mono text-[11.5px] text-dim">
          {req.request.method} {req.request.url}
        </p>
      )}
      <p className="mt-1 mb-2.5 text-[12.5px] text-dim">{req.reason}</p>
      <div className="flex gap-2">
        <button type="button" className="btn go" onClick={() => void useAgent.getState().answer(req.id, true)}>
          Allow {keys("⌘↵")}
        </button>
        <button type="button" className="btn" onClick={() => void useAgent.getState().answer(req.id, false)}>
          Not now
        </button>
      </div>
    </section>
  );
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A7: how much of the agent's context window is used, as a ring around ✦ (wrap the ASK button's ✦ with it). Cost on hover. */
export function AskFuelRing({ children, size = 20 }: { children?: ReactNode; size?: number }) {
  const usage = useAgent(shownUsage);
  const busy = useAgent((s) => (s.viewing ? s.runs[s.viewing] : s.run)?.status === "running");
  const frac = usage?.contextLimit && usage.contextTokens ? Math.min(1, usage.contextTokens / usage.contextLimit) : 0;
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const tone = frac > 0.85 ? color.fail : frac > 0.6 ? color.slow : color.violet;
  const ring = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ring}
      className="fuel-ring relative inline-grid place-items-center"
      style={{ width: size, height: size }}
      title={usage ? `${usageText(usage)} · Click the ring to see what fills it` : usageText(usage)}
      data-fuel={frac.toFixed(4)}
      onClick={(e) => usage && (e.stopPropagation(), e.preventDefault(), toggleContextMap())} // X5: the ring opens the context map; the rest of the button asks
    >
      <ContextPopover anchor={ring} />
      <svg width={size} height={size} className="pointer-events-none absolute inset-0 -rotate-90" aria-hidden>
        {usage && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hair)" strokeWidth="1.5" />}
        {usage && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(frac * c, 1.5)} ${c}`}
            style={{ transition: "stroke-dasharray .6s var(--ease-out)", filter: busy ? `drop-shadow(0 0 3px ${tone})` : undefined }}
          />
        )}
      </svg>
      {children}
    </span>
  );
}

/** X5: the shown run's context map, under the ring; a portal so it isn't inside the Ask button (clicks stop here). */
function ContextPopover({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const open = useContextMapUi((s) => s.open);
  const run = useAgent((s) => (s.viewing ? s.runs[s.viewing] : mainHead(s)));
  const steps = useAgent((s) => (!run ? NO_STEPS : run.id === s.run?.id ? s.steps : (s.runSteps[run.id] ?? NO_STEPS)));
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const r = open ? anchor.current?.getBoundingClientRect() : undefined;
    setAt(r ? { top: r.bottom + 10, right: Math.max(16, window.innerWidth - r.right - 40) } : null);
  }, [open, anchor]);
  if (!open || !at) return null;
  return createPortal(
    <div className="fixed z-40 w-[min(360px,calc(100vw-32px))]" style={at} onClick={(e) => e.stopPropagation()}>
      <ContextMapPanel runId={run?.id} steps={steps} />
    </div>,
    document.body,
  );
}

function usageText(u: AgentUsage | null): string {
  if (!u) return keys("Ask your agent (⌘K)");
  const parts = [`${fmtTokens(u.contextTokens ?? 0)}${u.contextLimit ? ` of ${fmtTokens(u.contextLimit)}` : ""} tokens in use`, `${fmtTokens(u.inputTokens)} in · ${fmtTokens(u.outputTokens)} out this run`];
  if (u.costUsd != null) parts.push(`$${u.costUsd.toFixed(u.costUsd < 1 ? 3 : 2)}`);
  if (u.rateLimitResetsAt) parts.push(`plan limit resets ${new Date(u.rateLimitResetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  return `${keys("Ask your agent (⌘K)")} · ${parts.join(" · ")}`;
}

/** The trip a fix belongs to: the first trip after it was applied (its re-run), else the newest. */
function tripOfCheckpoint(cp: Checkpoint): string | undefined {
  const ids = tripOrder();
  const byId = useActions.getState().byId;
  return ids.find((id) => (byId[id]?.startMs ?? 0) >= cp.createdAt - 1500) ?? ids[ids.length - 1];
}

/** A6: a 7px diamond on the bottom-right corner of the re-run trip's minimap glyph, one per applied fix. Click for the diff and Rewind. */
export function CheckpointRail() {
  const list = useAgent((s) => s.checkpoints);
  const patches = useAgent((s) => s.patches);
  const open = useUi((s) => s.checkpoint);
  const setOpen = (id: string | null) => useUi.setState({ checkpoint: id });
  const [busy, setBusy] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const [at, setAt] = useState<Record<string, { x: number; y: number }>>({});

  // Follow the minimap glyphs as the minimap scrolls or trips arrive.
  useLayoutEffect(() => {
    if (!list.length) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const base = nav.current?.offsetParent?.getBoundingClientRect();
      if (!base) return;
      const next: Record<string, { x: number; y: number }> = {};
      const stack = new Map<string, number>();
      for (const c of list) {
        const id = tripOfCheckpoint(c);
        const r = id ? document.querySelector(`.th-mini button[data-trip="${CSS.escape(id)}"]`)?.getBoundingClientRect() : undefined;
        if (!r || !id) continue;
        const k = stack.get(id) ?? 0; // two fixes on one trip sit side by side
        stack.set(id, k + 1);
        next[c.id] = { x: Math.round(r.right - base.left - 4 - k * 9), y: Math.round(r.bottom - base.top - 4) };
      }
      setAt((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [list]);

  useEffect(() => () => useUi.setState({ checkpoint: null }), []);
  if (!list.length) return null;
  const cp = list.find((c) => c.id === open);
  const pos = cp ? at[cp.id] : undefined;
  return (
    <nav ref={nav} aria-label="Checkpoints" className="checkpoint-rail pointer-events-none absolute inset-0 z-30">
      {list.map((c, i) => {
        const p = at[c.id];
        return (
          <button
            key={c.id}
            type="button"
            data-current={c.current}
            aria-label={`Checkpoint ${i + 1}: ${c.label}${c.current ? "" : " (rewound)"}`}
            aria-expanded={open === c.id}
            title={c.label}
            onClick={() => setOpen(open === c.id ? null : c.id)}
            className="pointer-events-auto absolute grid size-3.5 -translate-x-1/2 -translate-y-1/2 place-items-center"
            style={{ left: p?.x ?? 0, top: p?.y ?? 0, visibility: p ? "visible" : "hidden" }}
          >
            <span
              className="block size-[7px] rotate-45 rounded-[1px] border transition-all duration-300"
              style={{ borderColor: color.violet, background: c.current ? color.violet : color.abyss, boxShadow: c.current ? `0 0 8px ${color.violet}` : undefined }}
            />
          </button>
        );
      })}
      {cp && (
        <CheckpointCard
          cp={cp}
          patch={patches[cp.patchId]}
          busy={busy}
          top={pos?.y ?? 80}
          close={() => setOpen(null)}
          run={async () => {
            setBusy(true);
            await useAgent.getState().rewind(cp.id);
            setBusy(false);
          }}
        />
      )}
    </nav>
  );
}

function CheckpointCard({ cp, patch, busy, top, close, run }: { cp: Checkpoint; patch?: Patch; busy: boolean; top: number; close(): void; run(): Promise<void> }) {
  const later = useAgent((s) => s.checkpoints.filter((c) => c.current && c.createdAt > cp.createdAt).length);
  return (
    <section aria-label="Checkpoint" className="agentcard pointer-events-auto absolute right-[52px] w-[380px]" style={{ top: `clamp(52px, ${top - 40}px, calc(100% - 280px))` }}>
      <div className="mb-1 flex items-start gap-2">
        <span className="text-violet">◆</span>
        <b className="line-clamp-2 min-w-0 flex-1 font-semibold">{cp.label}</b>
        <IconButton label="Close" className="size-5" onClick={close}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="lbl m-0 mb-2 break-all">
        {cp.files.join(", ")} · {new Date(cp.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </p>
      {patch?.files[0] && (
        <div className="diff mb-2.5">
          <DiffRows lines={lineDiff(patch.files[0].before, patch.files[0].after, 0)} max={6} />
        </div>
      )}
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
        {busy ? <Spinner size={10} /> : cp.current ? <RotateCcw size={11} /> : <Undo2 size={11} className="-scale-x-100" />}
        {cp.current ? (later ? `Rewind this and ${later} later fix${later === 1 ? "" : "es"}` : "Rewind") : "Apply again"}
      </button>
    </section>
  );
}

type Cursor = NonNullable<ShrikeEvents["agent:cursor"]>;

/** O2: a violet "agent" cursor over the app dock that glides to what the agent clicks and pulses. Finds the webview itself. */
export function AgentCursor() {
  const [cur, setCur] = useState<(Cursor & { n: number }) | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let n = 0;
    const off = api().on("agent:cursor", (c) => {
      clearTimeout(hide.current);
      if (!c) return setCur(null);
      const el = document.querySelector("webview");
      const r = el?.getBoundingClientRect();
      if (!r || r.width < 10) return;
      setBox(r);
      setCur((prev) => {
        if (!prev) {
          // Enter from the bottom middle, then glide on the next frame.
          requestAnimationFrame(() => setCur({ ...c, n: ++n }));
          return { ...c, x: r.width / 2, y: r.height - 24, click: false, n: ++n };
        }
        return { ...c, n: c.click ? ++n : prev.n };
      });
      hide.current = setTimeout(() => setCur(null), 3500);
    });
    return () => (off(), clearTimeout(hide.current));
  }, []);

  if (!cur || !box) return null;
  const x = Math.max(0, Math.min(cur.x, box.width - 4));
  const y = Math.max(0, Math.min(cur.y, box.height - 4));
  return createPortal(
    <div aria-hidden className="agent-cursor pointer-events-none fixed z-[60] overflow-hidden" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <style>{`@keyframes shrike-cursor-pulse{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(1.6);opacity:0}}`}</style>
      <div className="absolute" style={{ left: x, top: y, transition: "left .42s cubic-bezier(.3,.7,.2,1), top .42s cubic-bezier(.3,.7,.2,1)" }}>
        {cur.click && <span key={cur.n} className="absolute top-0 left-0 size-9 rounded-full border-2" style={{ borderColor: color.violet, animation: "shrike-cursor-pulse .6s ease-out both" }} />}
        <svg width="18" height="22" viewBox="0 0 18 22" style={{ filter: `drop-shadow(0 0 6px ${color.violet})` }}>
          <path d="M1.5 1.5 L1.5 17.5 L5.8 13.6 L8.6 20 L11.4 18.8 L8.7 12.6 L14.5 12.6 Z" fill={color.violet} stroke={color.core} strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span className="lbl absolute top-[18px] left-[14px] rounded-[4px] px-1.5 py-px text-[9px] text-ink" style={{ background: color.violet, letterSpacing: "0.12em" }}>
          {cur.label}
        </span>
      </div>
    </div>,
    document.body,
  );
}
