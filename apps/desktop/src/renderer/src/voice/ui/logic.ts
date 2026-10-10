import type { VoicePlan, VoicePlanStep } from "@shrike/schema";

// Pure voice UI rules: what the orb shows, double tap, the push-to-talk key, step icons. Tested in logic.test.ts.

export type Phase = "off" | "setup" | "idle" | "listening" | "hearing" | "thinking" | "done" | "miss";
export type OrbState = Phase | "acting" | "confirm" | "error";

/** One state for the orb: a problem beats a plan, a plan beats the turn. */
export function orbState(phase: Phase, plan: VoicePlan | null, problem: boolean): OrbState {
  if (problem) return "error";
  if (plan?.state === "needs_yes") return "confirm";
  if (plan?.state === "running" && phase !== "listening" && phase !== "hearing") return "acting";
  return phase;
}

/** Double tap of the push-to-talk key: two short, wordless presses close together turn hands-free on. */
export const TAP_MS = 260; // a press shorter than this is a tap, not a held turn
export const GAP_MS = 380; // the second tap must start within this of the first release

export function isDoubleTap(prevDown: number, prevUp: number, now: number, prevHeard: boolean): boolean {
  return !prevHeard && prevUp - prevDown > 0 && prevUp - prevDown < TAP_MS && now - prevUp < GAP_MS;
}

export type PttKey = "alt+space" | "ctrl+alt+space" | "alt+backquote";
export const PTT_KEYS: { id: PttKey; label: string }[] = [
  { id: "alt+space", label: "⌥ Space" },
  { id: "ctrl+alt+space", label: "⌃⌥ Space" },
  { id: "alt+backquote", label: "⌥ `" },
];
export const pttLabel = (k: PttKey): string => PTT_KEYS.find((p) => p.id === k)?.label ?? "⌥ Space";

export function isPtt(e: Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">, key: PttKey): boolean {
  if (!e.altKey || e.metaKey || e.shiftKey) return false;
  if (key === "alt+space") return e.code === "Space" && !e.ctrlKey;
  if (key === "ctrl+alt+space") return e.code === "Space" && e.ctrlKey;
  return e.code === "Backquote" && !e.ctrlKey;
}

/** Releasing either key of the chord ends the turn. */
export const isPttUp = (e: Pick<KeyboardEvent, "code" | "key">, key: PttKey): boolean =>
  e.key === "Alt" || (key === "alt+backquote" ? e.code === "Backquote" : e.code === "Space") || (key === "ctrl+alt+space" && e.key === "Control");

/** Which icon a step wears, by its registry id. */
export type StepIcon = "stage" | "commit" | "push" | "pr" | "ci" | "run" | "stop" | "file" | "panel" | "branch" | "agent" | "undo" | "step";
export function stepIcon(action: string): StepIcon {
  const [area = "", verb = ""] = action.split(".");
  if (area === "agent") return "agent";
  if (area === "ci") return "ci";
  if (area === "pr") return "pr";
  if (area === "file" || verb.startsWith("open_file")) return "file";
  if (area === "panel" || area === "view" || verb.startsWith("show")) return "panel";
  if (area === "workspace" || area === "branch" || verb.includes("branch") || verb === "switch") return "branch";
  if (area === "git") return verb.startsWith("stage") ? "stage" : verb.startsWith("commit") ? "commit" : verb.includes("push") || verb === "sync" ? "push" : verb.includes("undo") || verb.includes("discard") ? "undo" : "commit";
  if (verb === "run" || verb === "start" || verb === "restart") return "run";
  if (verb === "stop") return "stop";
  return "step";
}

/** Outward steps leave your Mac; destructive ones throw work away. Both are marked on the card. */
export const leavesMac = (s: Pick<VoicePlanStep, "risk">): boolean => s.risk === "outward" || s.risk === "destructive";

/** The card is for several steps, a yes, or a failure; one quick step speaks through the strip. */
export const cardShown = (plan: VoicePlan | null): plan is VoicePlan => !!plan && (plan.steps.length > 1 || plan.state === "needs_yes" || plan.state === "failed");

/** "Step 2 of 3" for the card header and the orb's progress ring. */
export function progress(plan: VoicePlan): { done: number; total: number } {
  const steps = plan.steps.filter((s) => s.state !== "skipped");
  return { done: steps.filter((s) => s.state === "done").length, total: steps.length };
}

/** 682 MB, 1.3 GB. */
export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The newest words of a long partial, so the strip shows what you're saying now. */
export function tail(text: string, max = 14): { cut: boolean; words: string[]; start: number } {
  const w = text.trim().split(/\s+/).filter(Boolean);
  const start = Math.max(0, w.length - max);
  return { cut: start > 0, words: w.slice(start), start };
}
