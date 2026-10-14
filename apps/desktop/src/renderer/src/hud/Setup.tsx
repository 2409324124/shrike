import { useState } from "react";
import { Database, Globe, Layers, Monitor, Play, Plus, Server, User, X, Zap, type LucideIcon } from "lucide-react";
import type { PlaceKind, ProcessSpec } from "@shrike/schema";
import { useProject } from "../stores/project.ts";
import { useRun } from "../stores/run.ts";
import { toast, useUi } from "../stores/ui.ts";
import { cx, IconButton } from "../components/ui.tsx";

// D12: what Shrike will start, and the places it expects to see. After opening a project, and from the gear.

export const PLACE_GLYPH: Record<PlaceKind, LucideIcon> = { caller: User, client: Monitor, service: Server, queue: Layers, cache: Zap, data: Database, outside: Globe };

function problem(list: ProcessSpec[]): string | null {
  if (!list.length) return "Add at least one process.";
  const names = new Set<string>();
  for (const p of list) {
    if (!/^[\w-]{1,32}$/.test(p.name)) return "Names are one word: letters, numbers, - or _.";
    if (names.has(p.name)) return `Two processes are called ${p.name}.`;
    names.add(p.name);
    if (!p.command.trim()) return `Give ${p.name} a command to run.`;
    if (p.url && !/^https?:\/\/\S+$/.test(p.url)) return `${p.name}'s address should start with http:// or https://.`;
  }
  return null;
}

const clean = (list: ProcessSpec[]): ProcessSpec[] =>
  list.map((p) => ({ name: p.name.trim(), command: p.command.trim(), ...(p.cwd?.trim() ? { cwd: p.cwd.trim() } : {}), ...(p.url?.trim() ? { url: p.url.trim() } : {}) }));

