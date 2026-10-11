import { useEffect, useRef, useState } from "react";
import { Ellipsis, ExternalLink, RefreshCw } from "lucide-react";
import type { PrInfo, PrView } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { useAgent, useInlineApproval } from "../stores/agent.ts";
import { toast } from "../stores/ui.ts";
import { cx, IconButton, Spinner } from "../components/ui.tsx";
import { Checks } from "./Checks.tsx";
import { Comments } from "./Comments.tsx";
import { ago } from "./logic.ts";
import { useGit } from "../stores/git.ts";
import { openPrPanel, usePr, usePrBridge } from "./store.ts";

// PR1–PR9: the pull request and CI panel. A tab in the right dock (the dock shell mounts <PrPanel docked />);
// with no dock it opens as a drawer over the stage (PR10).

const STATE: Record<PrInfo["state"], { word: string; tone: string }> = {
  open: { word: "Open", tone: "var(--ok)" },
  draft: { word: "Draft", tone: "var(--ink-faint)" },
  merged: { word: "Merged", tone: "var(--violet)" },
  closed: { word: "Closed", tone: "var(--fail)" },
};
const DECISION: Record<NonNullable<PrInfo["decision"]>, { word: string; tone: string }> = {
  approved: { word: "Approved", tone: "text-ok" },
  changes: { word: "Changes asked", tone: "text-slow" },
  review: { word: "Waiting for review", tone: "text-dim" },
};

