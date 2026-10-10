import { X } from "lucide-react";
import { IconButton } from "../../components/ui.tsx";
import { useUi } from "../../stores/ui.ts";
import { useDock } from "../../dock/store.ts";
import { useVoiceStore } from "../store.ts";
import { pick } from "../useVoice.ts";
import { hintsFor, type Hint, type Where } from "./hints.ts";
import { pttLabel } from "./logic.ts";

// V-ui5: "what can I say", the focused panel's commands first, then the global ones.

const NAMES: Record<Where, string> = {
  thread: "the Thread", logs: "Logs", network: "Network", api: "the API client", terminal: "the terminal", details: "Details",
  skills: "Skills", flows: "Flows", ship: "Ship", changes: "Changes", pr: "the PR panel", file: "this file",
};

/** The panel you're looking at, for hints and "did you mean". */
export function currentWhere(): Where {
  const ui = useUi.getState();
  const dock = useDock.getState();
  if (ui.panel) return ui.panel;
  if (ui.sheet) return ui.sheet;
  if (ui.file) return "file";
  if (dock.open && (dock.tab === "changes" || dock.tab === "pr")) return dock.tab;
  return "thread";
}

function Row({ h }: { h: Hint }) {
  return (
    <li>
      <button type="button" className="v-hint group grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-[6px] px-2 py-1 text-left" onClick={() => pick({ label: h.does, say: h.say, action: h.id })}>
        <span className="min-w-0 truncate font-display text-[13.5px] text-ink" title={h.also ? `“${h.say}” or “${h.also}”` : undefined}>
          “{h.say}”{h.also && <span className="ml-2 text-[12px] text-dim">or “{h.also}”</span>}
        </span>
        <span className="max-w-[16rem] truncate text-right text-[11.5px] text-dim group-hover:text-ink">{h.does}</span>
      </button>
    </li>
  );
}

export function Hints() {
  const open = useVoiceStore((s) => s.hints);
  const key = useVoiceStore((s) => s.prefs.key);
  useUi((s) => s.panel); // re-render when the panel changes
  useUi((s) => s.sheet);
  useUi((s) => s.file);
  useDock((s) => s.open && s.tab);
  if (!open) return null;
  const where = currentWhere();
  const { here, anywhere } = hintsFor(where);
  return (
    <section role="dialog" aria-label="What you can say" className="glass solid rise w-[min(520px,100%)] rounded-[var(--r-card)] px-3 pt-2.5 pb-3 shadow-[0_20px_50px_var(--shade)]" data-voice-hints>
      <header className="mb-1 flex items-center gap-2 pl-2">
        <span className="lbl text-ink">What you can say</span>
        <span className="micro text-[9.5px] text-faint">Hold {pttLabel(key)} · English, Hindi, Hinglish</span>
        <span className="flex-1" />
        <IconButton label="Close what you can say" onClick={() => useVoiceStore.setState({ hints: false })}>
          <X size={12} />
        </IconButton>
      </header>
      {here.length > 0 && (
        <>
          <p className="micro m-0 mt-1 mb-0.5 pl-2 text-[9.5px] text-signal">In {NAMES[where]}</p>
          <ul className="m-0 list-none p-0">
            {here.map((h) => (
              <Row key={h.say} h={h} />
            ))}
          </ul>
        </>
      )}
      <p className="micro m-0 mt-2 mb-0.5 pl-2 text-[9.5px] text-dim">Anywhere</p>
      <ul className="m-0 list-none p-0">
        {anywhere.map((h) => (
          <Row key={h.say} h={h} />
        ))}
      </ul>
      <p className="m-0 mt-2 pl-2 text-[11.5px] text-dim">Chain them with “and”, “then”, “aur” or “phir”. Anything that leaves your Mac waits for your yes.</p>
    </section>
  );
}
