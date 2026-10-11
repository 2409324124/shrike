import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, FileDiff, FileMinus, FileOutput, FilePen, FilePlus, FileWarning, GitBranch, GitPullRequest, MessageSquare, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import type { ScmArea, ScmCommit, ScmFile, ScmState } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { useAgent, useInlineApproval } from "../stores/agent.ts";
import { useUi } from "../stores/ui.ts";
import { cx, IconButton, Kbd, Spinner } from "../components/ui.tsx";
import { openPrPanel, usePr, usePrFileComments } from "../pr/index.ts";
import { ago, branchMap, byArea, commitWords, LETTER_TONE, SECTIONS, splitPath, statusWords, syncWords } from "./logic.ts";
import { useScm } from "./store.ts";
import "./scm.css";
import { PreflightPanel } from "../lessons/ci/Preflight.tsx"; // ci-lessons: CI3/CI4 pre-flight, above Sync

// SC2–SC7: the Changes tab. Plain words first; git's words in tooltips.

const SHOWN = 8;
const LETTER_WORD: Record<ScmFile["letter"], string> = { U: "New, not tracked yet", A: "Added", M: "Edited", D: "Deleted", R: "Moved", C: "Copied", "!": "Has conflicts" };
const LETTER_ICON: Record<ScmFile["letter"], typeof FilePen> = { U: FilePlus, A: FilePlus, M: FilePen, D: FileMinus, R: FileOutput, C: FileOutput, "!": FileWarning };

export const GitMissing = () => (
  <>
    Git keeps every version of your code so you can undo anything. On a Mac, open Terminal and run <code className="selectable font-mono text-[12px] whitespace-nowrap text-ink">xcode-select --install</code>. Elsewhere, get it from git-scm.com/downloads. Then come back here.
  </>
);

export function ChangesPanel() {
  const state = useScm((s) => s.state);
  const busy = useScm((s) => s.busy);
  if (!state) return <p className="lbl flex items-center gap-2 p-4">{busy === "load" && <Spinner size={11} />} Reading your repo</p>;
  if (state.gitMissing)
    return (
      <div className="p-4 text-[13px] leading-[1.55]">
        <p className="m-0 text-ink">Git isn't on this computer.</p>
        <p className="m-0 mt-1.5 text-dim"><GitMissing /></p>
      </div>
    );
  if (!state.isRepo)
    return (
      <div className="p-4 text-[13px] leading-[1.55]">
        <p className="m-0 text-ink">This folder isn't saved in git yet.</p>
        <p className="m-0 mt-1.5 text-dim">Git keeps every version of your code so you can undo anything. Open Terminal in the project folder and run git init, then come back here.</p>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header s={state} />
      <Approval />
      <Note />
      <CommitBox s={state} />
      <div className="scm-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <Sections s={state} />
        <Commits commits={state.commits} />
      </div>
    </div>
  );
}

