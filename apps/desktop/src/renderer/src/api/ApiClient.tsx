import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, Globe, PanelLeft, Plus, X } from "lucide-react";
import { MethodTag, cx } from "../components/ui.tsx";
import { useUi } from "../stores/ui.ts";
import { useAgent } from "../stores/agent.ts";
import { api } from "../lib/api.ts";
import { fromCapture } from "./model.ts";
import { colFor, isDirty, useApi } from "./store.ts";
import { Tree } from "./Tree.tsx";
import { RequestTabs, UrlBar } from "./RequestPane.tsx";
import { EmptyResponse, ResponsePane } from "./ResponsePane.tsx";
import { CodeDialog, EnvDialog, ImportDialog } from "./Dialogs.tsx";
import { RoutesPage } from "./RoutesPage.tsx";
import "./api.css";
import { keys } from "../lib/platform.ts";

// AP: the API client. Bruno's layout (tree | tabs, URL bar, request | response) in Shrike's glass.
// Under 980px wide the tree floats over (closed until asked); under 700px the response sits under the request.

function EnvPicker() {
  const col = useApi((s) => colFor(s));
  const cur = useApi((s) => (col ? (s.envByCol[col.id] ?? null) : null));
  const [open, setOpen] = useState(false);
  const pick = (name: string | null) => {
    if (col) void useApi.getState().setEnv(col.id, name);
    setOpen(false);
  };
  return (
    <div className="relative shrink-0">
      <button type="button" className={cx("hud-btn ap-envbtn", !cur && "none")} aria-haspopup="menu" title={`Environment${col ? ` of ${col.name}` : ""} (${keys("⌘E")})`} onClick={() => setOpen(!open)}>
        <Globe size={11} aria-hidden />
        <span className="truncate">{cur ?? "No environment"}</span>
      </button>
      {open && (
        <div role="menu" className="ap-menu right glass solid" onMouseLeave={() => setOpen(false)}>
          <button role="menuitemradio" aria-checked={!cur} type="button" onClick={() => pick(null)}>
            No environment
          </button>
          {col?.environments.map((e) => (
            <button key={e} role="menuitemradio" aria-checked={e === cur} type="button" onClick={() => pick(e)}>
              {e}
            </button>
          ))}
          <hr />
          <button role="menuitem" type="button" onClick={() => (useApi.setState({ dialog: "env" }), setOpen(false))}>
            Configure…
          </button>
        </div>
      )}
    </div>
  );
}

function TabStrip({ onTree, treeOpen }: { onTree(): void; treeOpen: boolean }) {
  const tabs = useApi((s) => s.tabs);
  const active = useApi((s) => s.active);
  const routes = useApi((s) => s.view === "routes");
  return (
    <div className="ap-tabs">
      {!routes && (
        <button type="button" className="ap-icon" aria-label={treeOpen ? "Hide collections" : "Show collections"} aria-pressed={treeOpen} title="Collections" onClick={onTree}>
          <PanelLeft size={13} />
        </button>
      )}
      <button type="button" className="hud-btn ap-routes-btn" aria-pressed={routes} title="Every route with its params, body and responses" onClick={() => useApi.setState({ view: routes ? "requests" : "routes" })}>
        <BookOpen size={11} aria-hidden /> Routes
      </button>
      <div role="tablist" aria-label="Open requests" className="ap-tablist">
        {tabs.map((t) => (
          <div key={t.id} className={cx("ap-tab", t.id === active && !routes && "on")} onAuxClick={(e) => e.button === 1 && useApi.getState().close(t.id)}>
            <button role="tab" type="button" aria-selected={t.id === active} className="ap-tab-main" title={t.draft.url} onClick={() => useApi.getState().focus(t.id)}>
              <MethodTag method={t.draft.method} className="w-auto! pr-1 text-[9px]!" />
              <span className="truncate">{t.draft.name.startsWith(`${t.draft.method} `) ? t.draft.name.slice(t.draft.method.length + 1) : t.draft.name}</span>
            </button>
            <button type="button" className={cx("ap-tab-x", isDirty(t) && "dirty")} aria-label={`Close ${t.draft.name}${isDirty(t) ? " (not saved)" : ""}`} onClick={() => useApi.getState().close(t.id)}>
              <i aria-hidden />
              <X size={10} />
            </button>
          </div>
        ))}
        <button type="button" className="ap-icon" aria-label={keys("New request (⌘B)")} title={keys("New request (⌘B)")} onClick={() => useApi.getState().newTab()}>
          <Plus size={13} />
        </button>
      </div>
      <EnvPicker />
    </div>
  );
}