export function PrPanel({ docked = false }: { docked?: boolean }) {
  usePrBridge();
  const view = usePr((s) => s.view);
  const loading = usePr((s) => s.loading);
  const note = usePr((s) => s.note);
  const busy = usePr((s) => s.busy);
  const list = usePr((s) => s.list);
  const ask = useAgent((s) => (busy ? s.approvals.find((a) => !a.patch) : undefined)); // only while this panel is waiting on its own write

  useEffect(() => {
    if (!docked) return;
    usePr.setState((s) => ({ docked: s.docked + 1 }));
    return () => usePr.setState((s) => ({ docked: s.docked - 1 }));
  }, [docked]);
  const want = usePr((s) => s.want);
  useEffect(() => void usePr.getState().load(), [want]); // on open, and each time something asks to show it
  const running = !!view?.checks.some((c) => c.state === "pending");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void usePr.getState().load(), 15_000);
    return () => clearInterval(t);
  }, [running]);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Pull request and checks" data-pr-panel>
      <Header view={view} loading={loading} />
      <div className="min-h-0 flex-1 overflow-auto pb-16"> {/* the Ask pill can sit over the dock's foot; the last controls scroll clear of it */}
        {list && <OpenPrs />}
        {ask && <Approval title={ask.title} reason={ask.reason} id={ask.id} />}
        {note && <p role="status" className={cx("mx-4 mt-2 text-[12px] leading-snug", note.tone === "error" ? "text-fail" : note.tone === "ok" ? "text-ok" : "text-dim")}>{note.text}</p>}
        {!view ? (
          note?.tone !== "error" && <p className="lbl flex items-center gap-2 px-4 py-6"><Spinner size={11} /> Asking GitHub</p>
        ) : !view.ghReady ? (
          <section className="px-4 py-4">
            <p className="font-display text-[15px] font-semibold text-ink">GitHub isn't connected</p>
            <p className="mt-1.5 text-[12.5px] text-dim">Pull requests, checks and comments need it. {view.problem}</p>
          </section>
        ) : (
          <>
            {view.problem && <p className="px-4 pt-3 text-[12.5px] text-dim">{view.problem}</p>}
            <Checks view={view} />
            {view.pr && (
              <div className="border-t border-hair">
                <Comments view={view as PrView & { pr: PrInfo }} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** PR14: every open pull request; one tap shows it here. */
function OpenPrs() {
  const prs = useGit((s) => s.prs);
  const busy = useGit((s) => s.busy);
  const note = useGit((s) => s.note);
  return (
    <section className="border-b border-hair px-4 py-3">
      <span className="lbl">Open pull requests</span>
      {prs === null && busy !== "prs" && note?.tone === "error" ? (
        <div className="mt-2 flex flex-col gap-2">
          <p role="status" className="m-0 text-[12.5px] text-fail">{note.text}</p>
          <button type="button" className="hud-btn self-start" onClick={() => void useGit.getState().loadPrs()}>Try again</button>
        </div>
      ) : prs === null ? (
        <p className="lbl mt-2 flex items-center gap-2">{busy === "prs" && <Spinner size={10} />} Asking GitHub</p>
      ) : prs.length ? (
        <ul aria-label="Open pull requests" className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
          {prs.map((p) => (
            <li key={p.number}>
              <button type="button" className="flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1 text-left text-[13px] hover:bg-glass" onClick={() => (openPrPanel(p.number), void usePr.getState().load(p.number))}>
                <span className="font-mono text-[11px] text-faint">#{p.number}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{p.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12.5px] text-dim">No open pull requests in this repo.</p>
      )}
    </section>
  );
}

function Header({ view, loading }: { view: PrView | null; loading: boolean }) {
  const pr = view?.pr;
  const s = pr ? STATE[pr.state] : undefined;
  const [menu, setMenu] = useState(false);
  return (
    <header className="relative shrink-0 border-b border-hair px-4 pt-3 pb-3">
      <div className="flex items-center gap-2">
        {pr && s ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[12px] text-dim">#{pr.number}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap" style={{ color: pr.state === "draft" ? "var(--ink-dim)" : s.tone }} data-pr-state={pr.state}>
              <i aria-hidden className="size-[7px] rounded-full border" style={pr.state === "draft" ? { borderColor: s.tone } : { background: s.tone, borderColor: s.tone, boxShadow: `0 0 8px ${s.tone}` }} />
              {s.word}
            </span>
            {pr.decision && pr.state !== "merged" && pr.state !== "closed" && (
              <span className={cx("text-[11.5px] whitespace-nowrap", DECISION[pr.decision].tone)}>
                {DECISION[pr.decision].word}
              </span>
            )}
          </div>
        ) : (
          <span className="lbl">Pull request</span>
        )}
        <span className="flex-1" />
        <IconButton label="Refresh" onClick={() => void usePr.getState().load()} disabled={loading}>
          {loading ? <Spinner size={11} /> : <RefreshCw size={12} />}
        </IconButton>
        {pr && (
          <IconButton label="Open on GitHub" onClick={() => void api().openLink(pr.url)}>
            <ExternalLink size={12} />
          </IconButton>
        )}
        <IconButton label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Ellipsis size={13} />
        </IconButton>
      </div>
      {pr ? (
        <>
          <h3 className="mt-2 line-clamp-2 font-display text-[15px] leading-snug font-semibold text-ink" title={pr.title}>{pr.title}</h3>
          <p className="mt-1 truncate text-[11.5px] text-dim">
            {pr.author}
            {pr.updatedAt && <span className="text-faint"> · updated {ago(pr.updatedAt)}</span>}
          </p>
          <BranchThread pr={pr} />
        </>
      ) : view?.ghReady ? (
        <>
          <h3 className="mt-2 font-display text-[15px] font-semibold text-ink">No pull request for {view.branch ?? "this branch"} yet</h3>
          <p className="mt-1 text-[12px] text-dim">Its checks still run on GitHub every time you send it. Open a pull request from Ship (S) when it's ready.</p>
        </>
      ) : null}
      {menu && <Menu view={view} onClose={() => setMenu(false)} />}
    </header>
  );
}

/** PR11: base line, this branch peeling off, the PR marker at its tip; merged rejoins the base, closed stops in a cap. */
function BranchThread({ pr }: { pr: PrInfo }) {
  const yB = 30;
  const yH = 14;
  const fork = Math.min(120, 14 + pr.base.length * 6.1);
  const head = pr.head.length > 30 ? `${pr.head.slice(0, 29)}…` : pr.head;
  const tip = Math.min(272, Math.max(fork + 84, fork + 24 + head.length * 6 + 12));
  const tone = STATE[pr.state].tone;
  const glow = (c: string) => `drop-shadow(0 0 3px color-mix(in srgb, ${c} 55%, transparent))`;
  const words = { open: "waiting to go in", draft: "a draft", merged: "merged", closed: "closed without merging" }[pr.state];
  return (
    <div className="mt-1.5 overflow-hidden" role="img" aria-label={`${pr.head} into ${pr.base}, ${words}`}>
      <span className="sr-only">{pr.base} ← {pr.head}</span>
      <svg aria-hidden viewBox="0 0 320 36" preserveAspectRatio="xMinYMid meet" className="block h-9 w-full overflow-visible">
        <line x1="4" x2="2000" y1={yB} y2={yB} stroke="var(--ink-faint)" strokeWidth="1.5" />
        <text x="4" y={yB - 6} fill="var(--ink-faint)" fontSize="8.5" letterSpacing="0.12em" className="font-mono uppercase">{pr.base}</text>
        <path d={`M${fork} ${yB} C ${fork + 14} ${yB}, ${fork + 8} ${yH}, ${fork + 22} ${yH} L ${tip} ${yH}`} fill="none" stroke="var(--signal)" strokeWidth="1.75" style={{ filter: glow("var(--signal)") }} />
        <circle cx={fork} cy={yB} r="2.5" fill="var(--ink-faint)" />
        <text x={fork + 26} y={yH - 5} fill="var(--signal)" fontSize="10" className="font-mono">{head}</text>
        {pr.state === "merged" && (
          <>
            <path d={`M${tip} ${yH} C ${tip + 16} ${yH}, ${tip + 10} ${yB}, ${tip + 28} ${yB}`} fill="none" stroke={tone} strokeWidth="1.75" style={{ filter: glow(tone) }} />
            <circle cx={tip + 28} cy={yB} r="3.5" fill={tone} />
          </>
        )}
        {pr.state === "closed" && <line x1={tip + 9} x2={tip + 9} y1={yH - 5} y2={yH + 5} stroke={tone} strokeWidth="2" strokeLinecap="round" />}
        <circle cx={tip} cy={yH} r="4.5" fill={pr.state === "open" || pr.state === "merged" ? tone : "var(--abyss)"} stroke={tone} strokeWidth="1.5" strokeDasharray={pr.state === "draft" ? "2 2" : undefined} style={pr.state === "open" ? { filter: glow(tone) } : undefined} />
        <text x={tip} y={yH - 8} textAnchor="middle" fill={pr.state === "draft" ? "var(--ink-dim)" : tone} fontSize="8.5" letterSpacing="0.12em" className="font-mono">PR</text>
      </svg>
    </div>
  );
}

function Menu({ view, onClose }: { view: PrView | null; onClose(): void }) {
  const pr = view?.pr;
  const pick = usePr((s) => s.pick);
  const [n, setN] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const t = setTimeout(() => window.addEventListener("mousedown", off)); // not the click that opened it
    return () => (clearTimeout(t), window.removeEventListener("mousedown", off));
  }, [onClose]);
  const item = "flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] text-ink hover:bg-glass disabled:opacity-40";
  const merge = async () => {
    onClose();
    usePr.setState({ busy: "merge", note: null });
    try {
      await api().mergePullRequest(pr!.number);
      usePr.setState({ note: { text: `Merged pull request #${pr!.number}.`, tone: "ok" } });
      void usePr.getState().load();
    } catch (e) {
      const text = errorMessage(e);
      usePr.setState({ note: { text, tone: /^Not /.test(text) ? "info" : "error" } });
    } finally {
      usePr.setState({ busy: null });
    }
  };
  return (
    <div ref={ref} role="menu" className="glass solid absolute top-10 right-3 z-20 w-[250px] rounded-[10px] p-1.5 shadow-[0_18px_50px_var(--shade)]">
      {pr && (
        <button role="menuitem" type="button" className={item} onClick={() => void navigator.clipboard.writeText(pr.url).then(() => (toast("Copied the link.", "ok"), onClose()))}>
          Copy link
        </button>
      )}
      {pr?.state === "draft" && (
        <button role="menuitem" type="button" className={item} onClick={() => (onClose(), void usePr.getState().act({ kind: "ready", n: pr.number }, "It's ready for review now."))}>
          Mark ready for review
        </button>
      )}
      {pr?.state === "open" && (
        <button role="menuitem" type="button" className={item} title="Only when every check and your saved flows are green. Asks you first." onClick={() => void merge()}>
          Merge when green
        </button>
      )}
      <form
        className="mt-1 flex items-center gap-1.5 border-t border-hair px-1 pt-2 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          const v = Number(n.replace(/^#/, ""));
          if (Number.isInteger(v) && v > 0) (onClose(), void usePr.getState().load(v));
        }}
      >
        <input value={n} onChange={(e) => setN(e.target.value)} aria-label="Pull request number" placeholder="Another one: #123" className="field h-7 min-w-0 flex-1" inputMode="numeric" />
        <button type="submit" className="hud-btn solid">Show</button>
      </form>
      {pick && (
        <button role="menuitem" type="button" className={item} onClick={() => (onClose(), void usePr.getState().load(null))}>
          Back to this branch
        </button>
      )}
    </div>
  );
}

/** A GitHub write waiting on you, with exactly what will be posted. Shown here instead of on the agent's card, since this panel is where you asked. */
function Approval({ id, title, reason }: { id: string; title: string; reason: string }) {
  useInlineApproval(id);
  const [what, ...body] = reason.split("\n\n");
  return (
    <section aria-label="Allow this?" className="mx-4 mt-3 rounded-[10px] border border-signal/50 bg-void/40 p-3 shadow-[0_0_18px_color-mix(in_srgb,var(--signal)_14%,transparent)]">
      <p className="m-0 text-[13.5px] text-ink">{title}</p>
      <p className="mt-1 text-[12px] text-dim">{what}</p>
      {body.length > 0 && <pre className="selectable mt-2 max-h-[180px] overflow-auto rounded-[7px] border border-hair bg-void/60 p-2 font-display text-[12.5px] leading-snug whitespace-pre-wrap text-ink" aria-label="What will be posted">{body.join("\n\n")}</pre>}
      <div className="mt-2.5 flex gap-2">
        <button type="button" className="btn go" onClick={() => void useAgent.getState().answer(id, true)}>
          Allow
        </button>
        <button type="button" className="btn" onClick={() => void useAgent.getState().answer(id, false)}>
          Not now
        </button>
      </div>
    </section>
  );
}

/** PR10: the panel as a drawer over the stage, until a dock mounts it. */
export function PrDrawer() {
  const open = usePr((s) => s.open && s.docked === 0);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) && usePr.setState({ open: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <aside className="glass solid rise absolute top-2 right-2 bottom-2 z-40 flex w-[min(420px,calc(100%-16px))] flex-col overflow-hidden rounded-[var(--r-card)] shadow-[0_30px_80px_var(--shade)]">
      <PrPanel />
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-hair px-3 py-1.5">
        <span className="micro text-[9px] text-faint">Esc closes</span>
        <button type="button" className="hud-btn" onClick={() => usePr.setState({ open: false })}>Close</button>
      </footer>
    </aside>
  );
}
