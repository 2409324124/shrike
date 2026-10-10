import "./ci.css";
import { useEffect } from "react";
import { RefreshCw, X } from "lucide-react";
import type { CiJob } from "@shrike/schema";
import { cx, IconButton, Spinner } from "../../components/ui.tsx";
import { useCalm } from "../../system/System.tsx";
import { jobLine, jobTone, lanes, recordLine, short, sideBySide, skillLine } from "./logic.ts";
import { useCi } from "./store.ts";

// CI1 pipeline thread, CI2 lessons chip, CI5 local vs hosted (the first mismatch snaps), CI6 track record. Beside the dock, over the stage.

export function PipelineView() {
  const open = useCi((s) => s.open);
  const st = useCi((s) => s.state);
  const busy = useCi((s) => s.busy);
  const focus = useCi((s) => s.focus);
  useEffect(() => {
    if (!open) return;
    if (!st) void useCi.getState().load();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useCi.getState().show(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const p = st?.pipeline;
  const job = p?.jobs.find((j) => j.id === focus);
  const reading = busy === "load" || st?.busy === "reading";
  return (
    <section role="dialog" aria-label="CI lessons" className="glass solid ci-view">
      <header className="ci-head">
        <span className="lbl text-ink">CI lessons</span>
        <div className="flex-1" />
        <IconButton label="Read the CI config and its runs again" disabled={reading} onClick={() => void useCi.getState().load(true)}>
          {reading ? <Spinner size={11} /> : <RefreshCw size={12} />}
        </IconButton>
        <IconButton label="Close (Esc)" onClick={() => useCi.getState().show(false)}>
          <X size={13} />
        </IconButton>
      </header>
      <div className="ci-view-scroll">
        {!st ? (
          <p className="lbl flex items-center gap-2 py-4"><Spinner size={11} /> Reading your CI</p>
        ) : !st.ready ? (
          <p className="py-4 text-[13px] text-dim">{st.problem ?? "Shrike found no CI config it can read here."}</p>
        ) : (
          <>
            <Record />
            <Versus />
            <Thread />
            {job && <Detail job={job} />}
            {p?.history.problem && <p className="mt-3 text-[11.5px] text-faint">{p.history.problem}</p>}
            {p && <p className="micro mt-4 text-[9.5px] leading-relaxed text-faint">Read from {p.files.join(" · ")}{p.history.runs ? ` and ${p.history.runs} CI runs` : ""}</p>}
          </>
        )}
      </div>
    </section>
  );
}

/** CI6 and CI2: the one number that matters, then the lessons skill. */
function Record() {
  const st = useCi((s) => s.state)!;
  const busy = useCi((s) => s.busy);
  const r = recordLine(st.record);
  const measured = st.record.pushes.some((x) => x !== "waiting");
  return (
    <div className="ci-record">
      <div className="flex items-center gap-3.5">
        <span className={cx("ci-num", !measured ? "idle" : r.n ? "slow" : "ok")} data-testid="ci-record">{measured ? r.n : "–"}</span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[13px] text-ink">{r.line}</p>
          {st.record.pushes.length > 0 && (
            <div className="ci-dots" aria-label="Your last pushes">
              {st.record.pushes.map((x, i) => (
                <i key={i} className={cx("ci-dot", x)} title={x === "clean" ? "CI agreed, all green" : x === "surprise" ? "CI went red where pre-flight was green" : x === "caught" ? "Pre-flight caught it before CI" : "Waiting on CI"} />
              ))}
              {st.record.streak > 1 && <span className="micro ml-1.5 text-[9.5px] whitespace-nowrap text-ok">{st.record.streak} clean in a row</span>}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {st.skill ? (
          <span className="ci-chip" title="The Shrike skill pre-flight follows, in .shrike/skills/ci-lessons.md">
            ci-lessons v{st.skill.version}
            <span className="text-faint">· {skillLine(st.skill.lessons, st.pipeline)}{st.skill.pending ? " · 1 trying" : ""}</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-faint">Not learned yet</span>
        )}
        <button type="button" className="hud-btn" disabled={!!busy && busy !== "load"} title="Your agent reads the CI config and its recent runs and writes how to run each job here. A change is kept once a pre-flight matches CI." onClick={() => void useCi.getState().learn()}>
          {busy === "learn" || st.busy === "learning" ? <Spinner size={10} /> : <span className="ci-agent" aria-hidden>✦</span>}
          {st.skill ? "Learn again" : "Learn this CI"}
        </button>
      </div>
    </div>
  );
}

/** CI5: pre-flight beside GitHub for the last push; the first row that differs snaps red. */
function Versus() {
  const run = useCi((s) => s.state?.run ?? null);
  const calm = useCalm();
  const { rows } = sideBySide(run);
  if (!rows.length) return null;
  const firstRow = rows.findIndex((r) => r.differs);
  return (
    <section aria-label="Your computer and GitHub" className="mb-4">
      <span className="lbl">Last push · pre-flight and CI</span>
      <table className="ci-vs mt-2">
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">You</th>
            <th scope="col" aria-hidden />
            <th scope="col">GitHub</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.job} className={cx(i === firstRow && "snap")} data-differs={r.differs || undefined}>
              <td>{short(r.name)}</td>
              <td className="st"><i className="ci-st" data-tone={r.local} aria-label={`Here: ${r.local}`} /></td>
              <td className="link"><span className={cx("bar", !r.differs && r.local === r.hosted && r.local !== "none" && "match")} /></td>
              <td className="st">
                {i === firstRow ? (
                  <span className="ci-snap">
                    <i className="ci-st" data-tone="fail" aria-label="On GitHub: failed" />
                    {!calm && <span className="ring" aria-hidden />}
                    {!calm && Array.from({ length: 12 }, (_, k) => <span key={k} className="spark" style={{ "--a": `${k * 30}deg` } as React.CSSProperties} aria-hidden />)}
                  </span>
                ) : (
                  <i className="ci-st" data-tone={r.hosted} aria-label={`On GitHub: ${r.hosted}`} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** CI1: stages as lanes, jobs as stations; the jobs this change touches carry a cyan dot. */
function Thread() {
  const st = useCi((s) => s.state)!;
  const focus = useCi((s) => s.focus);
  const touched = new Set(st.touched);
  return (
    <section aria-label="Your CI" className="ci-lanes">
      {lanes(st.pipeline!).map((lane) => (
        <div key={lane.stage} className="ci-lane">
          <div className="ci-lane-head">
            <span className="lbl">{lane.label}</span>
          </div>
          <div className="ci-lane-body">
            {lane.groups.map((g) => (
              <div key={g.workflow}>
                <p className="ci-wf">{g.workflow}</p>
                {g.jobs.map((j) => (
                  <button key={j.id} type="button" className={cx("ci-job", j.off && "off", focus === j.id && "on")} aria-pressed={focus === j.id} onClick={() => useCi.getState().show(true, focus === j.id ? null : j.id)} title={j.off ?? `${j.name}: ${jobLine(j)}`}>
                    <i className="ci-st" data-tone={jobTone(j)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="name">{short(j.name)}</span>
                      <span className="meta">{jobLine(j)}</span>
                    </span>
                    {touched.has(j.id) && <i className="ci-touch" aria-label="Your change touches it" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Detail({ job: j }: { job: CiJob }) {
  const run = j.steps.filter((s) => s.local === "run" && s.run);
  const not = j.steps.filter((s) => s.local !== "run" && !/checks out the code/.test(s.why ?? ""));
  const scope = j.scope.filter((s) => !s.startsWith(".github/"));
  return (
    <section aria-label={`How ${short(j.name)} runs`} className="ci-detail">
      <b className="block font-display text-[15px] font-semibold text-ink">{short(j.name)}</b>
      <span className="micro text-[9.5px] text-faint">{j.workflow} · {j.file}</span>
      {j.off && <p className="m-0 mt-1 text-[12px] text-dim">{j.off}.</p>}
      {run.length > 0 && (
        <>
          <p className="lbl mt-3 mb-0">Here, the way CI runs it</p>
          <ol className="ci-cmds">
            {run.map((s, i) => (
              <li key={i}>{s.cwd ? `cd ${s.cwd} && ` : ""}{s.run}</li>
            ))}
          </ol>
        </>
      )}
      <p className="ci-facts">
        Runs for {j.paths?.length ? j.paths.join(", ") : scope.length ? scope.join(", ") : "every change"}.
        {j.node && ` Node ${j.node}.`}
        {Object.keys(j.env).length > 0 && ` Env ${Object.entries(j.env).map(([k, v]) => `${k}=${v}`).join(" ")}.`}
        {j.services.length > 0 && ` Needs ${j.services.map((s) => `${s.image ?? s.name}${s.port ? ` on ${s.port}` : ""}`).join(", ")}.`}
        {j.secrets.length > 0 && ` CI secrets: ${j.secrets.join(", ")}.`}
      </p>
      {not.length > 0 && <p className="ci-facts">Not here: {not.map((s) => `${s.name} (${s.why?.replace(/\.$/, "")})`).join("; ")}.</p>}
      {j.stats?.last && (
        <p className="ci-facts">
          <span className="text-fail">Last failed on {j.stats.last.kind}:</span> <span className="font-mono text-[11px]">{j.stats.last.line}</span>
        </p>
      )}
    </section>
  );
}
