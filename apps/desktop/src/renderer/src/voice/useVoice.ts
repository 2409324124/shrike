import { useEffect } from "react";
import type { VoiceChip, VoiceEvent, VoicePlan } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { liveContext } from "../actions/run.ts";
import { controls, onPlan, refreshFiles, voiceDeps, warmPlanner } from "./act.ts";
import { contextWords } from "./grammar.ts";
import { Turn, type Echo } from "./router.ts";
import { translit } from "./understand/normalize.ts";
import { markUsed, offerUndo, showPlan, useVoiceStore, type PlanControls } from "./store.ts";
import { isDoubleTap, isPtt, isPttUp, TAP_MS } from "./ui/logic.ts";

// Push-to-talk: hold ⌥ Space (or press and hold the orb), talk, let go. Double tap, or the orb's lock: hands-free.
// The turn itself (partials, the cascade, yes / no / stop / undo) is router.ts; this file is the loop and what you see.

const FINAL_WAIT_MS = 1500; // the final lands ~140ms after release; this only covers a stuck helper
const LINE_MS = 3500; // the strip stays this long after the last change
const MISS_MS = 9000; // a miss keeps its chips up longer: never a dead end
const HANDS_FIRST_ID = 1_000_000; // the helper numbers hands-free turns from here
const BLUR_OFF_MS = 10 * 60_000; // hands-free turns off when Shrike has been in the background this long
const THINK_MS = 250; // the sweep only shows when the result is slow; a ~140ms final never flashes it
const MIC_MS = 2500; // hands-free with no level from the helper by then: the mic isn't open, so the orb mustn't say it is

let turnId = 0;
let turn: Turn | null = null;
let held = false;
let downAt = 0;
let upAt = 0;
let swallow = false; // this press toggled hands-free; its release does nothing
let spoke = false; // the last press heard words (so it can't be the first half of a double tap)
let lastPartial = "";
let finalTimer: ReturnType<typeof setTimeout> | undefined;
let lineTimer: ReturnType<typeof setTimeout> | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
let thinkTimer: ReturnType<typeof setTimeout> | undefined;
let micTimer: ReturnType<typeof setTimeout> | undefined;
let activity = 0;
let blurAt = 0;
let sentWords = "";
let warmed = false;

const set = useVoiceStore.setState;
const get = useVoiceStore.getState;
const rest = () => (get().hands ? "listening" : "idle");
const roman = (t: string) => (/[\u0900-\u097f]/.test(t) ? translit(t) : t); // Hinglish shows in Roman script

function show(e: Echo & { intents?: VoiceChip[] }): void {
  const miss = e.tone === "miss";
  const intents = e.intents ?? (e.tone === "ok" && e.echo ? [{ label: e.echo }] : undefined);
  set({ line: { ...e, heard: roman(e.heard), intents, at: Date.now() } });
  const live = held && !swallow;
  clearTimeout(lineTimer);
  if (!live) lineTimer = setTimeout(() => set({ line: null }), miss ? MISS_MS : e.tone === "card" ? MISS_MS : LINE_MS);
  if (e.tone === "ok" || miss) {
    if (!live) settle(e.tone === "ok");
  } else if (e.tone === "thinking") set({ phase: "thinking" });
  else if (e.tone === "card") set({ phase: rest(), level: 0 }); // the orb turns amber from the plan
  else if (e.heard && (get().phase === "listening" || get().phase === "idle")) set({ phase: "hearing" });
}

function settle(ok: boolean): void {
  clearTimeout(doneTimer);
  set({ phase: ok ? "done" : "miss", level: 0 });
  doneTimer = setTimeout(() => (get().phase === "done" || get().phase === "miss") && set({ phase: rest() }), ok ? 700 : 1400);
}

function newTurn(id = ++turnId): Turn {
  return new Turn(id, voiceDeps({ show, help: () => set({ hints: true }), voiceOff: () => setHands(false) }));
}

/** The executor's emit (act.ts onPlan): the card, its buttons, the echo of a plan that finished after a click, the 5 second Undo. */
export function fromExecutor(s: { plan: VoicePlan | null; echo: string | null; undoUntil: number | null }, c: PlanControls & { undo(): unknown }): void {
  const was = get().plan;
  showPlan(s.plan, c);
  const p = s.plan;
  if (!p || p.state === "running" || p.state === "needs_yes" || (was?.id === p.id && was.state === p.state)) return;
  if (s.echo && !held) show({ heard: p.heard, echo: s.echo, tone: p.state === "failed" ? "miss" : "ok", chips: [] });
  if (s.undoUntil && s.undoUntil > Date.now() && p.steps.some((x) => x.state === "done" && x.risk === "undoable")) offerUndo(s.echo ?? "the last step", () => void c.undo(), s.undoUntil - Date.now());
}