function Field({ value, onChange, label, placeholder, className }: { value: string; onChange(v: string): void; label: string; placeholder?: string; className?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={placeholder} spellCheck={false} title={value || undefined} className={cx("field min-w-0", className)} />;
}

export function Setup() {
  const open = useUi((s) => s.setup);
  const project = useProject((s) => s.project);
  const runState = useRun((s) => s.status.state);
  const [list, setList] = useState<ProcessSpec[]>([]);
  const [saving, setSaving] = useState(false);
  const [liveUrl, setLiveUrl] = useState("");
  // Filled while rendering, not in an effect, so the first frame already lists what the scanner found.
  const [from, setFrom] = useState<typeof project>(null);
  if (from !== (open ? project : null)) {
    setFrom(open ? project : null);
    if (open && project) setLiveUrl(project.liveUrl ?? "");
    if (open && project) setList(project.processes?.length ? project.processes.map((p) => ({ ...p })) : [{ name: "app", command: project.devCommand }]);
  }

  if (!open || !project) return null;
  const close = () => useUi.setState({ setup: false });
  const liveDirty = liveUrl.trim() !== (project.liveUrl ?? "");
  const liveOnly = !!liveUrl.trim() && list.every((p) => !p.command.trim()); // #54: a live site needs no command
  const err = (liveOnly ? null : problem(clean(list))) ?? (liveUrl.trim() && !/^https?:\/\/\S+$/.test(liveUrl.trim()) ? "The live URL should start with https:// or http://." : null);
  const procsDirty = !liveOnly && JSON.stringify(clean(list)) !== JSON.stringify(clean(project.processes ?? []));
  const dirty = procsDirty || liveDirty;
  const edit = (i: number, patch: Partial<ProcessSpec>) => setList((l) => l.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const save = async (): Promise<boolean> => {
    if (err) return false;
    if (!dirty) return true;
    setSaving(true);
    let ok = !procsDirty || (await useProject.getState().saveProcesses(clean(list)));
    if (ok && liveDirty) ok = await useProject.getState().saveLiveUrl(liveUrl.trim() || null);
    setSaving(false);
    if (ok) toast("Saved to .shrike/config.json", "ok");
    return ok;
  };
  const live = runState === "running" || runState === "starting";
  const places = project.expectedPlaces ?? [];

  return (
    <div className="absolute inset-0 z-40 bg-void/40" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-label={`Set up ${project.name}`} className="glass rise absolute top-12 left-1/2 flex max-h-[calc(100%-72px)] w-[min(720px,94%)] -translate-x-1/2 flex-col rounded-[var(--r-card)] shadow-[0_30px_80px_var(--void)]">
        <header className="flex items-center gap-3 py-3.5 pr-2 pl-5">
          <span className="lbl text-ink">Set up</span>
          <span className="font-display text-[15px] text-ink">{project.name}</span>
          <span className="flex-1" />
          <IconButton label="Close setup" onClick={close}>
            <X size={13} />
          </IconButton>
        </header>

        <div className="@container min-h-0 flex-1 overflow-auto px-5 pb-2">
          <h3 className="micro mb-1 text-faint">What Shrike starts</h3>
          <p className="mb-3 text-[12.5px] text-dim">Each process runs with Shrike's recorder and gets its own lane and terminal tab.</p>
          {project.notes?.map((n) => (
            <p key={n} role="note" className="mb-3 text-[12.5px] text-slow">
              {n}
            </p>
          ))}
          {/* Narrow stage: each process takes two rows, name and command over folder, address and remove. */}
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_24px] items-center gap-x-2 gap-y-1.5 @xl:grid-cols-[88px_minmax(0,1fr)_96px_minmax(0,1fr)_24px]">
            <span className="micro text-[9.5px] text-faint">Name</span>
            <span className="micro col-span-2 text-[9.5px] text-faint @xl:col-span-1">Command</span>
            <span className="micro text-[9.5px] text-faint">Folder</span>
            <span className="micro text-[9.5px] text-faint">Address</span>
            <span />
            {list.map((p, i) => (
              <div key={i} className="contents">
                <Field value={p.name} onChange={(name) => edit(i, { name })} label={`Name of process ${i + 1}`} placeholder="api" />
                <Field value={p.command} onChange={(command) => edit(i, { command })} label={`Command for ${p.name || `process ${i + 1}`}`} placeholder="npm run dev" className="col-span-2 @xl:col-span-1" />
                <Field value={p.cwd ?? ""} onChange={(cwd) => edit(i, { cwd })} label={`Folder for ${p.name || `process ${i + 1}`}`} placeholder="." className="mb-2 @xl:mb-0" />
                <Field value={p.url ?? ""} onChange={(url) => edit(i, { url })} label={`Address of ${p.name || `process ${i + 1}`}`} placeholder="http://localhost:3000" className="mb-2 @xl:mb-0" />
                <IconButton label={`Remove ${p.name || `process ${i + 1}`}`} onClick={() => setList((l) => l.filter((_, k) => k !== i))} disabled={list.length === 1} className="mb-2 @xl:mb-0">
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </div>
          <button type="button" className="hud-btn mt-2 -ml-2" onClick={() => setList((l) => [...l, { name: "", command: "" }])}>
            <Plus size={11} /> Add a process
          </button>

          <h3 className="micro mt-6 mb-1 text-faint">Live URL</h3>
          <p className="mb-2 text-[12.5px] text-dim">Where your app is deployed. With no command to run, Run opens this site.</p>
          <Field value={liveUrl} onChange={setLiveUrl} label="Live URL" placeholder="https://your-app.com" className="w-full" />

          <h3 className="micro mt-6 mb-2.5 text-faint">We think your app has</h3>
          {places.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Expected places">
              {places.map((pl) => {
                const G = PLACE_GLYPH[pl.kind] ?? Server;
                return (
                  <li key={pl.id} title={pl.detail} className="inline-flex items-center gap-1.5 rounded-[6px] border border-dashed border-hair-strong px-2 py-[5px] font-mono text-[10.5px] tracking-[0.12em] text-dim uppercase">
                    <G size={11} className={pl.kind === "data" || pl.kind === "cache" ? "text-signal" : pl.kind === "outside" ? "text-slow" : "text-ink"} aria-hidden />
                    {pl.name}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[12.5px] text-dim">Nothing guessed yet. Places show up as lanes the first time your code uses them.</p>
          )}
          {!project.appUrl && <p className="mt-4 text-[12.5px] text-dim">No web page found. Shrike records the requests you send from the API explorer or curl.</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-hair px-5 py-3">
          {err ? <span className="text-[12px] text-slow">{err}</span> : dirty ? <span className="text-[12px] text-faint">Not saved yet.</span> : null}
          <span className="flex-1" />
          <button type="button" className="btn" onClick={() => void save()} disabled={!!err || !dirty || saving}>
            Save
          </button>
          <button
            type="button"
            className="btn go"
            disabled={!!err || saving}
            onClick={async () => {
              if (!(await save())) return;
              close();
              if (live) await useRun.getState().restart();
              else await useRun.getState().start();
            }}
          >
            <Play size={9} className="fill-current" />
            {live ? "Restart all" : list.length > 1 ? "Run all" : "Run"}
          </button>
        </footer>
      </section>
    </div>
  );
}
