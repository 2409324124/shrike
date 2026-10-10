import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, GitBranch, GitPullRequest, Sparkles, X } from "lucide-react";
import type { BrainId, CreateWorkspace, WorkspaceFrom, WorkspaceSources } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { cx, IconButton, Kbd, Spinner, Tabs } from "../components/ui.tsx";
import { Dot } from "../components/Activity.tsx";
import { useAgent } from "../stores/agent.ts";
import { useProject } from "../stores/project.ts";
import { parseSmart, slugName } from "./logic.ts";
import { useWorkspaces } from "./store.ts";

// WS2: New workspace. One box that understands what you paste, or pick a PR, a branch or a name.

type Tab = "smart" | "pr" | "branch" | "name";
const TABS: { id: Tab; label: string }[] = [
  { id: "smart", label: "Smart" },
  { id: "pr", label: "From PR" },
  { id: "branch", label: "From branch" },
  { id: "name", label: "New name" },
];
const ADD = "\u0000add";

export function CreateWorkspaceDialog() {
  const open = useWorkspaces((s) => s.dialog);
  return open ? <Dialog /> : null;
}

function Dialog() {
  const list = useWorkspaces((s) => s.list);
  const progress = useWorkspaces((s) => s.progress);
  const brains = useAgent((s) => s.brains);
  const brainNow = useAgent((s) => s.brain);
  const here = useProject((s) => s.project?.root);
  const projects = useMemo(() => [...new Map(list.map((w) => [w.projectRoot, w.project])).entries()], [list]);
  const [project, setProject] = useState(() => list.find((w) => w.current)?.projectRoot ?? projects[0]?.[0] ?? here ?? "");
  const [src, setSrc] = useState<WorkspaceSources | null>(null);
  const [srcError, setSrcError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("smart");
  const [text, setText] = useState("");
  const [pick, setPick] = useState<{ pr?: number; branch?: string }>({});
  const [query, setQuery] = useState("");
  const [brain, setBrain] = useState<BrainId | "">(brainNow ?? "");
  const [prompt, setPrompt] = useState("");
  const [base, setBase] = useState("");
  const [offset, setOffset] = useState("");
  const [runSkill, setRunSkill] = useState(true);
  const [copyEnv, setCopyEnv] = useState(true);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => !busy && useWorkspaces.getState().setDialog(false);

  useEffect(() => {
    if (!project) return;
    setSrc(null);
    setSrcError(null);
    let live = true;
    void Promise.resolve()
      .then(() => api().workspaceSources(project))
      .then((s) => live && setSrc(s), (e: Error) => live && setSrcError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    return () => void (live = false);
  }, [project]);

  const smart = tab === "smart" ? parseSmart(text, src?.branches.map((b) => b.name)) : null;
  const from: WorkspaceFrom | null =
    tab === "smart" ? (smart ? { kind: "smart", text } : null) : tab === "pr" ? (pick.pr ? { kind: "pr", number: pick.pr } : null) : tab === "branch" ? (pick.branch ? { kind: "branch", branch: pick.branch } : null) : slugName(text) ? { kind: "name", name: text } : null;
  const name = !from ? "" : from.kind === "pr" ? `pr-${from.number}` : from.kind === "branch" ? slugName(from.branch.replace(/^origin\//, "")) : smart ? (smart.kind === "pr" ? `pr-${smart.number}` : smart.kind === "branch" ? slugName(smart.branch.replace(/^origin\//, "")) : smart.name) : slugName(text);
  const fresh = !from || (tab === "smart" ? smart?.kind === "name" : tab === "name"); // only a new name can pick a base
  const off = offset.trim() ? Number(offset) : undefined;
  const offBad = off !== undefined && (!Number.isInteger(off) || off < 100 || off % 100 !== 0);

  const submit = async () => {
    if (!from || busy || offBad || !project) return;
    setBusy(true);
    const opts: CreateWorkspace = { project, from, copyEnv, ...(fresh && base ? { base } : {}), ...(off !== undefined ? { portOffset: off } : {}) };
    const w = await useWorkspaces.getState().create(opts, { open: !more, runSkill, brain: brain || null, prompt });
    setBusy(false);
    if (w && more) (setText(""), setPick({}), setPrompt(""));
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // the Thread's keys stay out of the dialog
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void submit());
  };

  const q = query.trim().toLowerCase();
  const prs = (src?.prs ?? []).filter((p) => !q || `#${p.number} ${p.title} ${p.branch} ${p.author ?? ""}`.toLowerCase().includes(q));
  const branches = (src?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 60);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_srgb,var(--void)_60%,transparent)] p-6" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={onKey}>
      <section role="dialog" aria-modal="true" aria-label="New workspace" className="glass solid rise flex max-h-full w-[min(620px,100%)] flex-col overflow-hidden rounded-[var(--r-card)] shadow-[0_24px_80px_var(--void)]">
        <header className="flex items-start gap-3 border-b border-hair px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 font-display text-[18px] font-light tracking-[0.04em] text-ink uppercase">New workspace</h2>
            <p className="m-0 mt-1 text-[12.5px] text-dim">A separate copy of your code to try things in, with its own app, agent and up next. Your main checkout isn't touched.</p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="lbl">Project</span>
            <select
              className="field"
              value={project}
              onChange={async (e) => {
                if (e.target.value !== ADD) return setProject(e.target.value);
                const root = await api().addWorkspaceProject().catch(() => null);
                if (root) (await useWorkspaces.getState().refresh(), setProject(root));
              }}
            >
              {projects.map(([root, n]) => (
                <option key={root} value={root} title={root}>
                  {n}
                </option>
              ))}
              <option value={ADD}>Add a folder…</option>
            </select>
            <span className="truncate font-mono text-[10.5px] text-faint" title={src?.location}>
              Goes in {src ? `${projects.find(([r]) => r === project)?.[1] ?? ""}/.shrike/worktrees/${name || "…"}` : "…"}
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="lbl">Start from</span>
            <Tabs label="Start from" tabs={TABS} value={tab} onChange={(t) => (setTab(t), setQuery(""))} />
            {(tab === "smart" || tab === "name") && (
              <input
                autoFocus
                aria-label={tab === "smart" ? "Name, PR number, branch or link" : "Workspace name"}
                className="field h-9 text-[13px]"
                placeholder={tab === "smart" ? "A name, #1234, a branch, or a GitHub or Jira link" : "fix-login"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
            {tab === "smart" && (
              <p className="m-0 flex min-h-[18px] items-center gap-1.5 text-[12px]" aria-live="polite">
                {smart ? (
                  <>
                    {smart.kind === "pr" ? <GitPullRequest size={12} className="text-signal" /> : smart.kind === "branch" ? <GitBranch size={12} className="text-signal" /> : <Sparkles size={12} className="text-violet" />}
                    <span className="text-ink">{smart.say}</span>
                    {smart.kind === "pr" && src?.prs.find((p) => p.number === smart.number) && <span className="truncate text-dim">· {src.prs.find((p) => p.number === smart.number)!.title}</span>}
                  </>
                ) : (
                  <span className="text-faint">Shrike works out what you meant as you type.</span>
                )}
              </p>
            )}
            {(tab === "pr" || tab === "branch") && (
              <>
                <input autoFocus aria-label={tab === "pr" ? "Search pull requests" : "Search branches"} className="field" placeholder={tab === "pr" ? "Search by number, title or author" : "Search branches"} value={query} onChange={(e) => setQuery(e.target.value)} />
                <ul role="listbox" aria-label={tab === "pr" ? "Open pull requests" : "Branches"} className="m-0 flex max-h-[180px] list-none flex-col gap-0.5 overflow-y-auto rounded-[8px] border border-hair p-1">
                  {!src && !srcError && (
                    <li className="flex items-center gap-2 p-2 text-[12px] text-dim">
                      <Spinner size={10} /> Looking…
                    </li>
                  )}
                  {srcError && <li className="p-2 text-[12px] text-fail">{srcError}</li>}
                  {tab === "pr" && src?.prsError && <li className="p-2 text-[12px] text-dim">{src.prsError}</li>}
                  {tab === "pr" && src && !src.prsError && !prs.length && <li className="p-2 text-[12px] text-dim">No open pull requests{q ? " match" : ""}.</li>}
                  {tab === "pr" &&
                    prs.map((p) => (
                      <li key={p.number} role="option" aria-selected={pick.pr === p.number}>
                        <button type="button" onClick={() => setPick({ pr: p.number })} className={cx("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", pick.pr === p.number ? "bg-glass text-ink" : "text-dim hover:text-ink")}>
                          <GitPullRequest size={12} className={p.draft ? "text-faint" : "text-signal"} />
                          <span className="font-mono text-[11px] text-signal">#{p.number}</span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.title}</span>
                          {p.draft && <span className="micro text-[9px] text-faint">Draft</span>}
                          <span className="max-w-[120px] truncate font-mono text-[10px] text-faint">{p.author ?? p.branch}</span>
                        </button>
                      </li>
                    ))}
                  {tab === "branch" && src && !branches.length && <li className="p-2 text-[12px] text-dim">No branches{q ? " match" : ""}.</li>}
                  {tab === "branch" &&
                    branches.map((b) => (
                      <li key={b.name} role="option" aria-selected={pick.branch === b.name}>
                        <button type="button" onClick={() => setPick({ branch: b.name })} className={cx("flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left", pick.branch === b.name ? "bg-glass text-ink" : "text-dim hover:text-ink")}>
                          <GitBranch size={12} className="text-signal" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{b.name}</span>
                          {b.name === src?.current && <span className="micro text-[9px] text-faint">Your main checkout</span>}
                          {b.remote && <span className="micro text-[9px] text-faint">Only on the remote</span>}
                        </button>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="lbl">Agent</span>
              <select className="field" value={brain} onChange={(e) => setBrain(e.target.value as BrainId)}>
                {brains.filter((b) => b.available).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
                {!brains.some((b) => b.available) && <option value="">No agent installed</option>}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="lbl">First prompt (optional)</span>
              <input className="field" placeholder="What should your agent do once it's ready?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
          </div>

          <details className="rounded-[8px] border border-hair px-3 py-2">
            <summary className="lbl cursor-pointer select-none">Advanced</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="lbl text-faint">Base branch</span>
                <select className="field" value={base} disabled={!fresh} onChange={(e) => setBase(e.target.value)} title={fresh ? undefined : "A PR or branch starts from its own code."}>
                  <option value="">Your code as it is now</option>
                  {(src?.branches ?? []).map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="lbl text-faint">Port offset</span>
                <input className={cx("field", offBad && "border-fail")} inputMode="numeric" placeholder="Auto (+100, +200…)" value={offset} onChange={(e) => setOffset(e.target.value.replace(/[^\d]/g, ""))} aria-invalid={offBad} />
                {offBad && <span className="text-[11px] text-fail">Use a multiple of 100, like 300.</span>}
              </label>
              <Check2 checked={runSkill} onChange={setRunSkill} label="Run the app with its run skill after it's made" />
              <Check2 checked={copyEnv} onChange={setCopyEnv} label="Copy your .env files into it" />
            </div>
          </details>

          {progress.length > 0 && (
            <ol aria-label="Progress" className="m-0 flex list-none flex-col gap-1 rounded-[8px] border border-hair p-2.5">
              {progress.map((p, i) => (
                <li key={i} className={cx("flex items-center gap-2 text-[12.5px]", p.state === "failed" ? "text-fail" : p.state === "done" ? "text-ink" : "text-dim")}>
                  {p.state === "running" ? <Dot on tone="var(--signal)" /> : p.state === "done" ? <Check size={12} className="text-ok" /> : <X size={12} />}
                  {p.step}
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-hair px-5 py-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-dim" title="Keep this open to make another one. New ones wait in the rail.">
            <input type="checkbox" className="accent-[var(--signal)]" checked={more} onChange={(e) => setMore(e.target.checked)} />
            Create more
          </label>
          <div className="flex-1" />
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn go" disabled={!from || busy || offBad || !project} onClick={() => void submit()}>
            {busy && <Spinner size={10} />}
            Create workspace <Kbd className="ml-0.5 border-current/40 text-current">⌘↵</Kbd>
          </button>
        </footer>
      </section>
    </div>
  );
}

function Check2({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="col-span-2 flex cursor-pointer items-center gap-2 text-[12.5px] text-ink">
      <input type="checkbox" className="accent-[var(--signal)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