function sendContext(): void {
  void refreshFiles().then((files) => {
    const ctx = liveContext();
    const words = contextWords(files, [...ctx.prs.map((p) => p.title), ...ctx.checks.map((c) => c.name), ...ctx.branches, ...ctx.workspaces.map((w) => w.name), ...ctx.skills.map((x) => x.name), ...ctx.flows.map((f) => f.name)]);
    const key = words.join("|");
    if (key === sentWords) return;
    sentWords = key;
    void api().voiceSend({ cmd: "context", words }).catch(() => {});
  });
}

/** The planner and its prompt load once, in the background, the first time voice is used this session. */
function warm(): void {
  if (warmed) return;
  warmed = true;
  warmPlanner();
}

function sendConfig(): void {
  void api().voiceSend({ cmd: "config", langs: get().prefs.langs }).catch(() => {});
}

/** The first press with the open model missing opens the download card (once, unless you said Not now). */
function maybeFirstRun(): void {
  const s = get();
  const asr = s.models?.models.find((m) => m.id === "asr");
  if (asr && asr.state === "missing" && !s.prefs.later) set({ firstRun: true });
}

/** Hands-free on or off: the helper cuts turns itself, the orb stays lit. */
export function setHands(on: boolean, why?: string): void {
  if (get().hands === on) return;
  turn = null;
  lastPartial = "";
  activity = Date.now();
  clearTimeout(micTimer);
  if (on) micTimer = setTimeout(() => (setHands(false), set({ problem: { text: "Hands-free didn't start: the voice helper isn't hearing the mic." } })), MIC_MS);
  const p = get().plan;
  if (p && p.state !== "needs_yes" && p.state !== "running") showPlan(null); // a finished card from before doesn't hide the new mode
  set({ hands: on, phase: on ? "listening" : "idle", level: 0 });
  void api().voiceSend({ cmd: "hands", on }).catch(() => {});
  if (on) (markUsed(), sendConfig(), sendContext(), warm(), maybeFirstRun());
  show({ heard: "", echo: why ?? (on ? "Hands-free is on" : "Hands-free is off"), tone: "ok" });
}

/** Key or orb down: listening within a frame. A quick second tap turns hands-free on; any press turns it off. */
export function press(): void {
  if (held) return;
  const now = performance.now();
  held = true;
  swallow = false;
  if (get().hands) return void ((swallow = true), setHands(false));
  if (isDoubleTap(downAt, upAt, now, spoke)) {
    swallow = true;
    void api().voiceSend({ cmd: "stop" }).catch(() => {});
    return void setHands(true);
  }
  downAt = now;
  markUsed();
  clearTimeout(finalTimer);
  clearTimeout(lineTimer);
  clearTimeout(doneTimer);
  clearTimeout(thinkTimer);
  turn = newTurn();
  lastPartial = "";
  activity = Date.now();
  const s = get();
  set({ phase: s.phase === "setup" ? "setup" : "listening", level: 0, line: null, problem: s.problem?.pane === "mic" ? s.problem : null });
  void api().voiceSend({ cmd: "start", id: turn.id }).catch(() => {});
  sendContext();
  warm();
  maybeFirstRun();
}

/** Key or orb up: the final words arrive in ~140ms and act. A tap with nothing heard just goes quiet. */
export function release(): void {
  if (!held) return;
  held = false;
  upAt = performance.now();
  spoke = !!lastPartial;
  if (swallow) return;
  void api().voiceSend({ cmd: "stop" }).catch(() => {});
  const t = turn;
  if (upAt - downAt < TAP_MS && !lastPartial) {
    turn = null;
    return void set({ phase: rest(), level: 0 });
  }
  set({ level: 0 });
  clearTimeout(thinkTimer);
  thinkTimer = setTimeout(() => t === turn && (get().phase === "listening" || get().phase === "hearing") && set({ phase: "thinking" }), THINK_MS);
  finalTimer = setTimeout(() => t && t === turn && heard(t, lastPartial), FINAL_WAIT_MS);
  if (get().line?.echo) show(get().line!); // already acted on a partial: flash now
}

/** The final words: router.ts answers the card, barge-in and plan words, and runs everything else through the cascade. */
function heard(t: Turn, text: string): void {
  void t.final(text).finally(() => {
    if (turn === t && !held) turn = null;
  });
}

