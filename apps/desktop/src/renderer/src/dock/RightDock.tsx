import { useEffect, useRef } from "react";
import { FileDiff, GitPullRequest, GraduationCap, PanelRightClose, Plug, Send } from "lucide-react";
import { useProject } from "../stores/project.ts";
import { cx, IconButton, Kbd } from "../components/ui.tsx";
import { PrPanel, usePr } from "../pr/index.ts";
import { ChangesPanel } from "../scm/Changes.tsx";
import { DiffView } from "../scm/Diff.tsx";
import { useScm, useScmBridge } from "../scm/store.ts";
import { useDock, type DockTab } from "./store.ts";
import { RepeatOffenders } from "../lessons/index.ts"; // review-lessons: RL7
import { ToolsPanel } from "../mcp/ToolsPanel.tsx"; // mcp: MCP1
import { useMcp } from "../mcp/store.ts";
import { ApiClient } from "../api/ApiClient.tsx"; // api: AP

// SC1: the right dock. Changes (scm/) and PR and checks (pr/, the PR lane's panel). Closed, it's a slim rail with counts.
// Narrow: only the open tab keeps its word, so the tabs never run under the close button.
// Open, it shrinks (weight 3 against the stage's 1) to min-w-[280px] before the stage gives way (Shell).
// z-[45]: .glass is its own stacking context, and the diff view (SC6) opens out of it over the stage and the composer.

const TABS: { id: DockTab; word: string; Icon: typeof FileDiff }[] = [
  { id: "changes", word: "Changes", Icon: FileDiff },
  { id: "pr", word: "PR and checks", Icon: GitPullRequest },
  { id: "lessons", word: "Lessons", Icon: GraduationCap }, // review-lessons: RL7
  { id: "tools", word: "Tools", Icon: Plug }, // mcp: MCP1
  { id: "api", word: "API", Icon: Send }, // api: AP
];
import { keys } from "../lib/platform.ts";

function useDockKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== "KeyG") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = useDock.getState();
      d.open && d.tab === "changes" ? d.toggle() : d.show("changes");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function RightDock() {
  useDockKeys();
  useScmBridge(true);
  const open = useDock((s) => s.open);
  const tab = useDock((s) => s.tab);
  const root = useProject((s) => s.project?.root);
  const unsaved = useScm((s) => (s.state ? new Set(s.state.files.filter((f) => f.area !== "branch").map((f) => f.path)).size : 0));
  const conflicts = useScm((s) => !!s.state?.files.some((f) => f.area === "conflicts"));
  const want = usePr((s) => s.want);
  const first = useRef(want);

  useEffect(() => void (root && useScm.getState().load()), [root]);
  // openPrPanel() from Ship, the rail or a toast: show the PR tab here instead of the fallback drawer.
  useEffect(() => {
    if (want === first.current) return;
    useDock.getState().show("pr");
    usePr.setState({ open: false });
  }, [want]);

  const broken = useMcp((s) => s.state?.servers.filter((x) => x.enabled && x.trusted && x.health?.state === "failed").length ?? 0); // mcp: MCP1
  const badge = (id: DockTab) => (id === "changes" && unsaved ? <span className={cx("dock-count", conflicts && "warn")}>{unsaved > 99 ? "99+" : unsaved}</span> : id === "tools" && broken ? <span className="dock-count warn" title={`${broken} not working`}>{broken}</span> : null);

  if (!open)
    return (
      <nav aria-label="Right dock" className="glass ml-3 flex w-[46px] shrink-0 flex-col items-center gap-1 rounded-[var(--r-pane)] py-2">
        {TABS.map(({ id, word, Icon }) => (
          <button key={id} type="button" className={cx("dock-rail-btn", tab === id && "on")} title={`${word}${id === "changes" ? ` (${keys("⌘⇧G")})` : ""}`} aria-label={word} onClick={() => useDock.getState().show(id)}>
            <Icon size={16} strokeWidth={1.75} aria-hidden />
            {badge(id)}
          </button>
        ))}
      </nav>
    );

  return (
    <aside aria-label="Right dock" className={cx("glass relative z-[45] ml-3 flex min-w-[280px] shrink-[3] flex-col rounded-[var(--r-pane)]", tab === "api" ? "w-[clamp(380px,36vw,640px)]" : "w-[clamp(320px,25vw,440px)]")}>
      <header className="@container flex h-9 shrink-0 items-center gap-0.5 border-b border-hair pr-1 pl-1.5">
        <div role="tablist" aria-label="Right dock" className="flex min-w-0 items-center gap-0.5">
          {TABS.map(({ id, word, Icon }) => (
            <button key={id} role="tab" type="button" aria-selected={tab === id} aria-pressed={tab === id} className={cx("hud-btn dock-tab", tab === id ? "min-w-0" : "shrink-0")} title={word} aria-label={word} onClick={() => useDock.getState().show(id)}>
              <Icon size={13} strokeWidth={1.75} aria-hidden className="shrink-0" />
              <span className={tab === id ? "min-w-0 truncate" : "hidden @[520px]:inline"}>{word}</span>
              {badge(id)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Kbd className="mr-1 @max-[579px]:hidden">⌘⇧G</Kbd>
        <IconButton label="Close the dock (⌘⇧G)" onClick={() => useDock.getState().toggle()}>
          <PanelRightClose size={13} />
        </IconButton>
      </header>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {tab === "changes" ? <ChangesPanel /> : tab === "lessons" ? <RepeatOffenders /> : tab === "tools" ? <ToolsPanel /> : tab === "api" ? <ApiClient docked /> : <PrPanel docked />}
      </div>
      {tab === "changes" && <DiffView />}
    </aside>
  );
}
