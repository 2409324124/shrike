import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Check, Plug, X } from "lucide-react";
import type { BuildRail, BuildStage, SdlcStage, SdlcState } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { useAgent } from "../stores/agent.ts";
import { toast, useUi } from "../stores/ui.ts";
import { cx, Spinner } from "../components/ui.tsx";
import { hiddenMoves, sentence, type Move } from "./logic.ts";
import { runMove, viewTrip } from "./commands.ts";
import { currentBuildStage, currentStage } from "../../../main/sdlc.ts";
import { useActions } from "../stores/actions.ts";
import { useThread } from "../stores/thread.ts";
import { useQuests } from "../quests/store.ts"; // quests: L8–L15
import { inFlight, railMode, type RailMode } from "../quests/logic.ts";
import { ShowOptionsToggle } from "../options/OptionsLayer.tsx"; // options: M6
import { openPrPanel } from "../pr/index.ts"; // pr-ci: PR1–PR10
import { openTools, readyNames, useMcp } from "../mcp/store.ts"; // mcp: MCP1

// L1–L7 the SDLC rail and the hidden moves made obvious (docs/13). The rail is computed in main (sdlc.ts).

const STAGES: { id: SdlcStage; word: string }[] = [
  { id: "spot", word: "Spot" },
  { id: "understand", word: "Understand" },
  { id: "fix", word: "Fix" },
  { id: "prove", word: "Prove" },
  { id: "review", word: "Review" },
  { id: "ship", word: "Ship" },
  { id: "watch", word: "Watch" },
];


// ---------- other engineers' components, found by file and export name (see notesForOthers) ----------

const mods = import.meta.glob<Record<string, unknown>>(
  ["../**/*{Skill,skill,Ship,ship,Flow,flow,Worktree,worktree,PickUp,Pickup,pickup,Race,race,Git,git}*.tsx", "!../dev/**", "!../**/*.test.tsx"],
  { eager: true },
);

type Any = ComponentType<any>;
/** The first exported component whose name matches. */
export function slot(re: RegExp): Any | undefined {
  for (const m of Object.values(mods)) for (const [k, v] of Object.entries(m)) if (re.test(k) && typeof v === "function") return v as Any;
  return undefined;
}
/** Every exported component whose name ends in "Overlay": mounted over the Thread with no props. */
export const overlays = (): [string, Any][] =>
  Object.values(mods).flatMap((m) => Object.entries(m).filter(([k, v]) => /Overlay$/.test(k) && typeof v === "function") as [string, Any][]);

export const SLOTS = {
  skills: /^Skills?(Shelf|Sheet|Library)$/,
  ship: /^(Ship|Git|GitHub)(Sheet|Shelf|Panel)$/,
  flows: /^Flows?(Shelf|Sheet)$/,
  worktrees: /^Worktrees?(Tabs|Row|Bar)$/,
  pickUp: /^PickUp(Card)?$/,
  race: /^(Fix)?Race(Card|View|Board)$/,
};

// ---------- bridge ----------

/** Rail state, flows, race and saved commands. Mount once (Shell). */
export function useSdlcBridge(): void {
  useEffect(() => {
    const a = api();
    const set = useUi.setState;
    const offs = [
      a.on("sdlc:update", (sdlc) => sdlc && typeof sdlc === "object" && set((s) => ({ sdlc, sdlcOpen: sdlc.actionId ? s.sdlcOpen : null }))),
      a.on("flows:update", (flows) => Array.isArray(flows) && set({ flows })),
      a.on("race:update", (race) => race && set({ race })),
      a.on("git:update", (g) => g && set({ hasPr: !!g.pr && g.pr.state === "open" })),
      a.on("skills:update", (skills) => Array.isArray(skills) && useAgent.setState({ skills })),
      a.on("actions:cleared", () => set({ race: null })),
    ];
    // Quiet when a neighbour's handler isn't there yet: the rail just stays hidden.
    void a.getSdlc().then((sdlc) => set({ sdlc }), () => {});
    void a.listFlows().then((flows) => set({ flows }), () => {});
    void a.listCommands().then((commands) => set({ commands }), () => {});
    return () => offs.forEach((off) => off());
  }, []);
}

// ---------- hidden moves ----------