function Header({ s }: { s: ScmState }) {
  const busy = useScm((st) => st.busy);
  const git = useUi((u) => u.hasPr);
  const known = usePr((p) => (p.view?.branch === s.branch && p.view?.pr && (p.view.pr.state === "open" || p.view.pr.state === "draft") ? p.view.pr.number : undefined));
  const hasPr = git || known !== undefined;
  const sync = syncWords(s);
  const words = statusWords(s);
  const open = () => void api().scmOpenOnGitHub().catch((e: unknown) => useScm.setState({ note: { text: errorMessage(e), tone: "error" } }));
  return (
    <section aria-label="Branch" className="shrink-0 border-b border-hair px-4 pt-3 pb-2">
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
        <GitBranch size={12} className="shrink-0 text-signal" aria-hidden />
        <span className="min-w-0 truncate text-ink" title={s.branch ?? "Not on a branch"}>{s.branch ?? "no branch"}</span>
        <span className="shrink-0 text-faint" aria-hidden>→</span>
        <span className={cx("min-w-0 shrink-[3] truncate", s.upstream ? "text-dim" : "text-faint")} title={s.upstream ? `GitHub's copy: ${s.upstream}` : "Not on GitHub yet"}>
          {s.upstream ? (s.upstream === `${s.remote}/${s.branch}` ? (s.web ? "GitHub" : s.remote) : s.upstream) : s.remote ? "not on GitHub yet" : "no GitHub"}
        </span>
        {s.upstream && (
          <span className="flex shrink-0 items-center gap-1 text-[10.5px]" aria-label={`${s.ahead} to send, ${s.behind} to bring in`}>
            <span className={cx("inline-flex items-center", s.ahead ? "text-signal" : "text-faint")} title="Commits here, not on GitHub yet"><ArrowUp size={10} aria-hidden />{s.ahead}</span>
            <span className={cx("inline-flex items-center", s.behind ? "text-slow" : "text-faint")} title="Commits on GitHub, not here yet"><ArrowDown size={10} aria-hidden />{s.behind}</span>
          </span>
        )}
        <div className="flex-1" />
        {s.web && (
          <IconButton label="Open on GitHub" onClick={open}>
            <ExternalLink size={12} />
          </IconButton>
        )}
      </div>
      <BranchMapStrip s={s} pr={hasPr} />
      <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0" aria-label="Status">
        {words.map((w) => (
          <li key={w.text} className={cx("scm-word", w.tone)}>{w.text}</li>
        ))}
      </ul>
      <PreflightPanel />
      <div className="mt-2 flex items-center gap-1.5">
        {s.remote && (
          <button type="button" className="hud-btn" disabled={!!busy && busy !== "load"} title={sync.hint} onClick={() => void useScm.getState().sync()}>
            {busy === "sync" ? <Spinner size={10} /> : <RefreshCw size={11} aria-hidden />}
            {sync.label}
          </button>
        )}
        {s.branch && s.branch !== s.base && (
          <button type="button" className="hud-btn" title={hasPr ? "See the pull request and its checks" : "Open the Ship sheet: it writes the title and description with your agent, then asks before pushing"} onClick={() => (hasPr ? openPrPanel() : useUi.setState({ panel: "ship" }))}>
            <GitPullRequest size={11} aria-hidden />
            {hasPr ? (known ? `See PR #${known}` : "See the PR") : "Create PR"}
          </button>
        )}
      </div>
    </section>
  );
}

/** SC2: base line, this branch peeling off, a dot per commit (filled on GitHub, hollow only here), a ring for uncommitted work, PR at the tip. */
function BranchMapStrip({ s, pr }: { s: ScmState; pr: boolean }) {
  const m = branchMap(s, pr);
  const W = 300;
  const yB = m.onBase ? 22 : 33;
  const yM = m.onBase ? yB : 12;
  const x0 = (m.onBase ? 52 : 74) + (m.more ? 22 : 0);
  const dots = m.mine.map((pushed, i) => ({ x: x0 + i * 20, pushed }));
  const ring = m.dirty ? x0 + dots.length * 20 : undefined;
  const tip = ring ?? dots.at(-1)?.x ?? x0 - 10;
  const unsent = m.mine.filter((p) => !p).length;
  const label = [
    m.onBase ? `On ${m.base}` : `${s.branch} grows from ${m.base}`,
    m.mine.length ? `${m.mine.length + m.more} ${m.onBase ? "commits not on GitHub" : "commits on this branch"}${!m.onBase && unsent ? `, ${unsent} only on this computer` : ""}` : "",
    m.behind ? `${m.base} has ${m.behind} new` : "",
    m.dirty ? "changes not committed yet" : "",
    m.pr ? "pull request open" : "",
  ].filter(Boolean).join("; ");
  return (
    <svg className="scm-map" viewBox={`0 0 ${W} 44`} preserveAspectRatio="xMinYMid meet" role="img" aria-label={label}>
      <title>{label}</title>
      <line x1="4" x2={W - 4} y1={yB} y2={yB} className="base" />
      <text x="4" y={m.onBase ? yB - 8 : yB + 10} className="tag">{m.base}</text>
      {Array.from({ length: m.behind }, (_, i) => (
        <circle key={i} cx={W - 12 - i * 12} cy={yB} r="3" className="behind">
          <title>{m.onBase ? "On GitHub, not here yet" : `New on ${m.base}, not on this branch`}</title>
        </circle>
      ))}
      {!m.onBase && (
        <>
          <path d={`M42 ${yB} C 56 ${yB}, 52 ${yM}, 66 ${yM} L ${tip} ${yM}`} className="mine-line" />
          <circle cx="42" cy={yB} r="2.5" className="forkdot" />
        </>
      )}
      {m.more > 0 && <text x={x0 - 20} y={yM + 3} className="tag">+{m.more}</text>}
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={yM} r="4" className={d.pushed ? "pushed" : "local"}>
          <title>{d.pushed ? "On GitHub" : "Only on this computer"}</title>
        </circle>
      ))}
      {ring !== undefined && (
        <circle cx={ring} cy={yM} r="4.5" className="dirty">
          <title>Changes not committed yet</title>
        </circle>
      )}
      {m.pr && (
        <>
          <path d={`M${tip + 8} ${yM} C ${tip + 24} ${yM}, ${tip + 22} ${yB}, ${tip + 40} ${yB}`} className="pr-line" />
          <text x={tip + 12} y={yM - 3} className="tag pr">PR</text>
        </>
      )}
    </svg>
  );
}

