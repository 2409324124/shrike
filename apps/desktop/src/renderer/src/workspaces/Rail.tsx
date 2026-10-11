import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Copy, Ellipsis, FolderOpen, FolderPlus, GitBranch, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Square, SquareTerminal, Trash2 } from "lucide-react";
import type { Workspace } from "@shrike/schema";
import { cx, IconButton, Kbd, Spinner } from "../components/ui.tsx";
import { Dot, Elapsed } from "../components/Activity.tsx";
import { toast } from "../stores/ui.ts";
import { useProject } from "../stores/project.ts";
import { connectWorktrees, useWorktrees } from "../stores/worktrees.ts";
import { call } from "../lib/api.ts";
import { isMac } from "../lib/platform.ts";
import { grouped } from "./logic.ts";
import { connectWorkspaces, useWorkspaces } from "./store.ts";

// WS1: the workspaces rail. Needs you and Working first (only when there are any), then each project and its worktrees.

const AGENT: Record<Workspace["agent"], { color?: string; word: string; short?: string; busy?: boolean }> = {
  working: { color: "var(--violet)", word: "Your agent is working", short: "Agent working", busy: true },
  waiting: { color: "var(--slow)", word: "Your agent needs you", short: "Agent needs you", busy: true },
  done: { color: "var(--ok)", word: "Your agent is done", short: "Agent done" },
  idle: { word: "No agent running" },
};