function useMoves(): Move[] {
  const sdlc = useUi((s) => s.sdlc);
  const flows = useUi((s) => s.flows);
  const race = useUi((s) => s.race);
  const hasPr = useUi((s) => s.hasPr);
  const checkpoints = useAgent((s) => s.checkpoints);
  const agentBusy = useAgent((s) => s.run?.status === "running");
  const steps = useAgent((s) => s.steps);
  const pending = useAgent((s) => s.approvals.find((r) => r.patch)?.patch?.id);
  return useMemo(() => {
    if (!sdlc) return [];
    const findings = steps.findLast((s) => s.kind === "findings")?.findings ?? [];
    return hiddenMoves({ sdlc, checkpoints, flows, findings, pendingPatchId: pending, reviewing: sdlc.stages.review === "active" && !!sdlc.detail.review, agentBusy, race, hasPr });
  }, [sdlc, checkpoints, flows, steps, pending, agentBusy, race, hasPr]);
}

export function MoveButton({ move, quiet }: { move: Move; quiet?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={cx("btn h-7 px-2.5", !quiet && "go")}
      title={move.hint}
      disabled={busy}
      data-move={move.id}
      onClick={async () => {
        setBusy(true);
        await runMove(move);
        setBusy(false);
      }}
    >
      {busy && <Spinner size={10} />}
      {move.label}
    </button>
  );
}

/** "Review this fix" for the patch card (A8): a review-only run on the diff before Apply. */
export function ReviewFixButton({ patchId }: { patchId: string }) {
  const running = useUi((s) => s.sdlc?.stages.review === "active" && !!s.sdlc.detail.review);
  return (
    <MoveButton
      quiet
      move={{ id: "review-fix", label: running ? "Reviewing…" : "Review this fix", hint: "A second look at the change before you apply it: bugs, missed cases, security.", patchId }}
    />
  );
}

// ---------- the rail ----------

const DOT: Record<SdlcState["stages"][SdlcStage], string> = {
  idle: "border-faint/60",
  active: "border-signal bg-signal",
  done: "border-ok/70 bg-ok/70",
  failed: "border-fail bg-fail",
  skipped: "border-faint/40 border-dashed",
};

/** One slim rail under the top bar while a change is in flight: Fix (L1–L7) or Build (L8–L15). Only the current stage is bright. */
export function SdlcRail() {
  const sdlc = useUi((s) => s.sdlc);
  const pick = useQuests((s) => s.railPick);
  const focusId = useThread((s) => s.focus.actionId);
  const focusBroken = useActions((s) => !!focusId && s.byId[focusId]?.status === "error");
  const mode = railMode(sdlc, pick, focusBroken);
  if (!sdlc || !mode) return null;
  const both = !!sdlc.actionId && !!sdlc.build;
  const toggle = both ? <ModeToggle mode={mode} sdlc={sdlc} /> : null;
  return mode === "build" && sdlc.build ? <BuildRailRow rail={sdlc.build} toggle={toggle} /> : <FixRail sdlc={sdlc} toggle={toggle} />;
}