/** The discard or push you just asked for, waiting on you here instead of on the agent's card. */
function Approval() {
  const mine = useScm((s) => s.busy === "discard" || s.busy === "sync");
  const ask = useAgent((s) => s.approvals.find((a) => !a.patch && /^(Throw away|Send) /.test(a.title))); // scm.ts discard() and sync() titles
  useInlineApproval(mine ? ask?.id : undefined);
  if (!mine || !ask) return null;
  return (
    <section aria-label="Allow this?" className="scm-approval">
      <p className="m-0 text-[13px] text-ink">{ask.title}</p>
      <p className="mt-1 mb-2 text-[12px] leading-[1.45] text-dim">{ask.reason}</p>
      <div className="flex gap-2">
        <button type="button" className="btn go" onClick={() => void useAgent.getState().answer(ask.id, true)}>Allow</button>
        <button type="button" className="btn" onClick={() => void useAgent.getState().answer(ask.id, false)}>Not now</button>
      </div>
    </section>
  );
}

function Note() {
  const note = useScm((s) => s.note);
  if (!note) return null;
  return (
    <p role={note.tone === "error" ? "alert" : "status"} className={cx("scm-note m-0", note.tone)}>
      <span className="min-w-0 flex-1">{note.text}</span>
      <button type="button" className="hud-btn" onClick={() => useScm.setState({ note: null })}>OK</button>
    </p>
  );
}

function CommitBox({ s }: { s: ScmState }) {
  const message = useScm((st) => st.message);
  const written = useScm((st) => st.written);
  const busy = useScm((st) => st.busy);
  const ref = useRef<HTMLTextAreaElement>(null);
  const c = commitWords(s);
  const writing = busy === "write";
  const go = () => c.can && message.trim() && !busy && void useScm.getState().commit();
  return (
    <section aria-label="Commit" className="shrink-0 border-b border-hair px-4 py-3">
      <div className={cx("scm-msg", written && "written", writing && "writing")}>
        <textarea
          ref={ref}
          value={message}
          rows={message.includes("\n") ? 4 : 2}
          spellCheck
          aria-label="Commit message"
          placeholder={writing ? "Your agent is reading the changes…" : "What did you change, and why? Or press Write it for me."}
          disabled={writing}
          onChange={(e) => useScm.setState({ message: e.target.value, written: false })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), go());
          }}
        />
        <button type="button" className="scm-sparkle" disabled={!!busy || !c.can} title="Write it for me: your agent reads the changes and writes the message (the Commit message recipe)" onClick={() => void useScm.getState().write()}>
          {writing ? <Spinner size={11} /> : <span aria-hidden>✦</span>}
          {writing ? "Writing" : "Write it for me"}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn go" disabled={!c.can || !message.trim() || !!busy} onClick={go} title="Saves a version in git on this computer. Nothing goes to GitHub.">
          {busy === "commit" ? <Spinner size={10} /> : null}
          {c.label}
        </button>
        {!s.undo && <Kbd>⌘↵</Kbd>}
        <div className="flex-1" />
        {s.undo && (
          <button type="button" className="hud-btn" disabled={!!busy} title={`Undo "${s.undo}". Your changes come back staged.`} onClick={() => void useScm.getState().undo()}>
            <Undo2 size={11} aria-hidden /> Undo last commit
          </button>
        )}
      </div>
    </section>
  );
}

