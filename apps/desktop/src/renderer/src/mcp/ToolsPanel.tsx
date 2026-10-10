import "./mcp.css";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus, RefreshCw, Trash2, Wrench, X } from "lucide-react";
import type { McpCatalogEntry, McpServerView, McpSource } from "@shrike/schema";
import { cssColor, mcp, mcpGlyph } from "@shrike/design";
import { cx, Spinner } from "../components/ui.tsx";
import { Elapsed } from "../components/Activity.tsx";
import { useAgent } from "../stores/agent.ts";
import { useUi } from "../stores/ui.ts";
import { SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { useSystem } from "../system/store.ts";
import { useMcp, useMcpBridge } from "./store.ts";

// MCP1 to MCP7: every tool server your agent can use, where it comes from, whether it works, and how to add more. Lives in the right dock (Tools).

export function Glyph({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const svg = mcpGlyph[name as keyof typeof mcpGlyph] ?? mcpGlyph.plug;
  return <svg aria-hidden viewBox="0 0 12 12" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" className={cx("shrink-0", className)} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const GROUPS: { id: string; title: string; note: string; sources: McpSource[] }[] = [
  { id: "claude", title: "From Claude Code", note: "Shrike reads these and never changes them", sources: ["claude-user", "claude-local"] },
  { id: "repo", title: "This project's .mcp.json", note: "Shrike starts these only after you trust them", sources: ["claude-project"] },
  { id: "shrike", title: "Shrike's own", note: "Added here; secrets live in your keychain", sources: ["shrike-personal", "shrike-project"] },
];
const SOURCE_WORD: Record<McpSource, string> = { "claude-user": "Claude Code", "claude-local": "Claude Code, this project", "claude-project": ".mcp.json", "shrike-personal": "Just me", "shrike-project": "This project" };

type Status = { word: string; tone: string; pulse?: boolean };
export function statusOf(s: McpServerView): Status {
  if (!s.enabled) return { word: "Off", tone: cssColor.inkFaint };
  if (!s.trusted) return { word: "Waiting for you to trust it", tone: cssColor.slow };
  if (s.missing.length) return { word: `Needs ${s.missing.join(", ")}`, tone: cssColor.slow };
  const h = s.health;
  if (!h) return { word: "Not checked yet", tone: cssColor.inkFaint };
  if (h.state === "checking") return { word: "Checking", tone: cssColor.slow, pulse: true };
  if (h.state === "failed") return { word: "Not working", tone: cssColor.fail };
  const n = h.tools?.length ?? 0;
  return { word: `Working · ${n} tool${n === 1 ? "" : "s"}`, tone: cssColor.ok };
}

export function ToolsPanel() {
  const st = useMcp((s) => s.state);
  const wanted = useMcp((s) => s.wanted);
  const mine = useUi((s) => s.ask.useMyMcp);
  useEffect(() => {
    void useMcp.getState().load().then(() => useMcp.getState().checkAll());
  }, []);
  const servers = st?.servers ?? [];
  const ready = servers.filter((s) => s.enabled && s.trusted && !s.missing.length).length;

  return (
    <div className="mc-panel min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4" aria-label="Your agent's tools">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 text-[12.5px] leading-snug text-dim">
          {servers.length ? `${ready} of ${servers.length} ready for your agent.` : "No tool servers yet. Add one below."}
        </p>
        <button type="button" className="hud-btn" title="Start each one, list its tools, close it" onClick={() => void useMcp.getState().checkAll(true)}>
          <RefreshCw size={10} aria-hidden />
          Check all
        </button>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={mine}
        onClick={() => useUi.setState((s) => ({ ask: { ...s.ask, useMyMcp: !mine } }))}
        className={cx("mc-use mt-2", mine && "on")}
        title="The My tools chip on Ask does the same"
      >
        <i aria-hidden className="mc-switch" />
        <span>{mine ? "Your agent gets these when you ask" : "Your agent asks without these. Turn on to use them"}</span>
      </button>

      {wanted && <WantedCard />}
      {(st?.recommended.length ?? 0) > 0 && <Recommended />}

      {GROUPS.map((g) => {
        const list = servers.filter((s) => g.sources.includes(s.source));
        if (!list.length) return null;
        return (
          <section key={g.id} aria-label={g.title} className="mt-4">
            <h4 className="m-0 mb-1 flex min-w-0 items-baseline gap-2 text-[12px] font-medium text-dim">
              <span className="shrink-0">{g.title}</span>
              <span className="min-w-0 truncate text-[11px] font-normal text-faint" title={g.note}>
                {g.note}
              </span>
            </h4>
            <ul className="m-0 flex list-none flex-col divide-y divide-hair p-0">
              {list.map((s) => (
                <ServerCard key={s.name} s={s} />
              ))}
            </ul>
          </section>
        );
      })}

      <AddTools />
    </div>
  );
}

function ServerCard({ s }: { s: McpServerView }) {
  const [open, setOpen] = useState(false);
  const st = statusOf(s);
  const act = useMcp((x) => x.act);
  const tools = s.health?.tools ?? [];
  const failed = s.enabled && s.trusted && s.health?.state === "failed";
  const own = s.source.startsWith("shrike");
  return (
    <li data-server={s.name} className={cx("mc-card", !s.enabled && "off", failed && "failed")}>
      <div className="flex items-center gap-2">
        <span className="mc-glyph" style={{ color: s.enabled ? cssColor[mcp.tone] : cssColor.inkFaint }}>
          <Glyph name={s.glyph} />
        </span>
        <b className="min-w-0 truncate text-[13px] font-medium text-ink" title={s.name}>
          {s.name}
        </b>
        <span className="mc-source">
          {SOURCE_WORD[s.source]}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label={`Use ${s.name} in this project`}
          title={s.enabled ? "On for this project" : "Off for this project"}
          className={cx("mc-toggle", s.enabled && "on")}
          onClick={() => void act((a) => a.mcpSetEnabled(s.name, !s.enabled), "Couldn't switch it")}
        >
          <i aria-hidden />
        </button>
      </div>
      <p className="m-0 mt-1 text-[12px] leading-snug text-dim">{s.purpose}</p>
      <p className="m-0 mt-1.5 flex items-center gap-1.5 text-[11.5px]" role="status">
        <i aria-hidden className="mc-dot" style={{ background: st.tone }} />
        <span style={{ color: st.tone === cssColor.inkFaint ? undefined : st.tone }} className={st.tone === cssColor.inkFaint ? "text-dim" : undefined}>
          {st.word}
        </span>
        {st.pulse && <Elapsed />}
        {s.health?.ms != null && s.health.state !== "checking" && <span className="font-mono text-[10px] text-faint tabular-nums" title="Time to start and list its tools">· {(s.health.ms / 1000).toFixed(1)}s</span>}
      </p>
      {failed && s.health?.error && <p className="mc-error">{s.health.error}</p>}
      {s.enabled && !s.trusted && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <p className="m-0 w-full text-[11.5px] leading-snug text-dim">
            It comes from this project's files and {s.transport === "stdio" ? "runs" : "connects to"} <span className="font-mono break-all text-ink">{s.transport === "stdio" ? s.command : s.url}</span>. Trust it only if you know it.
          </p>
          <button type="button" className="btn go h-6 px-2 text-[11px]" onClick={() => void act((a) => a.mcpTrust(s.name), "Couldn't trust it")}>
            Trust and check
          </button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className="mc-chip" aria-expanded={open} onClick={() => setOpen(!open)} title="How it starts and what it can do">
          <ChevronRight size={10} aria-hidden className={cx("transition-transform", open && "rotate-90")} />
          {tools.length ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : "Details"}
        </button>
        {[...s.envNames, ...s.headerNames].map((n) => (
          <span key={n} className="mc-secret" title={`${n} is set. Shrike never shows its value`}>
            {n} <span aria-hidden>••••</span>
          </span>
        ))}
        <span className="flex-1" />
        {failed && (
          <button type="button" className="hud-btn" title="Ask your agent what's wrong and how to fix it" onClick={() => void fixIt(s.name)}>
            <Wrench size={10} aria-hidden />
            Fix it
          </button>
        )}
        {s.enabled && s.trusted && !s.missing.length && (
          <button type="button" className="hud-btn px-1.5" aria-label={`Check ${s.name} again`} title="Check again" onClick={() => void act((a) => a.mcpCheck(s.name), "Couldn't check it")}>
            <RefreshCw size={10} aria-hidden />
          </button>
        )}
        {own && (
          <button type="button" className="hud-btn px-1.5" aria-label={`Remove ${s.name}`} title="Remove it from Shrike's own tools" onClick={() => void act((a) => a.mcpRemove(s.name), "Couldn't remove it")}>
            <Trash2 size={10} aria-hidden />
          </button>
        )}
      </div>
      {open && (
        <div className="mc-details">
          <p className="m-0 font-mono text-[10.5px] break-all text-dim">
            {s.transport === "stdio" ? `Starts: ${s.command ?? ""}` : `${s.transport === "sse" ? "SSE" : "HTTP"}: ${s.url ?? ""}`}
          </p>
          {s.shadows?.length ? <p className="m-0 mt-1 text-[11px] text-faint">Also set in {s.shadows.map((x) => SOURCE_WORD[x]).join(", ")}; this one wins.</p> : null}
          {tools.length > 0 && (
            <ul aria-label={`${s.name} tools`} className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
              {tools.map((t) => (
                <li key={t.name} className="text-[11.5px] leading-snug">
                  <span className="font-mono text-ink">{t.name}</span>
                  {t.description && <span className="text-dim"> · {t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** MCP2 Fix it: your agent gets the error in plain words; its run shows on the agent panel like any ask. */
async function fixIt(name: string): Promise<void> {
  await useMcp.getState().act(async (a) => {
    const run = await a.mcpFix(name);
    useAgent.setState((st) => ({ steps: [], approvals: [], answered: {}, usage: null, revising: null, sentNotes: [], run: st.run?.id === run.id ? { ...run, status: st.run.status } : run }));
    return a.mcpState();
  }, "Couldn't ask your agent");
}

/** MCP7: a skill uses a server you don't have. */
function WantedCard() {
  const w = useMcp((s) => s.wanted)!;
  const close = () => useMcp.setState({ wanted: null });
  return (
    <div role="group" aria-label="A skill needs a tool" className="mc-wanted mt-3">
      <p className="m-0 text-[12.5px] leading-snug text-ink">
        <b className="font-medium">{w.skill.name}</b> uses {w.missing.join(" and ")}, which {w.missing.length === 1 ? "isn't" : "aren't"} ready here yet.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex-1 text-[11.5px] text-dim">Add {w.missing.length === 1 ? "it" : "them"} below, then run the skill again.</span>
        <button type="button" className="btn h-6 px-2 text-[11px]" onClick={() => (close(), w.run())}>
          Run without it
        </button>
        <button type="button" className="hud-btn px-1.5" aria-label="Close" onClick={close}>
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

/** MCP3: one to three quiet suggestions from what the scanner and the start found. */
function Recommended() {
  const st = useMcp((s) => s.state)!;
  const act = useMcp((s) => s.act);
  return (
    <section aria-label="Suggested for this project" className="mc-reco mt-3">
      <h4 className="m-0 mb-1 text-[12px] font-medium text-dim">Might help with this project</h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {st.recommended.map((r) => {
          const e = st.catalog.find((c) => c.id === r.id);
          if (!e) return null;
          return (
            <li key={r.id} className="flex items-center gap-2">
              <span style={{ color: cssColor[mcp.tone] }}>
                <Glyph name={e.glyph} size={12} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={`${e.purpose} ${e.why}`}>
                {e.name} <span className="text-dim">· {r.why}</span>
              </span>
              <button type="button" className="hud-btn" onClick={() => useMcp.setState({ adding: e.id })}>
                <Plus size={10} aria-hidden />
                Add
              </button>
              <button type="button" className="hud-btn px-1.5" aria-label={`Not now: ${e.name}`} title="Not now" onClick={() => void act((a) => a.mcpDismiss(e.id), "Couldn't hide it")}>
                <X size={10} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---- MCP4/MCP5: add a server, from the popular list or a pasted snippet ----

const placeholdersIn = (t: string) => [...new Set([...t.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).filter((k) => k !== "PROJECT_ROOT"))];

function AddTools() {
  const st = useMcp((s) => s.state);
  const adding = useMcp((s) => s.adding);
  const [tab, setTab] = useState<"popular" | "paste">("popular");
  const have = new Set((st?.servers ?? []).flatMap((s) => [s.name, s.catalogId ?? ""]));
  return (
    <section aria-label="Add a tool" className="mt-5">
      <div className="flex items-center gap-2">
        <h4 className="m-0 flex-1 text-[12px] font-medium text-dim">Add a tool</h4>
        <span role="tablist" aria-label="How to add" className="inline-flex h-6 items-center overflow-hidden rounded-[8px] border border-hair">
          {(["popular", "paste"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("h-full px-2 text-[11px]", tab === t ? "bg-glass text-ink" : "text-dim hover:text-ink")}>
              {t === "popular" ? "Popular" : "Paste your own"}
            </button>
          ))}
        </span>
      </div>
      {tab === "paste" ? (
        <PasteForm />
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
          {(st?.catalog ?? []).map((e) => (
            <li key={e.id}>
              {adding === e.id ? (
                <CatalogForm e={e} have={have.has(e.id)} />
              ) : (
                <button type="button" className="mc-row" onClick={() => useMcp.setState({ adding: e.id })} aria-label={`${e.name}: ${e.purpose}`}>
                  <span style={{ color: have.has(e.id) ? cssColor.inkFaint : cssColor[mcp.tone] }}>
                    <Glyph name={e.glyph} size={13} />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px] text-ink">
                      {e.name}
                      {have.has(e.id) && <span className="text-faint"> · added</span>}
                    </span>
                    <span className="block truncate text-[11.5px] text-dim">{e.purpose}</span>
                  </span>
                  <Plus size={11} aria-hidden className="text-faint" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Scope({ value, onChange, projectOnly }: { value: "personal" | "project"; onChange(v: "personal" | "project"): void; projectOnly?: boolean }) {
  return (
    <span role="radiogroup" aria-label="Who gets it" className="inline-flex h-6 items-center overflow-hidden rounded-[8px] border border-hair">
      {(["personal", "project"] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={projectOnly && v === "personal"} onClick={() => onChange(v)} className={cx("h-full px-2 text-[11px] disabled:opacity-40", value === v ? "bg-glass text-ink" : "text-dim hover:text-ink")}>
          {v === "personal" ? "Just me" : "This project"}
        </button>
      ))}
    </span>
  );
}

function Fields({ fields, values, set }: { fields: { name: string; label: string; secret: boolean; hint?: string }[]; values: Record<string, string>; set(v: Record<string, string>): void }) {
  return (
    <>
      {fields.map((f) => (
        <label key={f.name} className="mt-2 block">
          <span className="flex items-baseline gap-2 text-[11.5px] text-ink">
            {f.label}
            <span className="font-mono text-[10px] text-faint">{f.name}</span>
          </span>
          <input
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[f.name] ?? ""}
            onChange={(e) => set({ ...values, [f.name]: e.target.value })}
            className="mc-input"
            aria-label={f.label}
            placeholder={f.secret ? "Goes to your keychain" : ""}
          />
          {f.hint && <span className="mt-0.5 block text-[10.5px] text-faint">{f.hint}</span>}
        </label>
      ))}
    </>
  );
}

function CatalogForm({ e, have }: { e: McpCatalogEntry; have: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<"personal" | "project">(e.scope === "project" ? "project" : "personal");
  const [busy, setBusy] = useState(false);
  const ready = e.fields.every((f) => values[f.name]?.trim());
  const add = async () => {
    setBusy(true);
    const ok = await useMcp.getState().add({ kind: "catalog", id: e.id, scope, values });
    setBusy(false);
    if (ok) useMcp.setState((s) => ({ adding: null, wanted: s.wanted?.missing.includes(e.id) ? null : s.wanted }));
  };
  return (
    <div className="mc-form" role="group" aria-label={`Add ${e.name}`}>
      <div className="flex items-center gap-2">
        <span style={{ color: cssColor[mcp.tone] }}>
          <Glyph name={e.glyph} size={13} />
        </span>
        <b className="flex-1 text-[12.5px] font-medium text-ink">{e.name}</b>
        <button type="button" className="hud-btn px-1.5" aria-label="Close" onClick={() => useMcp.setState({ adding: null })}>
          <X size={10} />
        </button>
      </div>
      <p className="m-0 mt-1 text-[12px] leading-snug text-dim">{e.purpose}</p>
      <p className="m-0 mt-1 text-[12px] leading-snug text-ink">{e.why}</p>
      <p className="m-0 mt-1.5 font-mono text-[10.5px] break-all text-faint">{e.transport === "http" ? e.url : [e.command, ...(e.args ?? [])].join(" ")}</p>
      <Fields fields={e.fields} values={values} set={setValues} />
      <div className="mt-2.5 flex items-center gap-2">
        <Scope value={scope} onChange={setScope} projectOnly={e.scope === "project"} />
        <span className="flex-1 text-[10.5px] text-faint">{e.install ? "Downloads once, after you allow it" : ""}</span>
        <button type="button" className="btn go h-7" disabled={!ready || busy} onClick={() => void add()}>
          {busy ? <Spinner size={10} /> : null}
          {have ? "Replace" : "Add"}
        </button>
      </div>
    </div>
  );
}

function PasteForm() {
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<"personal" | "project">("personal");
  const [busy, setBusy] = useState(false);
  const holes = useMemo(() => placeholdersIn(text), [text]);
  const add = async () => {
    setBusy(true);
    const ok = await useMcp.getState().add({ kind: "paste", text, scope, values: Object.fromEntries(holes.map((h) => [h, values[h] ?? ""]).filter(([, v]) => v)) });
    setBusy(false);
    if (ok) setText("");
  };
  return (
    <div className="mc-form mt-2" role="group" aria-label="Paste a server">
      <p className="m-0 text-[12px] leading-snug text-dim">Paste what a README gives you: a JSON snippet, a "claude mcp add" line, a command, or an https address. Tokens you paste move to your keychain.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        aria-label="Server snippet"
        placeholder={'{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }'}
        className="mc-input mt-2 h-auto resize-y py-1.5 font-mono text-[11px] leading-snug"
      />
      <Fields fields={holes.map((h) => ({ name: h, label: h.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()), secret: true }))} values={values} set={setValues} />
      <div className="mt-2.5 flex items-center gap-2">
        <Scope value={scope} onChange={setScope} />
        <span className="flex-1" />
        <button type="button" className="btn go h-7" disabled={!text.trim() || busy} onClick={() => void add()}>
          {busy ? <Spinner size={10} /> : null}
          Add
        </button>
      </div>
    </div>
  );
}

// ---- MCP8 [New Tool Unlocked]: the System's window the first time one of your servers works for your agent. Mount once in the Shell's stage. ----

const SHOW_MS = 3200;

export function ToolsLayer() {
  useMcpBridge();
  const u = useMcp((s) => s.unlocked[0]);
  const system = useSystem((s) => !!s.current);
  const calm = useCalm();
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!u || held || system) return;
    setLeaving(false);
    const t = setTimeout(() => setLeaving(true), SHOW_MS);
    return () => clearTimeout(t);
  }, [u, held, system]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => (setLeaving(false), setHeld(false), useMcp.setState((s) => ({ unlocked: s.unlocked.slice(1) }))), calm ? 0 : 220);
    return () => clearTimeout(t);
  }, [leaving, calm]);
  if (!u || system) return null;
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-[min(520px,100%)]">
        <SystemFrame calm={calm} leaving={leaving} label={`New tool unlocked: ${u.server}`} pad="px-6 pt-3 pb-3.5" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onClick={() => setLeaving(true)}>
          <SystemTag>New Tool Unlocked</SystemTag>
          <p className="mc-u-title">
            <span style={{ color: cssColor[mcp.tone] }}>
              <Glyph name={u.glyph} size={15} />
            </span>
            {u.server}
          </p>
          <p className="mc-u-line">Your agent used it for the first time, and it worked.</p>
          <p className="mc-u-xp">+{u.xp} XP</p>
        </SystemFrame>
      </div>
    </div>
  );
}
