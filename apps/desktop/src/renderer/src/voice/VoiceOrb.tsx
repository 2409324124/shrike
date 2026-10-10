import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, Lock, LockOpen, SlidersHorizontal } from "lucide-react";
import { cx, IconButton } from "../components/ui.tsx";
import { useCalm } from "../system/System.tsx";
import { useVoiceStore } from "./store.ts";
import { press, release, setHands } from "./useVoice.ts";
import { orbState, progress, pttLabel } from "./ui/logic.ts";
import { VoiceStrip } from "./ui/Strip.tsx";
import { VoiceSettings } from "./ui/Settings.tsx";
import "./ui/voice.css";

// V5: the N4 orb in the top bar (next to ASK), the hands-free lock and voice settings. The strip and cards portal to the stage.

function Orb() {
  const phase = useVoiceStore((s) => s.phase);
  const level = useVoiceStore((s) => s.level);
  const problem = useVoiceStore((s) => !!s.problem);
  const plan = useVoiceStore((s) => s.plan);
  const hands = useVoiceStore((s) => s.hands);
  const calm = useCalm();
  const state = orbState(phase, plan, problem);
  const p = plan ? progress(plan) : null;
  const style = { "--lvl": calm ? 0.4 : level.toFixed(3), "--prog": p?.total ? `${(p.done / p.total) * 100}%` : "0%" } as CSSProperties;
  return (
    <span className={cx("v-orb", calm && "v-calm")} data-state={state} data-hands={hands} style={style} aria-hidden>
      <i className="v-ring" />
      <i className="v-sweep" />
      <i className="v-ball" />
      {state === "done" && <Check size={10} strokeWidth={3} className="v-tick" />}
    </span>
  );
}

const LABEL: Record<string, string> = {
  setup: "Getting voice ready",
  listening: "Listening. Let go to act",
  hearing: "Hearing you. Let go to act",
  thinking: "Working out what you said",
  acting: "Running your plan",
  confirm: "Waiting for your yes",
  error: "Voice needs attention",
};

/** The top-bar orb: press and hold to talk (or hold the key anywhere), double tap or the lock for hands-free. */
export function VoiceOrb() {
  const phase = useVoiceStore((s) => s.phase);
  const hands = useVoiceStore((s) => s.hands);
  const key = useVoiceStore((s) => pttLabel(s.prefs.key));
  const plan = useVoiceStore((s) => s.plan);
  const problem = useVoiceStore((s) => !!s.problem);
  const state = orbState(phase, plan, problem);
  const label = hands ? `Hands-free is on. ${LABEL[state] ?? "Listening for a command"}` : (LABEL[state] ?? `Voice: hold to talk (${key}), double tap for hands-free`);
  return (
    <span className="group/voice no-drag inline-flex items-center gap-0.5" data-voice-orb>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={phase === "listening" || phase === "hearing"}
        className="no-drag inline-flex h-6 items-center gap-2 rounded-[6px] px-2 text-dim transition-colors hover:text-ink"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          press();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), press())}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && release()}
      >
        <Orb />
        {hands && <span className="v-live text-[12px]">Listening</span>}
      </button>
      <IconButton label={hands ? "Turn hands-free off" : "Hands-free: keep listening"} aria-pressed={hands} className={cx(hands ? "text-signal" : "opacity-0 group-hover/voice:opacity-100 focus-visible:opacity-100")} onClick={() => setHands(!hands)}>
        {hands ? <Lock size={12} /> : <LockOpen size={12} />}
      </IconButton>
      <IconButton label="Voice settings" className="opacity-0 group-hover/voice:opacity-100 focus-visible:opacity-100" onClick={() => useVoiceStore.setState({ settings: true })}>
        <SlidersHorizontal size={12} />
      </IconButton>
      {createPortal(
        <>
          <VoiceStrip />
          <VoiceSettings />
        </>,
        document.body,
      )}
    </span>
  );
}
