import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronUp, CornerDownLeft, FileText, GitBranch, MessagesSquare, X } from "lucide-react";
import type { FileNode } from "@shrike/schema";
import { useActions } from "../stores/actions.ts";
import { useAgent } from "../stores/agent.ts";
import { useProject } from "../stores/project.ts";
import { tripOrder, useThread } from "../stores/thread.ts";
import { useUi } from "../stores/ui.ts";
import { useWorktrees } from "../stores/worktrees.ts";
import { cx } from "../components/ui.tsx";
import { Activity } from "../components/Activity.tsx";
import { fileChip, fuel, goalWithContext, mergeSlash, parseSlash, planFirstDefault, rankQuick, slashMatches, type Chip, type SlashEntry } from "../hud/logic.ts";
import { acceptsDrop, ask, dropOnAsk, runEntry, saveAsCommand, tidyUp } from "../hud/commands.ts";
import { AskOptions } from "../hud/Sdlc.tsx";
import { AskChainRow } from "../chains/UpNext.tsx"; // chains: P1–P3
import { useChains } from "../chains/store.ts";
import { isOpenItem } from "../chains/logic.ts";
import { ShowOptionsToggle } from "../options/OptionsLayer.tsx";
import { atQuery, dropAt } from "./logic.ts";
import { Conversation, useTurnCount } from "./Conversation.tsx";
import "./composer.css";
import { planThis } from "../quests/logic.ts"; // quests: QB1
import { useQuests } from "../quests/store.ts";

// Q1: the composer. Always docked under the stage, so there is one obvious place to talk to your agent (⌘K focuses it).

function suggestion(): string | null {
  const id = useThread.getState().focus.actionId ?? tripOrder().pop();
  const a = id ? useActions.getState().byId[id] : undefined;
  return a?.status === "error" ? `When I ${a.label.replace(/^Clicked/, "click")} it doesn't work` : null;
}

/** Drag a station, log line or file here (O8). Shared by the composer and the top bar's Ask button. */
export function useAskDrop() {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!acceptsDrop(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        if (!acceptsDrop(e.dataTransfer)) return;
        e.preventDefault();
        dropOnAsk(e.dataTransfer);
      },
    },
  };
}

function ContextChip({ chip }: { chip: Chip }) {
  return (
    <span className="fade-in inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-violet/40 bg-violet/10 py-[3px] pr-1 pl-2 font-mono text-[11px] text-ink" title={chip.line}>
      <span className="truncate">{chip.label}</span>
      <button type="button" aria-label={`Remove ${chip.label}`} onClick={() => useUi.getState().removeChip(chip.id)} className="inline-flex size-4 items-center justify-center rounded-[4px] text-dim hover:text-ink">
        <X size={10} />
      </button>
    </span>
  );
}

const flatten = (nodes: FileNode[], out: string[] = []): string[] => (nodes.forEach((n) => (n.dir ? flatten(n.children ?? [], out) : out.push(n.path))), out);

/** Where you are talking: the worktree, the agent and what it is doing. */
function Where() {
  const tree = useWorktrees((s) => s.list?.find((w) => w.current));
  const project = useProject((s) => s.project?.name);
  const brain = useAgent((s) => s.brains.find((b) => b.id === s.brain)?.label);
  const state = useAgent((s) => (s.approvals.length ? "waiting for you" : s.run?.status === "running" ? "working" : "idle"));
  const dot = state === "working" ? "var(--violet)" : state === "waiting for you" ? "var(--slow)" : "var(--ink-faint)";
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2 self-center" aria-label="Where you are talking">
      <span className="inline-flex max-w-[110px] @2xl:max-w-[160px] items-center gap-1 px-1 text-[12px] text-ink" title={tree ? `${tree.branch} · ${tree.path}` : project}>
        <GitBranch size={10} className="shrink-0 text-signal" aria-hidden />
        <span className="truncate">{tree?.branch ?? project ?? "project"}</span>
      </span>
      <Activity on={state !== "idle"} tone={dot} timer={state === "working"} label={`${brain ?? "No agent"} · ${state}`} className="hidden text-[12px] text-dim @3xl:inline-flex" />
    </span>
  );
}