let seenDraft = 0;

export function ApiClient({ docked }: { docked?: boolean }) {
  const active = useApi((s) => s.tabs.find((t) => t.id === s.active));
  const dialog = useApi((s) => s.dialog);
  const routes = useApi((s) => s.view === "routes");
  const draft = useUi((s) => s.explorerDraft);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(docked ? 600 : 1200);
  const [pinned, setTree] = useState<boolean | null>(null); // null: follow the width
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = w < 980;
  const tree = !routes && (pinned ?? !narrow);
  useEffect(() => setTree(null), [narrow]);

  useEffect(() => {
    if (!useApi.getState().tabs.length) useApi.getState().newTab(); // opening the client lands on a request, ready to type
  }, []);

  // QuickOpen and older callers still prefill through the ui store.
  useEffect(() => {
    if (!draft || draft.nonce <= seenDraft) return;
    seenDraft = draft.nonce;
    const req = fromCapture({ method: draft.method, url: draft.url, reqHeaders: draft.headers, reqBody: draft.body });
    useApi.getState().open(draft.name ? { ...req, name: draft.name } : req, draft.resendOf ? { resendOf: draft.resendOf } : {});
  }, [draft?.nonce]);

  // Shortcuts listen on the window while the last click or focus was in the client, so they keep working when the
  // focused field unmounts (a new tab, the floating tree closing). Capture phase: the first client to see a key owns it.
  const owns = useRef(true);
  useEffect(() => void (owns.current = true), [active?.id]); // a request just opened here (route click, resend, QuickOpen)
  useEffect(() => {
    const mark = (e: Event) => void (owns.current = !!box.current?.contains(e.target as Node));
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !owns.current || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "enter" && !box.current?.contains(document.activeElement) && useAgent.getState().approvals.length) return; // ⌘↵ applies the waiting approval
      const s = useApi.getState();
      const id = s.active;
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (s.view === "routes" && (k === "enter" || k === "s")) return; // the request behind the Routes page is out of sight
      if (k === "enter" && id) run(() => void s.send(id));
      else if (k === "s" && id) run(() => void s.save(id));
      else if (k === "b") run(() => s.newTab());
      else if (k === "e") run(() => useApi.setState({ dialog: "env" }));
      else if (k === "w" && id) run(() => s.close(id));
    };
    // main turns ⌘W into this event, so it closes a tab instead of the window (which would quit Shrike)
    const off = api()?.on?.("shortcut", (p) => {
      const id = useApi.getState().active;
      if (p === "close-tab" && owns.current && id) useApi.getState().close(id);
    });
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("focusin", mark, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      off?.();
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("focusin", mark, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return (
    <div ref={box} className={cx("ap", !docked && "over", narrow && "narrow", w < 700 && "stack")}>
      {tree && <Tree onPicked={() => narrow && setTree(false)} />}
      {tree && narrow && <button type="button" className="ap-tree-scrim" aria-label="Hide collections" onClick={() => setTree(false)} />}
      <div className="ap-main">
        <TabStrip treeOpen={tree} onTree={() => setTree(!tree)} />
        {routes ? (
          <RoutesPage />
        ) : active ? (
          <div className="ap-work" key={active.id}>
            <UrlBar tab={active} />
            <div className="ap-split">
              <RequestTabs tab={active} />
              <ResponsePane tabId={active.id} />
            </div>
          </div>
        ) : (
          <div className="ap-work">
            <EmptyResponse />
          </div>
        )}
      </div>
      {dialog === "env" && <EnvDialog />}
      {dialog === "import" && <ImportDialog />}
      {dialog === "code" && <CodeDialog />}
    </div>
  );
}
