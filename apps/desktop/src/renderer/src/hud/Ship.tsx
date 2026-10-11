import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileDiff, GitBranch, X } from "lucide-react";
import type { GitState, PullRequest } from "@shrike/schema";
import { conflictHunks, GH_SETUP, mergeBlocker, type ConflictHunk } from "../../../main/github.ts";
import { api } from "../lib/api.ts";
import { useActions } from "../stores/actions.ts";
import { useAgent } from "../stores/agent.ts";
import { shrikeFiles, useGit, useGitBridge } from "../stores/git.ts";
import { useUi } from "../stores/ui.ts";
import { cx, IconButton, Kbd, Spinner } from "../components/ui.tsx";
import { openPrPanel, PrDrawer } from "../pr/index.ts"; // pr-ci: PR1–PR10
import { openChanges } from "../dock/store.ts"; // scm: SC1
import { SelfCheckCard } from "../lessons/index.ts"; // review-lessons: RL6

// G1–G6: the Ship sheet (S). One focal action at a time, everything in plain words.

const close = () => useUi.setState({ panel: null });
import { keys } from "../lib/platform.ts";

export function ShipSheet() {
  useGitBridge();
  const open = useUi((s) => s.panel === "ship");
  useEffect(() => void (open && useGit.getState().load()), [open]);
  const state = useGit((s) => s.state);
  if (!open) return <PrDrawer />;

  return (
    <div className="absolute inset-0 z-40 bg-[color-mix(in_srgb,var(--void)_60%,transparent)]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-label="Ship" className="glass solid @container rise absolute top-14 left-1/2 flex max-h-[min(640px,84%)] w-[min(600px,92%)] -translate-x-1/2 flex-col rounded-[var(--r-card)] shadow-[0_30px_80px_var(--void)]">
        <header className="flex items-center gap-2.5 py-3 pr-2 pl-4">
          <GitBranch size={13} className="shrink-0 text-signal" aria-hidden />
          <span className="lbl text-ink">Ship</span>
          <span className="hidden @2xs:contents">
            <Kbd>S</Kbd>
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim">{state?.branch ? branchLine(state) : ""}</span>
          <button type="button" className="hud-btn hidden shrink-0 @2xs:inline-flex" aria-label="See every change" title={keys("Every file you changed, staged and committed, in the right dock (⌘⇧G)")} onClick={() => (openChanges(), close())}>
            <FileDiff size={11} aria-hidden /> <span className="hidden @sm:inline">See every change</span>
          </button>
          <span className="micro hidden text-[9.5px] whitespace-nowrap text-faint @lg:inline">Esc closes</span>
          <IconButton label="Close" onClick={close}>
            <X size={13} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto border-t border-hair px-4 pt-3 pb-4">
          <Body state={state} />
        </div>
      </section>
    </div>
  );
}

function branchLine(s: GitState): string {
  const parts = [s.branch!];
  if (s.ahead) parts.push(`${s.ahead} to send`);
  if (s.behind) parts.push(`${s.behind} behind`);
  return parts.join(" · ");
}

function Body({ state }: { state: GitState | null }) {
  const busy = useGit((s) => s.busy);
  const ask = useAgent((s) => s.approvals.find((a) => !a.patch));
  if (!state) return <p className="lbl flex items-center gap-2 py-6">{busy === "load" ? <Spinner size={11} /> : null} Reading your repo</p>;
  if (!state.isRepo)
    return (
      <Focus title="This folder isn't saved in git yet">
        <p className="text-[13px] text-dim">Shipping needs git. Open Terminal in the project folder, run git init, and commit once. Then come back here.</p>
      </Focus>
    );
  return (
    <div className="flex flex-col gap-4">
      {ask && <Approval id={ask.id} title={ask.title} reason={ask.reason} />}
      {state.conflicts.length ? <Conflicts state={state} quiet={!!ask} /> : state.pr && state.pr.state === "open" ? <Pr state={state} pr={state.pr} quiet={!!ask} /> : <Changes state={state} quiet={!!ask} />}
      <Note />
      {!state.ghReady && <GhSetup state={state} />}
      {state.ghReady && <Review />}
    </div>
  );
}

function Focus({ title, label, children }: { title: string; label?: string; children: ReactNode }) {
  return (
    <section>
      {label && <span className="lbl">{label}</span>}
      <h4 className="mt-1 mb-2 font-display text-[15px] font-semibold text-ink">{title}</h4>
      {children}
    </section>
  );
}