export const RAIL_GAIN = 244 - 46; // what opening the rail takes from the stage: w-[244px] less its w-[46px] icons
export const title = (w: Workspace) => w.label ?? (w.kind === "main" ? w.branch || w.project : w.name);
const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;
const folder = (root: string) => {
  const p = root.replace(/\\/g, "/").replace(/^(\/private|[A-Za-z]:)?\/(Users|home)\/[^/]+/i, "~").replace(/\/[^/]+\/?$/, "");
  return p.startsWith("~") ? p : p.split("/").pop() || "/";
};
const initials = (s: string) => {
  const words = s.replace(/^shrike\//, "").split(/[^a-z0-9]+/i).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
};

/** The row's one quiet line: at most two plain facts, most important first. */
function facts(w: Workspace): { text: string; color?: string }[] {
  const out: { text: string; color?: string }[] = [];
  const a = AGENT[w.agent];
  if (a.short) out.push({ text: a.short, color: a.color });
  if (w.running) out.push({ text: w.port ? `Running on :${w.port}` : "Running", color: "var(--ok)" });
  if (w.changes) out.push({ text: count(w.changes, "change") });
  if (w.pr) out.push({ text: `PR #${w.pr.number} ${w.pr.draft ? "draft" : w.pr.state}`, color: w.pr.state === "open" && !w.pr.draft ? "var(--signal)" : undefined });
  if (w.ahead) out.push({ text: `${w.ahead} to push` });
  if (w.behind) out.push({ text: `${w.behind} to pull` });
  if (out.length === 1 && w.changes && out[0]!.text === count(w.changes, "change")) out[0] = { text: `${out[0]!.text} not committed` };
  if (!out.length) out.push({ text: w.branch && w.branch !== title(w) ? `on ${w.branch}` : w.kind === "main" ? "Main checkout" : "No changes" });
  return out.slice(0, 2);
}

function useRailKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "b") (e.preventDefault(), useWorkspaces.getState().toggle());
      else if (k === "n") (e.preventDefault(), useWorkspaces.getState().setDialog(true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** squeezed: the window is too narrow for the stage and the open rail (Shell), so it shows as icons whatever you chose. */
export function WorkspacesRail({ squeezed = false }: { squeezed?: boolean }) {
  const list = useWorkspaces((s) => s.list);
  const chosen = useWorkspaces((s) => s.collapsed);
  const collapsed = chosen || squeezed;
  const root = useProject((s) => s.project?.root);
  const races = useWorktrees((s) => s.races);
  const raceOpen = useWorktrees((s) => !!s.open);
  const [menu, setMenu] = useState<{ w: Workspace; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [folded, setFolded] = useState<string[]>([]);
  useRailKeys();
  useEffect(() => connectWorkspaces(), []);
  useEffect(() => connectWorktrees(), []); // W3/W4 race updates
  useEffect(() => void (useWorkspaces.getState().refresh(), useWorktrees.getState().refresh()), [root]);
  const last = Object.values(races).at(-1);
  const urgent = grouped(list).filter((g) => g.id === "needs-you" || g.id === "working");
  const calm = list.filter((w) => w.group !== "needs-you" && w.group !== "working");
  const projects = [...new Set(calm.map((w) => w.projectRoot))].map((r) => ({ root: r, items: calm.filter((w) => w.projectRoot === r) }));
  const rows = (items: Workspace[], showProject = false) =>
    items.map((w) =>
      collapsed ? (
        <Tile key={w.path} w={w} onMenu={(x, y) => setMenu({ w, x, y })} />
      ) : (
        <Row key={w.path} w={w} showProject={showProject} renaming={renaming === w.path} onRenamed={() => setRenaming(null)} onMenu={(x, y) => setMenu({ w, x, y })} />
      ),
    );
  const section = cx(collapsed ? "flex flex-col items-center gap-2 border-hair not-first:mt-2 not-first:border-t not-first:pt-2" : "not-first:mt-3");

  return (
    <nav
      aria-label="Workspaces"
      className={cx("glass mr-3 flex shrink-0 flex-col overflow-hidden rounded-[var(--r-pane)] transition-[width] duration-200", collapsed ? "w-[46px]" : "w-[244px]")}
    >
      <div className={cx("flex h-9 shrink-0 items-center gap-1 border-b border-hair", collapsed ? "justify-center" : "pr-1.5 pl-3")}>
        {!collapsed && (
          <>
            <span className="lbl flex-1 text-ink">Workspaces</span>
            <IconButton label="New workspace (⌘N)" onClick={() => useWorkspaces.getState().setDialog(true)}>
              <Plus size={13} />
            </IconButton>
          </>
        )}
        <IconButton
          label={squeezed ? "Widen the window to show workspaces" : collapsed ? "Show workspaces (⌘B)" : "Hide workspaces (⌘B)"}
          aria-disabled={squeezed || undefined}
          className={cx(squeezed && "opacity-40")}
          onClick={() => !squeezed && useWorkspaces.getState().toggle()}
        >
          {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
        </IconButton>
      </div>
      <div className={cx("min-h-0 flex-1 overflow-x-hidden overflow-y-auto", collapsed ? "px-1.5 py-2" : "p-2")}>
        {urgent.map((g) => (
          <section key={g.id} aria-label={g.word} className={section}>
            {!collapsed && (
              <h3 className="micro m-0 flex h-7 items-center gap-2 px-2" style={{ color: g.id === "needs-you" ? "var(--slow)" : "var(--violet)" }}>
                {g.word}
                <span className="text-faint">{g.items.length}</span>
              </h3>
            )}
            {rows(g.items, true)}
          </section>
        ))}
        {projects.map((p) => {
          const shut = !collapsed && folded.includes(p.root);
          const name = p.items[0]!.project;
          return (
            <section key={p.root} aria-label={name} className={section}>
              {!collapsed && (
                <h3 className="m-0">
                  <button
                    type="button"
                    aria-expanded={!shut}
                    title={p.root}
                    onClick={() => setFolded((f) => (shut ? f.filter((r) => r !== p.root) : [...f, p.root]))}
                    className="no-drag group/p flex h-7 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left"
                  >
                    <ChevronDown size={12} className={cx("shrink-0 text-faint transition-transform group-hover/p:text-dim", shut && "-rotate-90")} />
                    <span className="shrink-0 text-[12px] font-medium text-dim group-hover/p:text-ink">{name}</span>
                    <span className="min-w-0 truncate text-[11px] text-faint">{folder(p.root)}</span>
                    {shut && <span className="ml-auto text-[11px] text-faint">{p.items.length}</span>}
                  </button>
                </h3>
              )}
              {!shut && rows(p.items)}
            </section>
          );
        })}
        {!collapsed && list.length === 1 && (
          <p className="m-0 mt-3 px-2 text-[12px] leading-[1.5] text-faint">
            Want to try something without touching this code? <button type="button" className="text-signal underline-offset-2 hover:underline" onClick={() => useWorkspaces.getState().setDialog(true)}>Make a workspace</button> (<Kbd>⌘N</Kbd>). It gets its own copy, ports and agent.
          </p>
        )}
      </div>
      {!collapsed && (
        <div className="flex shrink-0 items-center gap-1 border-t border-hair px-1.5 py-1.5">
          <button type="button" className="hud-btn" onClick={() => void addProject()}>
            <FolderPlus size={12} />
            Add a project
          </button>
          <div className="flex-1" />
          {last && !raceOpen && (
            <button type="button" className="hud-btn" title="Show the last fix race again" onClick={() => useWorktrees.setState({ open: last.id })}>
              {last.kind === "sandbox" ? "Sandbox" : "Race"}
            </button>
          )}
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} onRename={() => (setRenaming(menu.w.path), setMenu(null), chosen && useWorkspaces.getState().toggle())} />}
    </nav>
  );
}

async function addProject(): Promise<void> {
  const root = await call((a) => a.addWorkspaceProject(), "Couldn't add that folder");
  if (root) await useWorkspaces.getState().refresh();
}

function rowTitle(w: Workspace): string {
  const parts = [w.path, `on ${w.branch || "no branch"}`, AGENT[w.agent].word, w.running ? `app running${w.port ? ` on :${w.port}` : ""}` : "app not running"];
  if (w.pr) parts.push(`pull request #${w.pr.number} is ${w.pr.draft ? "a draft" : w.pr.state}`);
  if (w.ahead || w.behind) parts.push(`${w.ahead ?? 0} to push, ${w.behind ?? 0} to pull`);
  if (w.changes) parts.push(`${count(w.changes, "changed file")} not committed`);
  if (w.note) parts.push(w.note);
  return parts.join(" · ");
}

function BusyDot({ w }: { w: Workspace }) {
  const a = AGENT[w.agent];
  if (!a.busy) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
      {w.agent === "working" && <Elapsed />}
      <Dot on tone={a.color} />
    </span>
  );
}

function Row({ w, showProject, renaming, onRenamed, onMenu }: { w: Workspace; showProject: boolean; renaming: boolean; onRenamed(): void; onMenu(x: number, y: number): void }) {
  const opening = useWorkspaces((s) => s.opening === w.path);
  const a = AGENT[w.agent];
  const [text, setText] = useState(title(w));
  useEffect(() => void (renaming && setText(title(w))), [renaming]);
  const line = facts(w);

  return (
    <div
      className={cx("group relative rounded-[8px] transition-colors not-first:mt-0.5", w.current ? "bg-glass shadow-[inset_2px_0_0_var(--signal)]" : "hover:bg-glass/60")}
      onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
    >
      {renaming ? (
        <input
          autoFocus
          aria-label={`Rename ${title(w)}`}
          className="field m-1 w-[calc(100%-8px)]"
          value={text}
          maxLength={60}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void useWorkspaces.getState().rename(w.path, text).then(onRenamed);
            else if (e.key === "Escape") onRenamed();
          }}
          onBlur={onRenamed}
        />
      ) : (
        <button
          type="button"
          aria-current={w.current ? "page" : undefined}
          aria-label={`${title(w)} (${w.project}). ${a.word}${w.running ? ", app running" : ""}${w.pr ? `, pull request #${w.pr.number}` : ""}`}
          title={rowTitle(w)}
          disabled={opening}
          onClick={() => void useWorkspaces.getState().open(w.path)}
          className="no-drag flex w-full min-w-0 flex-col gap-1 py-1.5 pr-7 pl-2 text-left"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {opening ? <Spinner size={12} className="text-dim" /> : <GitBranch size={12} className={cx("shrink-0", w.current ? "text-signal" : "text-faint")} />}
            <span className={cx("min-w-0 truncate font-mono text-[12px]", w.current ? "text-ink" : "text-dim group-hover:text-ink")}>{title(w)}</span>
            <BusyDot w={w} />
          </span>
          <span className="flex w-full min-w-0 items-center gap-1.5 pl-5 text-[11px] leading-[14px] text-faint">
            <span className="min-w-0 truncate">
              {line.map((f, i) => (
                <span key={f.text}>
                  {i > 0 && " · "}
                  <span style={f.color ? { color: f.color } : undefined}>{f.text}</span>
                </span>
              ))}
            </span>
            {showProject && <span className="ml-auto max-w-[72px] shrink-0 truncate">{w.project}</span>}
          </span>
        </button>
      )}
      {!renaming && (
        <IconButton
          label={`More for ${title(w)}`}
          className="absolute top-1/2 right-1 size-6 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-glass"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(r.right, r.bottom);
          }}
        >
          <Ellipsis size={13} />
        </IconButton>
      )}
    </div>
  );
}