/** A "did you mean" chip or a "what can I say" row: its plan through the same gates, else its words as if said. */
export function pick(chip: VoiceChip): void {
  if (chip.plan?.length || (chip.action && !chip.say)) return controls.pick(chip);
  const t = newTurn();
  turn = t;
  heard(t, chip.say ?? chip.label);
}

function handsTurn(id: number): Turn | null {
  if (!get().hands || id < HANDS_FIRST_ID) return null;
  if (turn?.id !== id) ((turn = newTurn(id)), (lastPartial = ""));
  return turn;
}

/** Main relays the helper's events here. */
export function onVoiceEvent(e: VoiceEvent): void {
  switch (e.type) {
    case "ready":
      if (e.mic === "denied" || e.mic === "restricted") set({ problem: { text: "Shrike can't use the microphone. Allow ShrikeVoice in Privacy settings.", pane: "mic" } });
      if (get().phase === "off" || get().phase === "setup") set({ phase: held ? "listening" : rest() });
      return;
    case "setup":
      return set({ phase: "setup" });
    case "permission":
      if (e.mic !== "granted") {
        set({ problem: { text: "Shrike can't use the microphone. Allow ShrikeVoice in Privacy settings.", pane: "mic" }, phase: "idle" });
        turn = null;
      } else if (get().problem?.pane === "mic") set({ problem: null });
      return;
    case "level":
      clearTimeout(micTimer);
      if (held || get().hands) set({ level: e.value });
      return;
    case "vad":
      if (e.speech) {
        activity = Date.now();
        handsTurn(e.id);
        if (turn?.id === e.id && get().phase !== "thinking") set({ phase: "hearing" });
      } else if (get().hands && turn?.id === e.id && !lastPartial) set({ phase: "listening" });
      return;
    case "lang":
      return set({ lang: e.lang });
    case "engine":
      return set({ engine: e.engine });
    case "turn":
      return;
    case "partial": {
      const t = handsTurn(e.id) ?? turn;
      if (t && e.id === t.id) {
        activity = Date.now();
        lastPartial = e.text;
        t.partial(e.text);
      }
      return;
    }
    case "final": {
      const t = handsTurn(e.id) ?? turn;
      if (t && e.id === t.id) {
        clearTimeout(finalTimer);
        if (get().hands && !held && !(e.text || lastPartial).trim()) return void ((turn = null), set({ phase: "listening" })); // a cough or the fan: stay quiet
        heard(t, e.text || lastPartial);
      }
      return;
    }
    case "error":
      if (e.id != null && e.id !== turn?.id) return;
      set({ problem: { text: e.message, pane: e.code === "dictation" ? "dictation" : undefined }, phase: "idle", level: 0 });
      return;
  }
}

/** Mount once (Shell): the push-to-talk key, the helper's events, model progress, hands-free auto-off. */
export function useVoice(): void {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!isPtt(e, get().prefs.key)) return;
      e.preventDefault(); // no non-breaking space in a field, no replay
      e.stopPropagation();
      if (!e.repeat) press();
    };
    const up = (e: KeyboardEvent) => {
      if (held && isPttUp(e, get().prefs.key)) {
        e.preventDefault();
        release();
      }
    };
    const blur = () => ((blurAt = Date.now()), release());
    const focus = () => (blurAt = 0);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    const offEvent = api().on("voice:event", onVoiceEvent);
    onPlan((s) => fromExecutor(s, controls));
    const offModels = api().on("voice:models", (models) => {
      set({ models });
      if (models.models.every((m) => m.state === "ready") && get().firstRun) setTimeout(() => set({ firstRun: false }), 2400);
    });
    void api()
      .voiceModels()
      .then((models) => set({ models }))
      .catch(() => {});

    // Talked before: start the helper now so the first press is instant.
    const warmUp = get().used ? setTimeout(() => (sendConfig(), sendContext(), warm()), 1200) : undefined;
    const offLangs = useVoiceStore.subscribe((s, p) => s.prefs.langs !== p.prefs.langs && sendConfig());

    const idle = setInterval(() => {
      const s = get();
      if (!s.hands) return;
      const now = Date.now();
      if (now - activity > s.prefs.offMin * 60_000) setHands(false, `Hands-free is off after ${s.prefs.offMin} quiet minutes`);
      else if (blurAt && now - blurAt > BLUR_OFF_MS) setHands(false, "Hands-free is off while Shrike is in the background");
    }, 15_000);

    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      offEvent();
      offModels();
      offLangs();
      clearTimeout(warmUp);
      clearInterval(idle);
      release();
    };
  }, []);
}

