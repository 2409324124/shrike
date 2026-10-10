import { useLayoutEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { api } from "../../lib/api.ts";
import { cx } from "../../components/ui.tsx";
import { Dot, Elapsed } from "../../components/Activity.tsx";
import { useCalm } from "../../system/System.tsx";
import { runUndo, useVoiceStore } from "../store.ts";
import { pick } from "../useVoice.ts";
import { FirstRun } from "./Models.tsx";
import { Hints } from "./Hints.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { cardShown, tail } from "./logic.ts";

// V-ui1 strip: the live transcript just above the caption (so, over the composer), with the plan card, hints and setup stacked on it.

/** Where the stack sits: just above the feed's caption, left-aligned with it. */
function useAnchor(on: boolean): { left: number; bottom: number; width: number } {
  const [at, setAt] = useState({ left: 18, bottom: 72, width: 640 });
  useLayoutEffect(() => {
    if (!on) return;
    const stage = document.querySelector('section[aria-label="Shrike"]');
    if (!stage) return;
    const place = () => {
      const r = stage.getBoundingClientRect();
      const cap = stage.querySelector('p[aria-live="polite"]')?.getBoundingClientRect(); // the caption wraps to 2-3 lines when the stage is narrow
      setAt({ left: r.left + 18, bottom: window.innerHeight - (cap ? cap.top - 8 : r.bottom - 64), width: Math.max(240, r.width - 36) });
    };
    place();
    const ro = new ResizeObserver(place); // the stage narrows when a dock opens or the window shrinks
    ro.observe(stage);
    return () => ro.disconnect();
  }, [on]);
  return at;
}

/** Five bars that follow the mic. Calm: one still bar. */
function Meter({ level, calm }: { level: number; calm: boolean }) {
  if (calm) return <span className="v-still" aria-hidden><i style={{ height: `${Math.round(Math.min(1, level) * 100)}%` }} /></span>;
  return (
    <span className="v-meter" aria-hidden>
      {[0.55, 0.85, 1, 0.75, 0.5].map((k, i) => (
        <i key={i} style={{ transform: `scaleY(${0.18 + Math.min(1, level * k * 1.6) * 0.82})` }} />
      ))}
    </span>
  );
}

const TAG: Partial<Record<string, string>> = { listening: "Listening", hearing: "Hearing", thinking: "Working it out" };
const TONE_TAG: Partial<Record<string, string>> = { ok: "Done", miss: "Not sure", card: "Needs your yes" };

export function VoiceStrip() {
  const line = useVoiceStore((s) => s.line);
  const phase = useVoiceStore((s) => s.phase);
  const level = useVoiceStore((s) => s.level);
  const problem = useVoiceStore((s) => s.problem);
  const plan = useVoiceStore((s) => s.plan);
  const hints = useVoiceStore((s) => s.hints);
  const firstRun = useVoiceStore((s) => s.firstRun);
  const undo = useVoiceStore((s) => s.undo);
  const lang = useVoiceStore((s) => s.lang);
  const engine = useVoiceStore((s) => s.engine);
  const hands = useVoiceStore((s) => s.hands);
  const calm = useCalm();
  const open = phase === "listening" || phase === "hearing" || phase === "thinking";
  const carded = cardShown(plan) && line?.tone !== "live" && phase !== "hearing" && !(phase === "listening" && !hands); // the card already says it
  const talking = ((phase === "listening" || phase === "hearing") && !(hands && phase === "listening" && !line?.heard)) || (!!line && !carded);
  const visible = talking || !!problem || !!plan || hints || firstRun || !!undo;
  const at = useAnchor(visible);
  if (!visible) return null;

  const words = tail(line?.heard ?? "");
  const miss = line?.tone === "miss";
  const intents = line?.intents ?? [];

  return (
    <div className={cx("v-stack fixed z-[30] grid justify-items-start gap-1.5", calm && "v-calm")} style={{ left: at.left, bottom: at.bottom, maxWidth: at.width }} data-voice-caption>
      <Hints />
      <FirstRun />
      <PlanCard />
      {talking && (
        <p role="status" aria-live="polite" className={cx("v-strip m-0", miss && "miss")} data-phase={phase}>
          {(open || !!line?.heard || !!lang) && <span className="v-tag-l">
            {phase === "thinking" ? <Dot on tone="var(--violet)" /> : open ? <Meter level={level} calm={calm} /> : null}
            {(line?.heard || open) && <span className={cx("micro text-[9.5px]", line?.tone === "card" && "v-amber")}>{(line && TONE_TAG[line.tone]) ?? TAG[phase] ?? "Heard"}</span>}
            {phase === "thinking" && <Elapsed />}
            {lang && <span className="micro text-[9px] text-faint">{lang.toUpperCase()}</span>}
          </span>}
          <span className={cx("v-words", line?.heard ? "text-ink" : "text-dim")} data-voice-heard>
            {words.words.length ? (
              <>
                {words.cut && <span className="text-faint">… </span>}
                {words.words.map((w, i) => (
                  <span key={`${words.start + i}-${w}`} className="v-w">
                    {w}{" "}
                  </span>
                ))}
              </>
            ) : phase === "listening" || phase === "hearing" ? (
              hands ? "Listening for a command" : "Say a command, then let go"
            ) : (
              ""
            )}
          </span>
          {intents.length > 0 && !miss && (
            <span className="v-intents" data-voice-echo>
              {line?.heard && (
                <span className="text-faint" aria-hidden>
                  →
                </span>
              )}
              {intents.map((c) => (
                <span key={c.label} className="v-intent">
                  {c.label}
                </span>
              ))}
            </span>
          )}
          {line?.echo && (miss || !intents.length) && (
            <span className={cx("shrink-0 whitespace-nowrap", miss ? "text-dim" : line.tone === "card" ? "v-amber" : "text-signal")} data-voice-echo>
              → {line.echo}
            </span>
          )}
          {undo && !plan && (
            <button type="button" className="hud-btn solid ml-1" onClick={() => runUndo()}>
              <Undo2 size={11} aria-hidden />
              Undo
            </button>
          )}
        </p>
      )}
      {!talking && undo && !plan && (
        <p className="v-strip m-0">
          <span className="text-ink">{undo.label}</span>
          <button type="button" className="hud-btn solid ml-1" onClick={() => runUndo()}>
            <Undo2 size={11} aria-hidden />
            Undo
          </button>
        </p>
      )}
      {miss && !plan && (
        <div className="glass solid flex flex-wrap items-center gap-1.5 rounded-[10px] px-2 py-1.5" data-voice-chips>
          {!!line?.chips?.length && <span className="micro mr-0.5 text-[9.5px] text-dim">Did you mean</span>}
          {line?.chips?.map((c) => (
            <button key={c.label} type="button" className="v-chip" title={c.say ? `Or say “${c.say}”` : undefined} onClick={() => pick(c)}>
              <span className="shrink-0">{c.label}</span>
              {c.say && <span className="ml-1.5 text-faint">“{c.say}”</span>}
            </button>
          ))}
          <button type="button" className="hud-btn" onClick={() => useVoiceStore.setState({ hints: true })}>
            What can I say?
          </button>
        </div>
      )}
      {engine === "apple" && open && <p className="micro m-0 text-[9.5px] text-faint">English only until the voice download finishes</p>}
      {problem && (
        <p role="alert" className="glass solid m-0 inline-flex max-w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13px] text-ink" style={{ borderColor: "color-mix(in srgb, var(--fail) 45%, transparent)" }}>
          <span className="min-w-0 wrap-anywhere">{problem.text}</span>
          {problem.pane && (
            <button type="button" className="btn h-6 py-0" onClick={() => void api().openVoiceSettings(problem.pane!)}>
              Open {problem.pane === "dictation" ? "Keyboard" : "Privacy"} settings
            </button>
          )}
          <button type="button" className="btn h-6 py-0" onClick={() => useVoiceStore.setState({ problem: null })}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
