import { create } from "zustand";
import { z } from "zod";
import type { VoiceChip, VoiceModels, VoicePlan } from "@shrike/schema";
import type { Echo } from "./router.ts";
import type { Phase } from "./ui/logic.ts";
import { isMac } from "../lib/platform.ts";

export type { Phase } from "./ui/logic.ts";

/** Something only the person can fix, with the System Settings pane that fixes it. */
export interface Problem {
  text: string;
  pane?: "mic" | "speech" | "dictation";
}

/** The transcript strip: what was heard, what it did, the intents the grammar matched, "did you mean" chips. */
export type Line = Echo & { intents?: VoiceChip[]; chips?: VoiceChip[]; at: number };

/** What the plan executor hands the card: the buttons and the spoken yes/no call these. */
export interface PlanControls {
  yes(how: "voice" | "click", words?: string): void; // the executor decides whether a destructive yes is complete
  no(): void;
  stop(): void;
  pick?(chip: VoiceChip): void; // a "did you mean" chip; also learns the phrase
}

const Prefs = z.object({
  langs: z.array(z.string().regex(/^[a-z]{2}$/)).max(12).catch([]), // [] = auto
  key: z.enum(["alt+space", "ctrl+alt+space", "alt+backquote"]).catch(isMac ? "alt+space" : "ctrl+alt+space"), // Alt+Space opens the window menu on Windows and GNOME
  offMin: z.union([z.literal(5), z.literal(10), z.literal(30)]).catch(10),
  later: z.boolean().catch(false), // chose "Not now" on the model download
});
export type Prefs = z.infer<typeof Prefs>;

interface VoiceState {
  phase: Phase;
  level: number; // 0..1 mic level while the mic is open
  line: Line | null;
  used: boolean; // has talked once: the first-run hint is done, warm the helper on launch
  problem: Problem | null;
  hands: boolean; // hands-free: the mic stays open, the orb stays lit
  lang: string | null; // the language the last turn was decoded as
  engine: "open" | "apple" | null; // apple: English only, while the open model downloads
  plan: VoicePlan | null;
  undo: { label: string; until: number } | null;
  models: VoiceModels | null;
  firstRun: boolean; // the download card
  settings: boolean;
  hints: boolean; // "what can I say"
  prefs: Prefs;
}

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

function defaultLangs(): string[] {
  const nav = typeof navigator !== "undefined" ? navigator.languages : [];
  const codes = [...new Set(nav.map((l) => l.slice(0, 2).toLowerCase()))].filter((c) => /^[a-z]{2}$/.test(c));
  return codes.length ? codes.slice(0, 3) : ["en"];
}

function loadPrefs(): Prefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(read("shrike.voice.prefs") ?? "null");
  } catch {}
  if (!raw || typeof raw !== "object") return { langs: defaultLangs(), key: isMac ? "alt+space" : "ctrl+alt+space", offMin: 10, later: false };
  return Prefs.parse(raw);
}

export const useVoiceStore = create<VoiceState>(() => ({
  phase: "off",
  level: 0,
  line: null,
  used: read("shrike.voice.used") === "1",
  problem: null,
  hands: false,
  lang: null,
  engine: null,
  plan: null,
  undo: null,
  models: null,
  firstRun: false,
  settings: false,
  hints: false,
  prefs: loadPrefs(),
}));

export function markUsed(): void {
  if (useVoiceStore.getState().used) return;
  write("shrike.voice.used", "1");
  useVoiceStore.setState({ used: true });
}

export function setPrefs(p: Partial<Prefs>): void {
  const prefs = { ...useVoiceStore.getState().prefs, ...p };
  write("shrike.voice.prefs", JSON.stringify(prefs));
  useVoiceStore.setState({ prefs });
}

// ---------- plans: the executor writes, the card and the spoken answers read ----------

let controls: PlanControls | null = null;
let undoFn: (() => void) | null = null;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
const UNDO_MS = 5000;

/** The plan executor calls this on every step change; null clears the card. */
export function showPlan(plan: VoicePlan | null, c?: PlanControls): void {
  if (c) controls = c;
  if (!plan) controls = null;
  useVoiceStore.setState({ plan });
}

export const planControls = (): PlanControls | null => controls;

/** An undoable step finished: Undo on the strip for 5 seconds ("undo that" / "wapas karo" works too). */
export function offerUndo(label: string, undo: () => void, ms = UNDO_MS): void {
  undoFn = undo;
  clearTimeout(undoTimer);
  useVoiceStore.setState({ undo: { label, until: Date.now() + ms } });
  undoTimer = setTimeout(() => ((undoFn = null), useVoiceStore.setState({ undo: null })), ms);
}

export function runUndo(): boolean {
  const f = undoFn;
  undoFn = null;
  clearTimeout(undoTimer);
  useVoiceStore.setState({ undo: null });
  if (!f) return false;
  f();
  return true;
}

export const canUndo = (): boolean => !!undoFn;