function Note() {
  const note = useGit((s) => s.note);
  if (!note) return null;
  return <p role="status" className={cx("text-[12.5px] leading-snug", note.tone === "error" ? "text-fail" : note.tone === "ok" ? "text-ok" : "text-ink")}>{note.text}</p>;
}

/** A push, merge or sync waiting on you. Shown here too, since this sheet covers the agent's card. */
function Approval({ id, title, reason }: { id: string; title: string; reason: string }) {
  return (
    <section aria-label="Allow this?" className="rounded-[10px] border border-signal/50 bg-black/25 p-3">
      <p className="m-0 text-[13.5px] text-ink">{title}</p>
      <p className="mt-1 mb-2.5 text-[12.5px] text-dim">{reason}</p>
      <div className="flex gap-2">
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

function Step({ done, children }: { done?: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[16px_1fr] items-baseline gap-2 text-[13px] text-ink">
      <b className={cx("text-center font-mono text-[12px]", done ? "text-ok" : "text-faint")}>{done ? "✓" : "○"}</b>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// ---- G1: changes → branch, commit, push, PR ----

function Changes({ state, quiet }: { state: GitState; quiet: boolean }) {
  const busy = useGit((s) => s.busy);
  const picked = useGit((s) => s.picked);
  const checkpoints = useAgent((s) => s.checkpoints);
  const ours = useMemo(() => new Set(shrikeFiles(state)), [state, checkpoints]);
  const chosen = new Set(picked ?? ours);
  const trip = useActions((s) => s.order.map((id) => s.byId[id]).find((a) => a?.status === "error"));
  const proved = useUi((s) => s.sdlc?.stages.prove === "done"); // "works again" only once the re-run says so
  const title = trip ? `${trip.label.replace(/^Clicked\s+/, "")} works again` : undefined; // the commit subject and PR title are "Fix: <title>" (main/git.ts commitMessage)
  const subject = `Fix: ${title ?? checkpoints.findLast((c) => c.current)?.label ?? "Fix from Shrike"}`;
  const onBase = !state.branch || state.branch === (state.base ?? "main") || state.branch === "master";
  const incoming = state.incoming?.length ?? 0;
  const merged = state.pr?.state === "merged";

  const committed = !onBase && !merged ? (state.onBranch ?? 0) : 0;
  if (!state.changed.length && committed)
    return (
      <Focus label="Open a pull request" title={`${committed === 1 ? "1 commit" : `${committed} commits`} on ${state.branch} ${committed === 1 ? "isn't" : "aren't"} in a pull request yet`}>
        <ol className="m-0 mb-3 grid list-none gap-1.5 p-0">
          <Step done>Committed on {state.branch}</Step>
          <Step>Send it to GitHub (asks you first)</Step>
          {state.ghReady && <Step>Open a pull request into {state.base ?? "main"}</Step>}
        </ol>
        {state.ghReady && <SelfCheckCard />}
        <button type="button" className={cx("btn", !quiet && "go")} disabled={!!busy} onClick={() => void useGit.getState().ship()}>
          {busy === "ship" ? <Spinner size={10} /> : null}
          {state.ghReady ? "Open a pull request" : "Send to GitHub"}
        </button>
      </Focus>
    );
  if (!state.changed.length)
    return (
      <>
        <Focus title={merged ? `Pull request #${state.pr!.number} is merged` : "Nothing to ship right now"}>
          <p className="text-[13px] text-dim">{merged ? `It's on ${state.base ?? "main"} now.` : "Every change on this branch is saved. When Shrike fixes something, it shows up here."}</p>
        </Focus>
        <Sync state={state} focal={!quiet} />
        {state.ghReady && (
          <button type="button" className="hud-btn self-start" onClick={() => (close(), openPrPanel())}>
            This branch's checks
          </button>
        )}
      </>
    );

  const toggle = (f: string) => {
    const next = new Set(chosen);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    useGit.getState().pick([...next]);
  };
  return (
    <>
      <Focus label="Ship this fix" title={trip && proved ? `${trip.label} works again` : "Your changes"}>
        <ol className="m-0 mb-3 grid list-none gap-1.5 p-0">
          <Step>{onBase ? `Make a new branch from ${state.base ?? "main"} (${state.base ?? "main"} stays as it is)` : `Commit on ${state.branch}`}</Step>
          <Step>
            Commit {chosen.size === 1 ? "1 file" : `${chosen.size} files`} with the trip's verdict as the message
            <span className="mt-0.5 block truncate font-mono text-[11.5px] text-dim" aria-label="Commit message" title={subject}>
              {subject}
            </span>
          </Step>
          <Step>Send it to GitHub (asks you first)</Step>
          {state.ghReady && <Step>Open a pull request with the issue as its description</Step>}
        </ol>
        <fieldset className="mb-3 max-h-[150px] overflow-auto rounded-[8px] border border-hair bg-black/20 px-3 py-2">
          <legend className="micro px-1 text-[9.5px] text-faint">Files to include</legend>
          {state.changed.map((c) => (
            <label key={c.path} className="flex cursor-pointer items-center gap-2 py-0.5 font-mono text-[11.5px] text-ink">
              <input type="checkbox" checked={chosen.has(c.path)} onChange={() => toggle(c.path)} className="accent-[var(--signal)]" />
              <span className="min-w-0 flex-1 truncate">{c.path}</span>
              {ours.has(c.path) ? <span className="micro text-[9px] text-violet">Shrike's fix</span> : <span className="micro text-[9px] text-faint">{statusWord(c.status)}</span>}
            </label>
          ))}
        </fieldset>
        {state.ghReady && <SelfCheckCard />}
        <div className="flex items-center gap-2">
          <button type="button" className={cx("btn", !quiet && "go")} disabled={!chosen.size || !!busy} onClick={() => void useGit.getState().ship(title)}>
            {busy === "ship" ? <Spinner size={10} /> : null}
            Ship this fix
          </button>
          {!chosen.size && <span className="text-[12px] text-faint">Pick at least one file.</span>}
        </div>
      </Focus>
      {incoming > 0 && <Sync state={state} focal={false} />}
    </>
  );
}

const statusWord = (s: string) => (s === "??" ? "new" : s.includes("D") ? "deleted" : s.includes("R") ? "renamed" : s.includes("A") ? "added" : "changed");

// ---- G6: sync with main ----

function Sync({ state, focal }: { state: GitState; focal: boolean }) {
  const busy = useGit((s) => s.busy);
  const base = state.base ?? "main";
  const incoming = state.incoming ?? [];
  if (state.branch === base && !incoming.length)
    return (
      <button type="button" className="hud-btn self-start" disabled={!!busy} onClick={() => void useGit.getState().sync("preview")}>
        {busy === "sync" ? <Spinner size={10} /> : null}Check GitHub for new changes
      </button>
    );
  if (!incoming.length)
    return (
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-dim">Up to date with {base} as of the last check.</span>
        <button type="button" className="hud-btn" disabled={!!busy} onClick={() => void useGit.getState().sync("preview")}>
          {busy === "sync" ? <Spinner size={10} /> : null}Check again
        </button>
      </div>
    );
  return (
    <section aria-label="Sync with main">
      <p className="mb-1.5 text-[13px] text-ink">
        {state.branch === base ? `GitHub's ${base} has` : `${base} has`} {incoming.length === 1 ? "1 new change" : `${incoming.length}${incoming.length >= 20 ? "+" : ""} new changes`} {state.branch === base ? "you don't have yet." : "since this branch started."}
      </p>
      <ul className="m-0 mb-2.5 list-none p-0">
        {incoming.slice(0, 5).map((c) => (
          <li key={c.sha} className="truncate text-[12.5px] text-dim">
            <span className="font-mono text-[11px] text-faint">{c.sha}</span> {c.subject}
          </li>
        ))}
        {incoming.length > 5 && <li className="text-[12px] text-faint">and {incoming.length - 5} more</li>}
      </ul>
      <button type="button" className={cx("btn", focal && "go")} disabled={!!busy} onClick={() => void useGit.getState().sync()}>
        {busy === "sync" ? <Spinner size={10} /> : null}
        Bring them in
      </button>
    </section>
  );
}

// ---- G4/G5: the pull request, its checks, merge when green ----

const DOT: Record<PullRequest["checks"][number]["state"], string> = {
  pass: "bg-ok shadow-[0_0_6px_var(--ok)]",
  fail: "bg-fail shadow-[0_0_8px_var(--fail)]",
  pending: "border-[1.5px] border-slow",
  skipped: "bg-[var(--ink-faint)]",
};

export function CheckDots({ checks }: { checks: PullRequest["checks"] }) {
  if (!checks.length) return <span className="text-[12px] text-faint">No checks on this pull request.</span>;
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={checks.map((c) => `${c.name} ${c.state}`).join(", ")}>
      {checks.map((c) => (
        <i key={c.name} title={`${c.name}: ${c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : c.state === "pending" ? "running" : "skipped"}`} className={cx("inline-block size-[9px] rounded-full", DOT[c.state])} />
      ))}
    </span>
  );
}

function Pr({ state, pr, quiet }: { state: GitState; pr: PullRequest; quiet: boolean }) {
  const busy = useGit((s) => s.busy);
  const flows = useGit((s) => s.flows);
  const blocker = mergeBlocker(pr.checks, flows);
  const failed = pr.checks.filter((c) => c.state === "fail");
  const running = pr.checks.filter((c) => c.state === "pending").length;
  const passed = pr.checks.filter((c) => c.state === "pass").length;
  return (
    <>
      <Focus label={`Pull request #${pr.number} · open`} title={pr.title}>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <span className="lbl">Checks</span>
          <CheckDots checks={pr.checks} />
          <span className="text-[12px] text-dim">
            {failed.length ? `${failed.length} failed` : running ? `${running} still running` : pr.checks.length ? `All ${passed} passed` : ""}
          </span>
        </div>
        {failed.map((c, i) => (
          <section key={c.name} aria-label={`${c.name} failed`} className="mb-3 rounded-[10px] border border-fail/25 bg-black/25 p-3">
            <span className="lbl text-fail">{c.name} failed</span>
            <p className="mt-1.5 mb-2 text-[13px] leading-snug text-ink">{c.summary ?? "Reading its log…"}</p>
            {!!c.lines?.length && <pre className="selectable mb-2 max-h-[96px] overflow-auto rounded-[6px] bg-black/30 p-2 font-mono text-[11px] leading-[16px] whitespace-pre-wrap text-dim">{c.lines.slice(0, 4).join("\n")}</pre>}
            <button type="button" className={cx("btn", !quiet && i === 0 && "go")} disabled={!!busy} onClick={() => void useGit.getState().explain(c.name)}>
              {busy === "explain" ? <Spinner size={10} /> : <span className="text-violet">✦</span>}
              Ask why
            </button>
          </section>
        ))}
        <button type="button" className="hud-btn solid mb-3" onClick={() => (close(), openPrPanel())} title="Every check with its steps and log, and every review comment, with reply and resolve">
          Checks and comments
        </button>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" className={cx("btn", !quiet && !blocker && "go")} disabled={!!blocker || !!busy} title="Turns on when every check and your saved flows are green" onClick={() => void useGit.getState().merge()}>
            {busy === "merge" ? <Spinner size={10} /> : null}
            Merge when green
          </button>
          <span className="text-[12px] text-faint">{blocker ?? `Squashes into ${state.base ?? "main"}. Asks you first.`}</span>
        </div>
      </Focus>
      {state.changed.length > 0 && <p className="text-[12.5px] text-dim">{state.changed.length === 1 ? "1 file has" : `${state.changed.length} files have`} changes not in this pull request yet. Ship them from here once the checks settle.</p>}
      <Sync state={state} focal={false} />
    </>
  );
}

// ---- G3: conflicts, both sides per hunk ----

function Conflicts({ state, quiet }: { state: GitState; quiet: boolean }) {
  const busy = useGit((s) => s.busy);
  const [hunks, setHunks] = useState<Record<string, ConflictHunk[]>>({});
  const key = state.conflicts.join("\n");
  useEffect(() => {
    let live = true;
    void Promise.all(state.conflicts.map(async (f) => [f, conflictHunks(await api().readFile(f).catch(() => ""))] as const)).then((pairs) => live && setHunks(Object.fromEntries(pairs)));
    return () => {
      live = false;
    };
  }, [key]);
  const base = state.base ?? "main";
  // During a rebase git's "ours" is main and "theirs" is your commit; during a merge it's the other way round.
  const [top, bottom] = state.operation === "rebase" ? [base, "Yours"] : ["Yours", base];
  const n = state.conflicts.length;
  return (
    <Focus label={state.operation ? `Syncing with ${base} stopped` : "Merge conflicts"} title={n === 1 ? "1 file needs a decision" : `${n} files need a decision`}>
      <p className="text-[13px] text-dim">The same lines changed on both sides. Your agent can propose a fix for each file; you apply them one by one. Then Shrike finishes the sync and re-runs your flows.</p>
      <div className="my-3 flex flex-col gap-3">
        {state.conflicts.map((f) => (
          <div key={f}>
            <button type="button" className="font-mono text-[12px] text-signal hover:underline" onClick={() => (close(), useUi.getState().openFile({ path: f, line: hunks[f]?.[0]?.line ?? 1, error: true }))}>
              {f}
              {hunks[f]?.[0] ? `:${hunks[f]![0]!.line}` : ""}
            </button>
            {(hunks[f] ?? []).slice(0, 2).map((h) => (
              <div key={h.line} className="mt-1.5 grid grid-cols-2 gap-2">
                <Side label={top} lines={h.ours} />
                <Side label={bottom} lines={h.theirs} />
              </div>
            ))}
            {(hunks[f]?.length ?? 0) > 2 && <p className="mt-1 text-[12px] text-faint">and {hunks[f]!.length - 2} more in this file</p>}
            {hunks[f] && !hunks[f]!.length && <p className="mt-1 text-[12px] text-dim">No conflict marks left. It's ready.</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={cx("btn", !quiet && "go")} disabled={!!busy} onClick={() => void useGit.getState().resolve()}>
          {busy === "resolve" ? <Spinner size={10} /> : <span className="text-violet">✦</span>}
          Fix with the agent
        </button>
        <button type="button" className="hud-btn" disabled={!!busy} onClick={() => void useGit.getState().sync("continue")}>
          I fixed them, finish
        </button>
        {state.operation === "rebase" && (
          <button type="button" className="hud-btn" disabled={!!busy} title="Undo the rebase and merge main in instead" onClick={() => void useGit.getState().sync("merge")}>
            Merge instead
          </button>
        )}
        {state.operation && (
          <button type="button" className="hud-btn" disabled={!!busy} onClick={() => void useGit.getState().sync("abort")}>
            Undo the sync
          </button>
        )}
      </div>
    </Focus>
  );
}

function Side({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-hair bg-black/25 p-2">
      <span className="micro text-[9px] text-faint">{label}</span>
      <pre className="selectable mt-1 max-h-[110px] overflow-auto font-mono text-[11px] leading-[16px] whitespace-pre-wrap break-all text-ink">{lines.join("\n") || "(nothing)"}</pre>
    </div>
  );
}

// ---- G2: review a pull request (nothing is posted) ----

function Review() {
  const prs = useGit((s) => s.prs);
  const review = useGit((s) => s.review);
  const busy = useGit((s) => s.busy);
  const [open, setOpen] = useState(false);
  if (!open && !review)
    return (
      <button type="button" className="hud-btn self-start" onClick={() => (setOpen(true), void useGit.getState().loadPrs())}>
        Review a pull request
      </button>
    );
  return (
    <section aria-label="Review a pull request" className="border-t border-hair pt-3">
      <span className="lbl">Review a pull request</span>
      <p className="mt-1 mb-2 text-[12px] text-faint">Your agent reads the diff and lists problems here. Nothing is posted to GitHub.</p>
      {review ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-[13px] text-ink">
            {!review.done && <Spinner size={10} />}
            {review.done ? (review.findings.length ? `#${review.pr}: ${review.findings.length === 1 ? "1 thing" : `${review.findings.length} things`} to look at` : `#${review.pr} looks good`) : `Reviewing #${review.pr}…`}
          </p>
          {review.summary && <p className="text-[12.5px] text-dim">{review.summary}</p>}
          {review.findings.map((f, i) => (
            <div key={i} className="rounded-[10px] border border-violet/35 bg-black/25 p-3">
              <p className="m-0 text-[13px] leading-snug text-ink">{f.claim}</p>
              {f.file && (
                <button type="button" className="lbl mt-1.5 hover:text-ink" onClick={() => (close(), useUi.getState().openFile({ path: f.file!, line: f.line ?? 1 }))} title="Open the file here">
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </button>
              )}
            </div>
          ))}
          {review.done && (
            <button type="button" className="hud-btn self-start" onClick={() => useGit.setState({ review: null })}>
              Review another
            </button>
          )}
        </div>
      ) : prs === null && busy !== "prs" ? (
        <button type="button" className="hud-btn self-start" onClick={() => void useGit.getState().loadPrs()}>
          Try again
        </button>
      ) : prs === null ? (
        <p className="lbl flex items-center gap-2"><Spinner size={10} /> Loading pull requests</p>
      ) : prs.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {prs.map((p) => (
            <li key={p.number} className="flex items-center gap-2 text-[13px]">
              <span className="font-mono text-[11px] text-faint">#{p.number}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{p.title}</span>
              <button type="button" className="hud-btn solid" disabled={!!busy} onClick={() => void useGit.getState().reviewPr(p.number)}>
                Review
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-dim">No open pull requests in this repo.</p>
      )}
    </section>
  );
}

function GhSetup({ state }: { state: GitState }) {
  return (
    <section aria-label="Set up GitHub" className="border-t border-hair pt-3">
      <span className="lbl">GitHub isn't connected</span>
      <p className="mt-1 text-[12.5px] text-dim">
        Branches, commits and syncing work without it. Pull requests and checks need it. {GH_SETUP[state.ghProblem ?? "missing"]}
      </p>
    </section>
  );
}