/** Collapsed: one tile per workspace with its initials; the agent dot only while it works or waits. */
function Tile({ w, onMenu }: { w: Workspace; onMenu(x: number, y: number): void }) {
  const a = AGENT[w.agent];
  return (
    <button
      type="button"
      aria-label={`${title(w)} (${w.project})`}
      aria-current={w.current ? "page" : undefined}
      title={`${title(w)} · ${rowTitle(w)}`}
      onClick={() => void useWorkspaces.getState().open(w.path)}
      onContextMenu={(e) => (e.preventDefault(), onMenu(e.clientX, e.clientY))}
      className={cx(
        "no-drag relative grid size-8 place-items-center rounded-[8px] border text-[11px] font-medium tracking-[0.02em] transition-colors",
        w.current ? "border-signal bg-glass text-ink" : "border-hair text-dim hover:bg-glass hover:text-ink",
      )}
    >
      {initials(title(w))}
      {a.busy && (
        <span className="absolute -top-0.5 -right-0.5">
          <BusyDot w={w} />
        </span>
      )}
    </button>
  );
}

function Menu({ w, x, y, onClose, onRename }: { w: Workspace; x: number; y: number; onClose(): void; onRename(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc, true);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", esc, true));
  }, []);
  const s = useWorkspaces.getState();
  const item = (label: string, icon: ReactNode, fn: () => void, danger?: boolean) => (
    <button key={label} type="button" role="menuitem" className={cx("hud-btn w-full justify-start normal-case tracking-normal", danger && "text-fail")} onClick={() => (onClose(), fn())}>
      {icon}
      <span className="font-sans text-[12px]">{label}</span>
    </button>
  );
  return (
    <div ref={ref} role="menu" aria-label={`${title(w)} actions`} className="glass solid fixed z-50 flex w-[200px] flex-col gap-0.5 rounded-[var(--r-control)] p-1 shadow-[0_12px_40px_var(--void)]" style={{ left: Math.min(x, innerWidth - 210), top: Math.min(y, innerHeight - 240) }}>
      {item("Open folder", <FolderOpen size={12} />, () => void s.action(w.path, "folder"))}
      {isMac && item("Open in Terminal", <SquareTerminal size={12} />, () => void s.action(w.path, "terminal"))}
      {item("Copy path", <Copy size={12} />, () => void navigator.clipboard.writeText(w.path).then(() => toast("Path copied.", "ok"), () => toast("Couldn't copy the path.", "error")))}
      {item("Rename", <Pencil size={12} />, onRename)}
      {w.running && item("Stop its app", <Square size={11} />, () => void s.action(w.path, "stop"))}
      {w.kind !== "main" && !w.current && item("Delete workspace", <Trash2 size={12} />, () => void s.remove(w.path), true)}
      {w.current && w.kind !== "main" && <p className="m-0 px-2 py-1 text-[11px] text-faint">Switch to another workspace to delete this one.</p>}
      <p className="m-0 flex items-center gap-1 px-2 pt-1 pb-0.5 text-[10.5px] text-faint">
        <Kbd>⌘B</Kbd> hide · <Kbd>⌘N</Kbd> new
      </p>
    </div>
  );
}
