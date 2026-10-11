import "./chains.css";
import { useState } from "react";
import { GitBranch, Link2, Pause, Play, X } from "lucide-react";
import type { UpNextItem, UpNextWhen } from "@shrike/schema";
import { cx } from "../components/ui.tsx";
import { useAgent } from "../stores/agent.ts";
import { atClock, blankChain, inMinutes, isOpenItem, missedWhy, whenLabel, WHEN_CHOICES } from "./logic.ts";
import { useChains } from "./store.ts";
import { keys } from "../lib/platform.ts";

// P-chain1 up next stack, P-chain2 the "when" chip. The stack sits under the agent pill's header; the chip is a native select.

const DRAG = "application/x-shrike-upnext";

/** P-chain2: when a queued prompt fires. A native select; "At a time" opens a native clock field. */
export function WhenChip({ value, onChange, label = "When it runs" }: { value: UpNextWhen; onChange(w: UpNextWhen): void; label?: string }) {
  const [clock, setClock] = useState(false);
  const pick = (v: string) => {
    if (v === "at") return setClock(true);
    setClock(false);
    if (v === "in30" || v === "in60") return onChange({ on: "time", at: inMinutes(v === "in30" ? 30 : 60) });
    if (v !== "cur") onChange({ on: v as Exclude<UpNextWhen["on"], "time"> });
  };
  return (
    <span className="inline-flex items-center gap-1">
      <select aria-label={label} className={cx("upn-when", value.on === "time" && "sched")} value={value.on === "time" ? "cur" : value.on} onChange={(e) => pick(e.target.value)}>
        {value.on === "time" && <option value="cur">{whenLabel(value)}</option>}
        {WHEN_CHOICES.map((w) => (
          <option key={w.on} value={w.on}>
            {whenLabel(w)}
          </option>
        ))}
        <option value="in30">In 30 min</option>
        <option value="in60">In 1 hour</option>
        <option value="at">At a time…</option>
      </select>
      {clock && (
        <input
          type="time"
          aria-label="Run it at"
          autoFocus
          className="upn-clock"
          onChange={(e) => {
            const at = atClock(e.target.value);
            if (at) onChange({ on: "time", at });
          }}
          onBlur={() => setClock(false)}
        />
      )}
    </span>
  );
}