/** L-mode: Fix / Build, only while both are in flight. A pick holds until what's in flight changes. */
function ModeToggle({ mode, sdlc }: { mode: RailMode; sdlc: SdlcState }) {
  return (
    <span role="radiogroup" aria-label="Rail mode" className="inline-flex h-5 shrink-0 items-center overflow-hidden rounded-[6px] border border-hair">
      {(["fix", "build"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => useQuests.setState({ railPick: { mode: m, key: inFlight(sdlc) }, buildOpen: null })}
          className={cx("micro h-full px-2 text-[9px]", mode === m ? "bg-glass text-ink" : "text-faint hover:text-dim")}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

function FixRail({ sdlc, toggle }: { sdlc: SdlcState; toggle: ReactNode }) {
  const open = useUi((s) => s.sdlcOpen);
  const moves = useMoves();
  const cur = currentStage(sdlc);
  return (
    <div className="no-drag relative z-40 flex h-9 shrink-0 items-center gap-3 border-b border-hair pr-1.5 pl-3" aria-label="Where this change is">
      {toggle}
      <ol className="flex min-w-0 items-center">
        {STAGES.map((st, i) => {
          const state = sdlc.stages[st.id];
          const now = st.id === cur;
          const bad = state === "failed";
          return (
            <li key={st.id} className="flex items-center">
              {i > 0 && <span aria-hidden className={cx("mx-1.5 h-px w-4", state === "idle" ? "bg-hair" : "bg-faint/40")} />}
              <button
                type="button"
                data-stage={st.id}
                data-state={state}
                aria-current={now ? "step" : undefined}
                aria-expanded={open === st.id}
                title={sdlc.detail[st.id] ?? st.word}
                onClick={() => useUi.setState({ sdlcOpen: open === st.id ? null : st.id })}
                className={cx(
                  "micro inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[9.5px] transition-colors",
                  now ? (bad ? "text-fail" : "text-ink") : bad ? "text-fail/80" : state === "done" ? "text-dim/70" : "text-faint/70",
                  "hover:text-ink",
                )}
              >
                <i
                  aria-hidden
                  className={cx("block size-[7px] rounded-full border", DOT[state])}
                  style={now ? { boxShadow: `0 0 10px ${bad ? "var(--fail)" : "var(--signal)"}, 0 0 2px ${bad ? "var(--fail)" : "var(--signal)"}` } : undefined}
                />
                {st.word}
              </button>
            </li>
          );
        })}
      </ol>
      {cur && <span className={cx("hidden min-w-0 flex-1 truncate text-[12px] lg:inline", sdlc.detail[cur] ? "text-dim" : "text-faint")}>{sdlc.detail[cur] ?? EMPTY[cur]}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {moves.map((m, i) => (
          <MoveButton key={m.id} move={m} quiet={i > 0} />
        ))}
      </div>
      {open && <StageDetail stage={open} sdlc={sdlc} />}
    </div>
  );
}

function StageDetail({ stage, sdlc }: { stage: SdlcStage; sdlc: SdlcState }) {
  const i = STAGES.findIndex((s) => s.id === stage);
  const state = sdlc.stages[stage];
  const checkpoints = useAgent((s) => s.checkpoints);
  const fix = checkpoints.findLast((c) => c.current);
  const close = () => useUi.setState({ sdlcOpen: null });
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown> | void) => async () => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const tone = state === "failed" ? "text-fail" : state === "done" ? "text-ok" : state === "active" ? "text-signal" : "text-faint";
  const word = { idle: "Not yet", active: "Now", done: "Done", failed: "Needs you", skipped: "Skipped" }[state];

  return (
    <section
      role="dialog"
      aria-label={`${STAGES[i]!.word} stage`}
      className="glass solid rise absolute top-[38px] z-50 w-[360px] rounded-[var(--r-card)] p-4"
      style={{ left: `clamp(8px, ${12 + i * 88}px, calc(100% - 368px))`, background: "color-mix(in srgb, var(--abyss) 97%, transparent)", boxShadow: "0 18px 50px rgba(0,0,0,.55)" }}
    >
      <header className="mb-2 flex items-center gap-2">
        <span className="lbl text-ink">{STAGES[i]!.word}</span>
        <span className={cx("lbl", tone)}>· {word}</span>
        <button type="button" aria-label="Close" onClick={close} className="ml-auto inline-flex size-5 items-center justify-center rounded text-dim hover:text-ink">
          <X size={12} />
        </button>
      </header>
      <p className="text-[13px] leading-snug text-ink">{sdlc.detail[stage] ?? EMPTY[stage]}</p>

      {stage === "prove" && sdlc.tests && <p className="mt-2 font-mono text-[11.5px] text-dim">Tests: {sdlc.tests}</p>}
      {stage === "review" && !!sdlc.review?.length && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {sdlc.review.slice(0, 6).map((f, k) => (
            <li key={k}>
              <button
                type="button"
                disabled={!f.file}
                onClick={() => f.file && useUi.getState().openFile({ path: f.file, line: f.line ?? 1 })}
                className="w-full rounded-[6px] px-2 py-1.5 text-left hover:bg-glass"
              >
                <span className={cx("lbl mr-2", f.confidence === "possible" ? "text-faint" : "text-slow")}>{f.confidence === "possible" ? "nit" : "concern"}</span>
                <span className="text-[12.5px] text-ink">{sentence(f.claim, 160)}</span>
                {f.file && <span className="ml-1.5 font-mono text-[10.5px] text-faint">{f.file.split("/").pop()}{f.line ? `:${f.line}` : ""}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {(stage === "spot" || stage === "understand") && (
          <button type="button" className="btn" onClick={() => (close(), viewTrip(sdlc.actionId!))}>
            Show the trip
          </button>
        )}
        {stage === "understand" && state !== "done" && (
          <button type="button" className="btn go" onClick={() => (close(), useAgent.getState().openAndFocus("Why does this break? Find the cause."))}>
            Ask why
          </button>
        )}
        {stage === "fix" && fix && (
          <button type="button" className="btn" onClick={() => useUi.setState({ checkpoint: fix.id, sdlcOpen: null })}>
            See the change
          </button>
        )}
        {stage === "prove" && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={act(async () => {
              const r = await call((a) => a.runTests(), "Couldn't run the tests");
              if (r === null) toast("This project has no test script.");
            })}
          >
            {busy && <Spinner size={10} />} Run the tests
          </button>
        )}
        {stage === "review" && fix && state !== "active" && (
          <button type="button" className="btn go" disabled={busy} onClick={act(() => runMove({ id: "review-fix", label: "", hint: "", patchId: fix.patchId }))}>
            {busy && <Spinner size={10} />} {state === "idle" ? "Review this fix" : "Review again"}
          </button>
        )}
        {stage === "review" && state !== "done" && state !== "skipped" && (
          <button type="button" className="btn" onClick={act(() => call((a) => a.waiveReview().then((sdlc) => useUi.setState({ sdlc, sdlcOpen: null })), "Couldn't skip the review"))}>
            Skip the review
          </button>
        )}
        {stage === "ship" && (
          <button type="button" className="btn go" onClick={() => useUi.setState({ panel: "ship", sdlcOpen: null })}>
            Open Ship <kbd className="text-faint">S</kbd>
          </button>
        )}
        {stage === "ship" && (
          <button type="button" className="btn" onClick={() => (useUi.setState({ sdlcOpen: null }), openPrPanel())}>
            Checks and comments
          </button>
        )}
        {stage === "watch" && (
          <button type="button" className="btn" onClick={() => useUi.setState({ panel: "flows", sdlcOpen: null })}>
            Your flows <kbd className="text-faint">W</kbd>
          </button>
        )}
        {state === "done" && stage !== "watch" && <Check size={14} className="ml-auto self-center text-ok" aria-hidden />}
      </div>
    </section>
  );
}

// ---------- L8–L15: Build mode ----------

const BUILD: { id: BuildStage; word: string }[] = [
  { id: "idea", word: "Idea" },
  { id: "plan", word: "Plan" },
  { id: "design", word: "Design" },
  { id: "build", word: "Build" },
  { id: "prove", word: "Prove" },
  { id: "review", word: "Review" },
  { id: "ship", word: "Ship" },
  { id: "live", word: "Live" },
];

const BUILD_EMPTY: Record<BuildStage, string> = {
  idea: "Say what you want to build.",
  plan: "Your agent splits the idea into objectives, each with a flow that proves it.",
  design: "When something is visual, your agent shows you options to pick from.",
  build: "Send the next objective to your agent, or build it in a new workspace.",
  prove: "Each objective is checked off when its flow passes.",
  review: "A second look at the change before it ships: bugs, missed cases, security.",
  ship: "Branch, commit, push and open a pull request. Nothing is pushed until you say yes.",
  live: "Lights up when the pull request is merged.",
};

function BuildRailRow({ rail, toggle }: { rail: BuildRail; toggle: ReactNode }) {
  const open = useQuests((s) => s.buildOpen);
  const cur = currentBuildStage(rail);
  return (
    <div className="no-drag relative z-40 flex h-9 shrink-0 items-center gap-3 border-b border-hair pr-1.5 pl-3" aria-label="Where this feature is" data-mode="build">
      {toggle}
      <ol className="flex min-w-0 items-center">
        {BUILD.map((st, i) => {
          const state = rail.stages[st.id];
          const now = st.id === cur;
          const bad = state === "failed";
          return (
            <li key={st.id} className="flex items-center">
              {i > 0 && <span aria-hidden className={cx("mx-1.5 h-px w-4", state === "idle" ? "bg-hair" : "bg-faint/40")} />}
              <button
                type="button"
                data-stage={st.id}
                data-state={state}
                aria-current={now ? "step" : undefined}
                aria-expanded={open === st.id}
                title={rail.detail[st.id] ?? st.word}
                onClick={() => useQuests.setState({ buildOpen: open === st.id ? null : st.id })}
                className={cx(
                  "micro inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[9.5px] transition-colors",
                  now ? (bad ? "text-fail" : "text-ink") : bad ? "text-fail/80" : state === "done" ? "text-dim/70" : "text-faint/70",
                  state === "skipped" && "line-through",
                  "hover:text-ink",
                )}
              >
                <i
                  aria-hidden
                  className={cx("block size-[7px] rounded-full border", DOT[state])}
                  style={now ? { boxShadow: `0 0 10px ${bad ? "var(--fail)" : "var(--signal)"}, 0 0 2px ${bad ? "var(--fail)" : "var(--signal)"}` } : undefined}
                />
                {st.word}
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="hidden min-w-0 flex-1 truncate text-left text-[12px] text-dim hover:text-ink lg:inline" title="Open the quest board (Q)" onClick={() => useQuests.getState().setOpen(true)}>
        {cur ? (rail.detail[cur] ?? BUILD_EMPTY[cur]) : rail.title}
      </button>
      {open && <BuildDetail stage={open} rail={rail} />}
    </div>
  );
}

function BuildDetail({ stage, rail }: { stage: BuildStage; rail: BuildRail }) {
  const i = BUILD.findIndex((s) => s.id === stage);
  const state = rail.stages[stage];
  const fix = useAgent((s) => s.checkpoints.findLast((c) => c.current));
  const close = () => useQuests.setState({ buildOpen: null });
  const board = () => (close(), useQuests.getState().setOpen(true));
  const tone = state === "failed" ? "text-fail" : state === "done" ? "text-ok" : state === "active" ? "text-signal" : "text-faint";
  const word = { idle: "Not yet", active: "Now", done: "Done", failed: "Needs you", skipped: "Skipped" }[state];
  return (
    <section
      role="dialog"
      aria-label={`${BUILD[i]!.word} stage`}
      className="glass solid rise absolute top-[38px] z-50 w-[360px] rounded-[var(--r-card)] p-4"
      style={{ left: `clamp(8px, ${12 + i * 78}px, calc(100% - 368px))`, background: "color-mix(in srgb, var(--abyss) 97%, transparent)", boxShadow: "0 18px 50px var(--shade)" }}
    >
      <header className="mb-2 flex items-center gap-2">
        <span className="lbl text-ink">{BUILD[i]!.word}</span>
        <span className={cx("lbl", tone)}>· {word}</span>
        <button type="button" aria-label="Close" onClick={close} className="ml-auto inline-flex size-5 items-center justify-center rounded text-dim hover:text-ink">
          <X size={12} />
        </button>
      </header>
      <p className="text-[13px] leading-snug text-ink">{rail.detail[stage] ?? BUILD_EMPTY[stage]}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(stage === "idea" || stage === "plan" || stage === "prove" || stage === "build") && (
          <button type="button" className="btn go" onClick={board}>
            Quest board <kbd className="text-faint">Q</kbd>
          </button>
        )}
        {stage === "build" && fix && (
          <button type="button" className="btn" onClick={() => (close(), useUi.setState({ checkpoint: fix.id }))}>
            See the change
          </button>
        )}
        {stage === "review" && fix && state !== "active" && (
          <button type="button" className="btn go" onClick={() => (close(), void runMove({ id: "review-fix", label: "", hint: "", patchId: fix.patchId }))}>
            {state === "idle" ? "Review this change" : "Review again"}
          </button>
        )}
        {stage === "ship" && (
          <button type="button" className="btn go" onClick={() => (close(), useUi.setState({ panel: "ship" }))}>
            Open Ship <kbd className="text-faint">S</kbd>
          </button>
        )}
        {(stage === "ship" || stage === "live") && (
          <button type="button" className="btn" onClick={() => (close(), openPrPanel())}>
            Checks and comments
          </button>
        )}
        {state === "done" && <Check size={14} className="ml-auto self-center text-ok" aria-hidden />}
      </div>
    </section>
  );
}

const EMPTY: Record<SdlcStage, string> = {
  spot: "Nothing has broken yet.",
  understand: "Ask your agent why it broke, or look at the trip yourself.",
  fix: "No fix applied yet.",
  prove: "Re-run what broke. Your saved flows and unit tests count here too.",
  review: "A second look at the fix before it ships: bugs, missed cases, security.",
  ship: "Branch, commit, push and open a pull request. Nothing is pushed until you say yes.",
  watch: "Keep watching re-runs your saved flows on every save, and tells you if one turns red.",
};

// ---------- the Ask pill's options (Plan first, Think harder, my tools, Save as command) ----------

const THINK = [
  { id: "quick", word: "Quick" },
  { id: "normal", word: "Normal" },
  { id: "deep", word: "Deep" },
] as const;

export function AskOptions({ auto, onSaveCommand, optionsToggle = true }: { auto: boolean; onSaveCommand?: () => void; optionsToggle?: boolean }) {
  const o = useUi((s) => s.ask);
  const [listed, setMine] = useState<string[]>([]);
  useEffect(() => void api().listMyMcpServers().then((l) => Array.isArray(l) && setMine(l), () => {}), []);
  const hub = useMcp((s) => s.state);
  const mine = useMemo(() => (hub ? readyNames(hub) : listed), [hub, listed]); // MCP1: follows the Tools tab's switches
  const set = (p: Partial<typeof o>) => useUi.setState((s) => ({ ask: { ...s.ask, ...p } }));
  const plan = o.planFirst ?? auto;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 px-3" aria-label="How your agent works">
      <button
        type="button"
        aria-pressed={plan}
        onClick={() => set({ planFirst: !plan })}
        title="Your agent says what it will change before it touches any file. On by default when the ask sounds like several files."
        className={cx("btn h-6 px-2 text-[10px]", plan && "on")}
      >
        Plan first{o.planFirst === null && <span className="text-faint normal-case tracking-normal">· auto</span>}
      </button>
      <span role="radiogroup" aria-label="Think harder" className="inline-flex h-6 items-center overflow-hidden rounded-[8px] border border-hair" title="How hard your agent thinks. Deep is slower and uses more of your plan, for subtle bugs.">
        <span className="micro px-2 text-[9px] text-faint">Think</span>
        {THINK.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={o.thinking === t.id}
            onClick={() => set({ thinking: t.id })}
            className={cx("micro h-full px-2 text-[9.5px]", o.thinking === t.id ? (t.id === "deep" ? "bg-violet/15 text-violet" : "bg-glass text-ink") : "text-dim hover:text-ink")}
          >
            {t.word}
          </button>
        ))}
      </span>
      {optionsToggle && <ShowOptionsToggle />}
      {mine.length > 0 ? (
        <span className="inline-flex items-center">
          <button
            type="button"
            aria-pressed={o.useMyMcp}
            onClick={() => set({ useMyMcp: !o.useMyMcp })}
            title={`Also let your agent use your own tools: ${mine.join(", ")}`}
            className={cx("btn h-6 max-w-[220px] rounded-r-none px-2 text-[10px]", o.useMyMcp && "on")}
          >
            <span className="truncate">My tools · {mine.slice(0, 2).join(", ")}{mine.length > 2 ? ` +${mine.length - 2}` : ""}</span>
          </button>
          <button type="button" aria-label="Manage your tools" title="See, check and add tools (MCP servers)" onClick={() => openTools()} className="btn -ml-px h-6 rounded-l-none px-1.5">
            <Plug size={10} aria-hidden />
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => openTools()} title="Give your agent more tools: a browser, GitHub, your database (MCP servers)" className="btn h-6 px-2 text-[10px]">
          <Plug size={10} aria-hidden />
          Add tools
        </button>
      )}
      {onSaveCommand && (
        <button type="button" onClick={onSaveCommand} className="btn ml-auto h-6 px-2 text-[10px]" title="Keep this ask as a / command you can run again">
          Save as command
        </button>
      )}
    </div>
  );
}