export function Composer() {
  const open = useAgent((s) => s.open);
  const nonce = useAgent((s) => s.focusNonce);
  const goal = useAgent((s) => s.goal);
  const brains = useAgent((s) => s.brains);
  const brain = useAgent((s) => s.brain);
  const busy = useAgent((s) => s.run?.status === "running");
  const chainLive = useChains((s) => !!s.chain && s.chain.state !== "done" && s.chain.state !== "stopped"); // P3: asking now would cut in
  const upNext = useChains((s) => s.items.filter(isOpenItem).length);
  const chips = useUi((s) => s.chips);
  const skills = useAgent((s) => s.skills);
  const commands = useUi((s) => s.commands);
  const files = useProject((s) => s.files);
  const full = useAgent((s) => fuel(s.usage) > 0.8);
  const turnCount = useTurnCount();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [talk, setTalk] = useState(false); // Q2: the conversation view
  const drop = useAskDrop();
  const entries = useMemo(() => mergeSlash(skills, commands), [skills, commands]);
  const hint = useMemo(() => (open ? suggestion() : null), [open]);
  const palette = slashMatches(goal, entries);
  const at = palette ? null : atQuery(goal, caret);
  const fileList = useMemo(() => (at ? rankQuick(at.query, flatten(files).map((p) => ({ label: p })), 6) : []), [at?.query, files]);
  const list = palette ?? (at ? fileList : null);

  useEffect(() => {
    if (open) setTimeout(() => useAgent.getState().open && ref.current?.select(), 0); // a fast Enter may have closed it already
  }, [open, nonce]);
  useEffect(() => {
    if (!open && document.activeElement === ref.current) ref.current?.blur();
  }, [open]);
  useEffect(() => setSel(0), [goal]);

  const close = () => useAgent.getState().setOpen(false);
  const command = (e: SlashEntry, rest = "") => {
    useAgent.getState().setGoal("");
    close();
    runEntry(e, rest);
  };
  const pickFile = (path: string) => {
    if (!at) return;
    useUi.getState().addChip(fileChip(path));
    useAgent.getState().setGoal(dropAt(goal, at.start, caret));
    setTimeout(() => ref.current?.focus(), 0);
  };
  /** P1: Add to up next (⌘⇧Enter, or Enter while the agent works). */
  const queue = () => {
    const text = goalWithContext(goal, chips);
    if (!text) return;
    close();
    void useChains.getState().queue(text).then((ok) => ok && (useAgent.getState().setGoal(""), useUi.setState({ chips: [] })));
  };
  const submit = () => {
    if (palette?.length) return command(palette[Math.min(sel, palette.length - 1)]!);
    if (at && fileList.length) return pickFile(fileList[Math.min(sel, fileList.length - 1)]!.label);
    const slash = parseSlash(goal, entries);
    if (slash) return command(slash.entry, slash.rest);
    const idea = planThis(goal);
    if (idea) return void (close(), useAgent.getState().setGoal(""), useQuests.getState().plan(idea)); // QB1: "Plan this: …" becomes a quest (it queues itself while the agent works)
    if (busy || chainLive || useChains.getState().askWhen.on !== "finished") return queue(); // P1/P2: a chosen "when" holds for Enter too
    const text = goal.trim() || hint || "";
    if (!text && !chips.length) return;
    close();
    ask(text || "Look at this and tell me what's going on.");
    useAgent.getState().setGoal(""); // said: it now lives in the conversation
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey && !list?.length) return void (e.preventDefault(), queue());
    if (e.key === "Enter" && !e.shiftKey) return void (e.preventDefault(), submit());
    if (e.key === "Escape" && !list?.length) return void (e.preventDefault(), e.stopPropagation(), close()); // Esc lets go of the composer before anything else
    if (!list?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => (i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (palette) useAgent.getState().setGoal(`/${palette[sel]!.id} `);
      else pickFile(fileList[sel]!.label);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      useAgent.getState().setGoal(palette ? "" : dropAt(goal, at!.start, caret));
    }
  };

  const none = brains.length > 0 && !brains.some((b) => b.available);
  const who = brain === "claude-code" ? "Claude" : "your agent";
  const tray = open || !!goal.trim() || chips.length > 0;
  const writing = open || !!goal; // text gets its own full-width row; controls sit underneath

  return (
    <form
      role={open ? "dialog" : "form"}
      aria-label="Ask your agent"
      className="composer @container relative z-40 mt-2 mr-[46px] shrink-0"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button, select, input, textarea, a, [role=option]")) return;
        e.preventDefault(); // clicks on the bar keep the caret
        ref.current?.focus();
      }}
      {...drop.props}
    >
      <div className="absolute inset-x-0 bottom-full mb-2 flex flex-col gap-2">
        {talk && <Conversation onClose={() => setTalk(false)} />}
        {tray && (open || list || chips.length > 0) && (
          // One solid card the composer's width: nothing on the stage peeks out beside a narrower list or chip.
          <div className="glass solid rise flex flex-col gap-2 rounded-[var(--r-card)] p-2">
            {list && (
              <ul id="slash-list" role="listbox" aria-label={palette ? "Commands" : "Files"} className="overflow-hidden">
                {list.length === 0 && <li className="px-4 py-2 text-[12.5px] text-dim">{palette ? "No command starts with that." : "No file matches that."}</li>}
                {palette?.map((c, i) => (
                  <li
                    key={c.id}
                    id={`slash-${c.id}`}
                    role="option"
                    aria-selected={i === sel}
                    onMouseEnter={() => setSel(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      command(c);
                    }}
                    className={cx("flex cursor-pointer items-baseline gap-3 px-4 py-[7px]", i === sel && "bg-violet/10")}
                  >
                    <span className={cx("min-w-[76px] shrink-0 font-mono text-[12px]", i === sel ? "text-violet" : "text-ink")}>/{c.id}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">{c.hint}</span>
                    {c.kind !== "builtin" && <span className="micro shrink-0 text-[9px] text-faint">{c.kind === "skill" ? "skill" : "saved"}</span>}
                  </li>
                ))}
                {!palette &&
                  fileList.map((f, i) => (
                    <li
                      key={f.label}
                      id={`file-${i}`}
                      role="option"
                      aria-selected={i === sel}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickFile(f.label);
                      }}
                      className={cx("flex cursor-pointer items-center gap-2.5 px-4 py-[7px]", i === sel && "bg-violet/10")}
                    >
                      <FileText size={12} className={i === sel ? "text-violet" : "text-dim"} aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{f.label}</span>
                    </li>
                  ))}
                <li className="micro px-4 pt-1.5 pb-1 text-[9.5px] text-faint" aria-hidden>
                  ↑ ↓ choose · Enter {palette ? "run" : "add"} · Esc close
                </li>
              </ul>
            )}
            {chips.length > 0 && (
              <div className="mx-auto flex w-[min(720px,100%)] flex-wrap justify-center gap-1.5" aria-label="Context for the agent">
                {chips.map((c) => (
                  <ContextChip key={c.id} chip={c} />
                ))}
              </div>
            )}
            {open && !list && (
              <div className="mx-auto flex max-w-full flex-col items-center">
                <AskChainRow goal={goal} busy={busy || chainLive} onQueue={queue} />
                <span className="mt-2 @2xl:hidden">
                  <ShowOptionsToggle />
                </span>
                <AskOptions auto={planFirstDefault(goal, chips)} optionsToggle={false} onSaveCommand={goal.trim() && !goal.startsWith("/") ? () => void saveAsCommand(goal) : undefined} />
              </div>
            )}
            {full && open && !list && (
              <p className="flex items-center justify-center gap-2 text-[12px] text-slow">
                Your agent's memory is almost full.
                <button type="button" className="btn h-6 px-2 text-[11.5px]" onClick={() => (close(), void tidyUp())}>
                  Tidy up the agent's memory
                </button>
              </p>
            )}
          </div>
        )}
        {drop.over && <p className="text-center text-[12px] text-violet">Drop to add it as context</p>}
        {none && open && <p className="text-center text-[12.5px] text-dim">No agent is set up. Install Claude Code, or set ANTHROPIC_API_KEY.</p>}
      </div>

      <div
        className={cx("composer-bar flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-[var(--r-card)] border py-2 pr-2 pl-2.5 transition-[border-color,box-shadow] duration-150", open && "is-on")}
        style={drop.over ? { borderColor: "var(--violet)" } : undefined}
      >
        <Where />
        <span className="self-center text-violet" aria-hidden>
          ✦
        </span>
        <textarea
          ref={ref}
          rows={1}
          value={goal}
          onChange={(e) => (useAgent.getState().setGoal(e.target.value), setCaret(e.target.selectionStart))}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          onFocus={() => !useAgent.getState().open && useAgent.getState().setOpen(true)}
          onBlur={(e) => !e.currentTarget.form?.contains(e.relatedTarget as Node | null) && close()}
          placeholder={hint ?? `Ask ${who} about your app`}
          aria-label="Ask your agent"
          aria-autocomplete="list"
          aria-controls={list ? "slash-list" : undefined}
          aria-activedescendant={list?.length ? (palette ? `slash-${palette[sel]?.id}` : `file-${sel}`) : undefined}
          spellCheck={false}
          className={cx("composer-input min-w-[120px] flex-1 resize-none bg-transparent py-[3px] font-display text-[14px] leading-[22px] font-medium text-ink outline-none placeholder:text-dim", writing ? "order-first basis-full px-1.5" : "basis-0")}
        />
        {/* One group: short of room it wraps to its own row together, never Enter alone. */}
        <span className="ml-auto flex shrink-0 items-center gap-x-2.5">
          {brains.filter((b) => b.available).length > 1 && (
            <select
              value={brain ?? ""}
              onChange={(e) => useAgent.getState().setBrain(e.target.value as NonNullable<typeof brain>)}
              aria-label="Which agent to use"
              className="lbl cursor-pointer self-center bg-transparent outline-none hover:text-ink"
            >
              {brains.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available}>
                  {b.label}
                </option>
              ))}
            </select>
          )}
          {upNext > 0 && (
            <span className="self-center px-1 text-[12px] text-violet" title="Prompts waiting to run after this one">
              Up next · {upNext}
            </span>
          )}
          <span className="hidden self-center @2xl:inline">
            <ShowOptionsToggle />
          </span>
          <button
            type="button"
            aria-pressed={talk}
            aria-label={`Conversation, ${turnCount} ${turnCount === 1 ? "message" : "messages"}`}
            title="What you and your agent said in this worktree (type / for commands, @ for files)"
            onClick={() => setTalk((v) => !v)}
            className={cx("btn h-7 self-center border-transparent px-2 text-dim hover:text-ink", talk && "on")}
          >
            <MessagesSquare size={12} aria-hidden />
            {turnCount > 0 && turnCount}
            <ChevronUp size={11} className={cx("transition-transform", talk && "rotate-180")} aria-hidden />
          </button>
          {busy && !list ? (
            <span className="flex h-7 items-center gap-1.5 self-center px-1 text-[12px] text-dim">
              <Activity on label="Working" />
            </span>
          ) : (
            <button type="submit" aria-label="Send (Enter)" title="Send (Enter)" className="btn go h-7 w-7 justify-center self-center px-0" disabled={!brain && !palette}>
              <CornerDownLeft size={13} aria-hidden />
            </button>
          )}
        </span>
      </div>
    </form>
  );
}
