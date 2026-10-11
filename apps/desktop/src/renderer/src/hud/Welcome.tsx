import { ArrowRight, Palette } from "lucide-react";
import { useProject } from "../stores/project.ts";
import { relativeTime } from "../lib/format.ts";
import { Spinner } from "../components/ui.tsx";
import { Appearance, useTheme } from "../themes/index.ts";
import { Frame } from "./Shell.tsx";
import { slot, SLOTS } from "./Sdlc.tsx";
import { ShrikeBust } from "../brand/index.ts";
import { isMac } from "../lib/platform.ts";

const PickUpCard = slot(SLOTS.pickUp); // flows engineer's "Pick up where you left off"

export function Welcome() {
  const { recent, opening, openDialog, openSample, openRoot } = useProject();

  return (
    <Frame>
      <div className={`drag flex h-11 shrink-0 items-center justify-end ${isMac ? "pr-2" : "pr-[calc(100%-env(titlebar-area-width,100%)+6px)]"}`}>
        <button type="button" className="hud-btn no-drag size-7 justify-center px-0" aria-label="Appearance" title="Appearance" onClick={() => useTheme.getState().setOpen(true)}>
          <Palette size={14} aria-hidden />
        </button>
        <Appearance />
      </div>
      <main className="relative flex flex-1 items-center justify-center overflow-auto px-6 pb-16">
        <div className="rise flex w-full max-w-[420px] flex-col items-center text-center">
          <ShrikeBust width={300} drawIn />
          <p className="mt-6 font-display text-[18px] font-medium text-ink">See what your code actually did.</p>

          <div className="mt-9 flex w-full flex-col gap-2">
            <button type="button" disabled={opening} onClick={() => void openSample()} className="btn go h-11 justify-between px-4">
              Open the sample project
              {opening ? <Spinner size={13} /> : <ArrowRight size={14} />}
            </button>
            <button type="button" disabled={opening} onClick={() => void openDialog()} className="btn h-11 px-4">
              Open a folder
            </button>
          </div>

          {PickUpCard && (
            <div className="mt-6 w-full text-left">
              <PickUpCard />
            </div>
          )}

          {recent.length > 0 && (
            <section className="mt-9 w-full text-left">
              <h2 className="lbl mb-2 px-1 text-faint">Recent</h2>
              <ul>
                {recent.map((r) => (
                  <li key={r.root}>
                    <button type="button" disabled={opening} onClick={() => void openRoot(r.root)} className="flex w-full items-baseline gap-3 rounded-[8px] px-1 py-1.5 text-left hover:bg-glass">
                      <span className="text-[13.5px] text-ink">{r.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{r.root}</span>
                      <span className="lbl text-faint">{relativeTime(r.openedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <p className="absolute bottom-5 m-0 text-[12.5px] text-dim">Everything stays on this machine.</p>
      </main>
    </Frame>
  );
}