function Sections({ s }: { s: ScmState }) {
  const local = s.files.some((f) => f.area !== "branch");
  return (
    <>
      {!local && <p className="scm-empty">Nothing changed since your last commit. When your agent edits code, the files show up here.</p>}
      {SECTIONS.map((sec) => {
        const files = byArea(s.files, sec.area);
        return files.length ? <Section key={sec.area} area={sec.area} title={sec.area === "branch" && s.base ? `Committed on this branch` : sec.title} hint={sec.area === "branch" && s.base ? sec.hint.replace("main", s.base) : sec.hint} files={files} /> : null;
      })}
    </>
  );
}

function Section({ area, title, hint, files }: { area: ScmArea; title: string; hint: string; files: ScmFile[] }) {
  const [shut, setShut] = useState(false);
  const [all, setAll] = useState(false);
  const busy = useScm((s) => !!s.busy && s.busy !== "load");
  const shown = all ? files : files.slice(0, SHOWN);
  const paths = files.map((f) => f.path);
  return (
    <section aria-label={title} className="scm-sec">
      <header className="group/sec">
        <button type="button" className="scm-sec-head" aria-expanded={!shut} title={hint} onClick={() => setShut(!shut)}>
          <ChevronRight size={11} className={cx("transition-transform", !shut && "rotate-90")} aria-hidden />
          <span className={cx("lbl", area === "conflicts" ? "text-fail" : "text-ink")}>{title}</span>
          <span className="scm-n">{files.length}</span>
        </button>
        <span className="scm-sec-acts">
          {(area === "changes" || area === "untracked") && (
            <>
              <button type="button" className="hud-btn" disabled={busy} title={`Stage all ${files.length}: they go into your next commit`} onClick={() => void useScm.getState().stage(paths)}>Stage all</button>
              <IconButton label={`Throw away all ${files.length}`} disabled={busy} onClick={() => void useScm.getState().discard(paths)}>
                <Undo2 size={11} />
              </IconButton>
            </>
          )}
          {area === "staged" && <button type="button" className="hud-btn" disabled={busy} onClick={() => void useScm.getState().unstage(paths)}>Unstage all</button>}
        </span>
      </header>
      {!shut && (
        <ul className="m-0 list-none p-0">
          {shown.map((f) => <FileRow key={`${f.area}:${f.path}`} f={f} />)}
          {files.length > SHOWN && (
            <li>
              <button type="button" className="scm-more" onClick={() => setAll(!all)}>{all ? "Show fewer" : `View all ${files.length}`}</button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function FileRow({ f, sha }: { f: ScmFile; sha?: string }) {
  const busy = useScm((s) => !!s.busy && s.busy !== "load");
  const open = useScm((s) => s.diff?.path === f.path && s.diff.area === (sha ? "commit" : f.area) && s.diff.sha === sha);
  const notes = usePrFileComments()[f.path];
  const { name, dir } = splitPath(f.path);
  const Icon = LETTER_ICON[f.letter];
  const view = () => useScm.getState().openDiff(sha ? { path: f.path, area: "commit", sha } : f);
  const act = (e: React.MouseEvent, fn: () => void) => (e.stopPropagation(), fn());
  return (
    <li
      className={cx("scm-row group/row", open && "on")}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-shrike-file", JSON.stringify({ path: f.path }));
        e.dataTransfer.setData("text/plain", f.path);
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      <button type="button" className="scm-row-main" onClick={view} title={`${LETTER_WORD[f.letter]}: ${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}. Click to see the changes; drag onto Ask to give it to the agent.`}>
        <Icon size={12} className="scm-icon" style={{ color: LETTER_TONE[f.letter] }} aria-hidden />
        <span className="scm-name">{name}</span>
        {dir && <span className="scm-dir">{f.oldPath && f.letter === "R" ? `from ${splitPath(f.oldPath).name}` : dir}</span>}
      </button>
      {notes && notes.open > 0 && (
        <span className="scm-notes" title={`${notes.open} open review ${notes.open === 1 ? "comment" : "comments"} on this file`}>
          <MessageSquare size={10} aria-hidden />
          {notes.open}
        </span>
      )}
      <span className="scm-acts">
        {!sha && (f.area === "changes" || f.area === "untracked" || f.area === "conflicts") && (
          <IconButton label={f.area === "conflicts" ? "Mark as fixed (stage it)" : "Stage: goes into the next commit"} disabled={busy} onClick={(e) => act(e, () => void useScm.getState().stage([f.path]))}>
            <Plus size={12} />
          </IconButton>
        )}
        {!sha && f.area === "staged" && (
          <IconButton label="Unstage: keep the change, leave it out of the commit" disabled={busy} onClick={(e) => act(e, () => void useScm.getState().unstage([f.path]))}>
            <Minus size={12} />
          </IconButton>
        )}
        {!sha && (f.area === "changes" || f.area === "untracked") && (
          <IconButton label="Throw this change away (asks first)" disabled={busy} onClick={(e) => act(e, () => void useScm.getState().discard([f.path]))}>
            <Undo2 size={11} />
          </IconButton>
        )}
        <IconButton label="See the changes" onClick={(e) => act(e, view)}>
          <FileDiff size={11} />
        </IconButton>
      </span>
      <Counts f={f} />
      <span className="scm-letter" style={{ color: LETTER_TONE[f.letter] }} title={LETTER_WORD[f.letter]}>{f.letter}</span>
    </li>
  );
}

function Counts({ f }: { f: ScmFile }) {
  if (f.added === undefined) return <span className="scm-counts text-faint" title="Binary file">bin</span>;
  return (
    <span className="scm-counts" title={`${f.added} lines added, ${f.removed ?? 0} removed`}>
      {f.added > 0 && <span className="text-ok">+{f.added}</span>}
      {f.removed! > 0 && <span className="text-fail">−{f.removed}</span>}
    </span>
  );
}

function Commits({ commits }: { commits: ScmCommit[] }) {
  const [shut, setShut] = useState(true);
  if (!commits.length) return null;
  return (
    <section aria-label="Commits" className="scm-sec">
      <header>
        <button type="button" className="scm-sec-head" aria-expanded={!shut} onClick={() => setShut(!shut)} title="The last 30 commits on this branch">
          <ChevronRight size={11} className={cx("transition-transform", !shut && "rotate-90")} aria-hidden />
          <span className="lbl text-ink">Commits</span>
          <span className="scm-n">{commits.length}</span>
        </button>
      </header>
      {!shut && (
        <ol className="m-0 list-none p-0">
          {commits.map((c) => <CommitRow key={c.sha} c={c} />)}
        </ol>
      )}
    </section>
  );
}

function CommitRow({ c }: { c: ScmCommit }) {
  const [files, setFiles] = useState<ScmFile[] | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open || files) return;
    let live = true;
    api().scmCommitFiles(c.sha).then((f) => live && setFiles(f)).catch((e: unknown) => live && setErr(errorMessage(e)));
    return () => void (live = false);
  }, [open, files, c.sha]);
  const where = c.pushed ? "On GitHub" : "Only on this computer";
  return (
    <li className="scm-commit">
      <button type="button" className="scm-commit-main" aria-expanded={open} onClick={() => setOpen(!open)} title={`${c.short} · ${where}${c.mine ? "" : " · from before this branch"}`}>
        <i className={cx("scm-cdot", c.pushed ? "pushed" : "local", !c.mine && "old")} aria-label={where} />
        <span className={cx("min-w-0 flex-1 truncate", c.mine ? "text-ink" : "text-dim")}>{c.subject}</span>
        <span className="scm-dir shrink-0">{c.author} · {ago(c.at)}</span>
      </button>
      {open && (
        <Indent>
          {err ? <p className="scm-empty text-fail">{err}</p> : !files ? <p className="lbl flex items-center gap-2 px-2 py-1.5"><Spinner size={10} /> Reading</p> : files.length ? <ul className="m-0 list-none p-0">{files.map((f) => <FileRow key={f.path} f={f} sha={c.sha} />)}</ul> : <p className="scm-empty">No file changes in this commit.</p>}
        </Indent>
      )}
    </li>
  );
}

const Indent = ({ children }: { children: ReactNode }) => <div className="ml-3 border-l border-hair pl-1">{children}</div>;