function Card({ it, index, drag }: { it: UpNextItem; index: number; drag: { over: number | null; setOver(i: number | null): void } }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(it.prompt);
  const st = useChains.getState();
  const commit = () => {
    setEditing(false);
    if (text.trim() && text.trim() !== it.prompt) void st.edit(it.id, { prompt: text.trim() });
    else setText(it.prompt);
  };
  if (it.state === "running")
    return (
      <li className="upn-card go" aria-label={`Starting: ${it.prompt}`}>
        <span className="lbl text-[9px] text-signal">Now</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{it.prompt}</span>
      </li>
    );
  if (it.state === "missed")
    return (
      <li className="upn-card missed" aria-label={`Missed: ${it.prompt}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] text-ink">{it.prompt}</p>
          <p className="text-[11px] text-slow">{missedWhy(it)} Run it now?</p>
          <div className="mt-1 flex gap-1">
            <button type="button" className="hud-btn solid h-5 px-1.5 text-[9.5px]" onClick={() => void st.answerMissed(it.id, true)}>
              Run it now
            </button>
            <button type="button" className="hud-btn h-5 px-1.5 text-[9.5px]" onClick={() => void st.answerMissed(it.id, false)}>
              Skip
            </button>
          </div>
        </div>
      </li>
    );
  return (
    <li
      className={cx("upn-card", drag.over === index && "over")}
      draggable={!editing}
      tabIndex={0}
      aria-label={`Up next ${index + 1}: ${it.prompt}`}
      onDragStart={(e) => (e.dataTransfer.setData(DRAG, it.id), (e.dataTransfer.effectAllowed = "move"))}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG)) return;
        e.preventDefault();
        drag.setOver(index);
      }}
      onDragLeave={() => drag.setOver(null)}
      onDrop={(e) => {
        drag.setOver(null);
        const id = e.dataTransfer.getData(DRAG);
        if (id && id !== it.id) void st.move(id, index);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) (e.preventDefault(), void st.move(it.id, Math.max(0, index + (e.key === "ArrowUp" ? -1 : 1))));
        else if (e.key === "Enter") (e.preventDefault(), setEditing(true));
        else if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), void st.edit(it.id, null));
      }}
    >
      <span className="upn-grip" aria-hidden>
        ⋮⋮
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            aria-label="Edit the prompt"
            className="field h-6 w-full text-[12px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              if (e.key === "Escape") (setText(it.prompt), setEditing(false));
            }}
            onBlur={commit}
          />
        ) : (
          <button type="button" className="block w-full truncate text-left text-[12px] text-ink" title="Click to edit" onClick={() => setEditing(true)}>
            {it.prompt}
          </button>
        )}
        <div className="mt-1 flex items-center gap-1">
          <WhenChip value={it.when} onChange={(when) => void st.edit(it.id, { when })} />
          <button
            type="button"
            className={cx("upn-icon", it.target === "branch" && "on")}
            aria-pressed={it.target === "branch"}
            aria-label={it.target === "branch" ? "Runs as a branch" : "Runs in this session"}
            title={it.target === "branch" ? "Runs as a branch. Click to run it in this session" : "Runs in this session. Click to run it as a branch"}
            onClick={() => void st.edit(it.id, { target: it.target === "branch" ? "main" : "branch" })}
          >
            <GitBranch size={10} />
          </button>
          <span className="flex-1" />
          <button type="button" className="upn-icon" aria-label={`Remove ${it.prompt}`} onClick={() => void st.edit(it.id, null)}>
            <X size={10} />
          </button>
        </div>
      </div>
    </li>
  );
}

/** P-chain1: prompts waiting for the run going now (or a time, the app, CI), in order. */
export function UpNextStack() {
  const items = useChains((s) => s.items);
  const paused = useChains((s) => s.paused);
  const [over, setOver] = useState<number | null>(null);
  const open = items.filter(isOpenItem);
  if (!open.length) return null;
  const waiting = open.filter((i) => i.state !== "running");
  return (
    <section aria-label="Up next" className="upn">
      <header className="flex items-center gap-2">
        <span className={cx("lbl text-[9.5px]", paused ? "text-slow" : "text-violet")}>
          Up next{waiting.length ? ` · ${waiting.length}` : ""}
          {paused ? " · paused" : ""}
        </span>
        <span className="flex-1" />
        <button type="button" className="hud-btn h-5 px-1.5 text-[9.5px]" aria-label={paused ? "Resume up next" : "Pause up next"} onClick={() => void useChains.getState().pause(!paused)}>
          {paused ? <Play size={8} /> : <Pause size={8} />}
          {paused ? "Resume" : "Pause"}
        </button>
      </header>
      <ol className="flex flex-col gap-1">
        {open.map((it) => (
          <Card key={it.id} it={it} index={waiting.indexOf(it)} drag={{ over, setOver }} />
        ))}
      </ol>
    </section>
  );
}

/** The Ask pill's row: when it should run, Add to up next (⌘⇧Enter), and Make it a chain. */
export function AskChainRow({ goal, busy, onQueue }: { goal: string; busy: boolean; onQueue(): void }) {
  const when = useChains((s) => s.askWhen);
  const scheduled = when.on === "time" || when.on === "app" || when.on === "ci";
  const queues = busy || when.on !== "finished"; // Enter queues too (AskPill's submit)
  return (
    <div className="mt-2 flex items-center justify-center gap-1.5" aria-label="Up next and chains">
      {queues && (
        <>
          <WhenChip value={when} label="When the queued prompt runs" onChange={(askWhen) => useChains.setState({ askWhen })} />
          <button type="button" className="hud-btn solid h-6 px-2 text-[10px]" disabled={!goal.trim()} onClick={onQueue}>
            {scheduled && !busy ? "Schedule" : "Add to up next"} <span className="text-faint">{keys("⌘⇧↵")}</span>
          </button>
        </>
      )}
      {!queues && (
        <WhenChip value={when} label="When the prompt runs" onChange={(askWhen) => useChains.setState({ askWhen })} />
      )}
      <button type="button" className="hud-btn h-6 px-2 text-[10px]" title="Score it, then run a follow-up by the result" onClick={() => (useAgent.getState().setOpen(false), useChains.getState().openEditor(blankChain(goal.trim())))}>
        <Link2 size={10} /> Make it a chain
      </button>
    </div>
  );
}
