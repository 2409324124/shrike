import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx, IconButton } from "../../components/ui.tsx";
import { setPrefs, useVoiceStore, type Prefs } from "../store.ts";
import { setHands } from "../useVoice.ts";
import { ModelRows } from "./Models.tsx";
import { PTT_KEYS, pttLabel } from "./logic.ts";

// V-ui7 settings: mode, languages, push-to-talk key, hands-free auto-off, the on-device models. Opened from the orb's sliders.

export const LANGS: { id: string; label: string; note?: string }[] = [
  { id: "en", label: "English" },
  { id: "hi", label: "Hindi", note: "and Hinglish, shown in Roman script" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "pt", label: "Portuguese" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese" },
  { id: "zh", label: "Chinese" },
  { id: "ko", label: "Korean" },
  { id: "ru", label: "Russian" },
];

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-t border-hair py-3.5 first:border-t-0 first:pt-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="lbl whitespace-nowrap text-ink">{title}</span>
        {note && <span className="text-[12px] text-dim">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Seg<T extends string | number>({ label, value, options, onPick }: { label: string; value: T; options: { id: T; label: string }[]; onPick(v: T): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="v-seg">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} className={cx(o.id === value && "on")} onClick={() => onPick(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function VoiceSettings() {
  const open = useVoiceStore((s) => s.settings);
  const prefs = useVoiceStore((s) => s.prefs);
  const hands = useVoiceStore((s) => s.hands);
  const models = useVoiceStore((s) => s.models);
  const close = () => useVoiceStore.setState({ settings: false });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const auto = prefs.langs.length === 0;
  const toggle = (id: string) => {
    const has = prefs.langs.includes(id);
    const langs = has ? prefs.langs.filter((l) => l !== id) : [...prefs.langs, id];
    setPrefs({ langs });
  };
  return (
    <div className="no-drag fixed inset-0 z-50 bg-void/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-label="Voice settings" className="glass solid rise absolute top-14 right-4 flex max-h-[calc(100%-80px)] w-[min(460px,94%)] flex-col rounded-[var(--r-card)] shadow-[0_30px_80px_var(--shade)]" data-voice-settings>
        <header className="flex items-center gap-3 py-3 pr-2 pl-5">
          <span className="lbl text-ink">Voice</span>
          <span className="text-[12.5px] text-dim">Everything runs on this Mac. Nothing is spoken back.</span>
          <span className="flex-1" />
          <IconButton label="Close voice settings" onClick={close}>
            <X size={13} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">
          <Section title="Mode" note={hands ? "The mic is open. The orb stays lit." : `Hold ${pttLabel(prefs.key)} and talk.`}>
            <Seg
              label="Mode"
              value={hands ? "hands" : "ptt"}
              options={[
                { id: "ptt", label: "Push to talk" },
                { id: "hands", label: "Hands-free" },
              ]}
              onPick={(v) => setHands(v === "hands")}
            />
            <span className="text-[12px] text-dim">Double tap {pttLabel(prefs.key)} or click the orb's lock to switch. Hands-free can push or merge after you say “yes” with the plan on screen.</span>
          </Section>
          <Section title="Push-to-talk key">
            <Seg label="Push-to-talk key" value={prefs.key} options={PTT_KEYS} onPick={(key: Prefs["key"]) => setPrefs({ key })} />
          </Section>
          <Section title="Languages I speak" note={auto ? "Auto: slower and less sure on English" : undefined}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Languages I speak">
              <button type="button" className={cx("v-chip", auto && "on")} aria-pressed={auto} onClick={() => setPrefs({ langs: auto ? ["en"] : [] })}>
                Auto
              </button>
              {LANGS.map((l) => (
                <button key={l.id} type="button" className={cx("v-chip", prefs.langs.includes(l.id) && "on")} aria-pressed={prefs.langs.includes(l.id)} title={l.note} onClick={() => toggle(l.id)}>
                  {l.label}
                  {l.id === "hi" && <span className="ml-1 text-dim">+ Hinglish</span>}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-dim">Pick the ones you use. Hinglish shows in Roman script (“PR 42 kholo”).</span>
          </Section>
          <Section title="Hands-free turns off after">
            <Seg
              label="Hands-free turns off after"
              value={prefs.offMin}
              options={[
                { id: 5, label: "5 min" },
                { id: 10, label: "10 min" },
                { id: 30, label: "30 min" },
              ]}
              onPick={(offMin: Prefs["offMin"]) => setPrefs({ offMin })}
            />
            <span className="text-[12px] text-dim">Counted from the last thing you said. It also turns off after 10 minutes in the background.</span>
          </Section>
          <Section title="On-device models" note="Downloaded once, checked, kept in Shrike's folder">
            {models ? <ModelRows models={models} /> : <span className="text-[12px] text-dim">Not available yet.</span>}
          </Section>
          <button type="button" className="hud-btn solid mt-1" onClick={() => useVoiceStore.setState({ settings: false, hints: true })}>
            What can I say?
          </button>
        </div>
      </section>
    </div>
  );
}
