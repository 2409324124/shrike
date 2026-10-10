import "./ci.css";
import { Fragment, useEffect } from "react";
import type { PreflightLeg } from "@shrike/schema";
import { useAgent, useInlineApproval } from "../../stores/agent.ts";
import { useProject } from "../../stores/project.ts";
import { cx, Spinner } from "../../components/ui.tsx";
import { Dot } from "../../components/Activity.tsx";
import { hostedLine, resultParts, short, skippedLine, touchLine } from "./logic.ts";
import { useCi } from "./store.ts";

// CI3 pre-flight panel and CI4 result card, in the Changes dock above Sync. One focal line at a time: the button, the running leg, or the verdict.

const ASK = /^Run the ".+" check here, like CI\?$/; // ci-lessons.ts preflight() approval title

export function PreflightPanel() {
  const st = useCi((s) => s.state);
  const busy = useCi((s) => s.busy);
  const note = useCi((s) => s.note);
  const root = useProject((s) => s.project?.root);
  useEffect(() => void (root && useCi.getState().load()), [root]);
  if (!st) return null;
  if (!st.ready) return null; // no CI config: nothing to pre-flight
  const run = st.run;
  const running = run?.state === "running";
  const fresh = run && !running && !run.hosted && Date.now() - run.at < 6 * 3600_000 ? run : null; // pushed: CI's answer is the news now
  const pushed = run && !running && !fresh ? hostedLine(run) : undefined;
  const red = fresh?.legs.some((l) => l.state === "fail");
  return (
    <section aria-label="Pre-flight" className={cx("ci-pf", fresh && (red ? "red" : fresh.safe ? "green" : ""))}>
      <div className="flex items-center gap-2 whitespace-nowrap">
        <span className="lbl">{running ? "Pre-flight · running" : "Pre-flight"}</span>
        <div className="flex-1" />
        <button type="button" className="ci-link" onClick={() => useCi.getState().show(true)}>See the pipeline</button>
      </div>
      {running ? <Running /> : fresh ? <Result /> : <p className="m-0 mt-1.5 text-[12.5px] text-dim">{touchLine(st)}</p>}
      {pushed && <p className={cx("m-0 mt-1 text-[11.5px]", pushed.tone === "ok" ? "text-ok" : pushed.tone === "fail" ? "text-fail" : "text-dim")}>Last push · {pushed.text}</p>}
      <Approval />
      {note && <p role={note.tone === "error" ? "alert" : "status"} className={cx("m-0 mt-1.5 text-[11.5px]", note.tone === "error" ? "text-fail" : "text-dim")}>{note.text}</p>}
      {!running && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {st.touched.length > 0 && (
            <button type="button" className={cx("btn", !fresh && "go")} disabled={!!busy && busy !== "load"} title="Runs the CI jobs your change touches here, the way CI runs them. Nothing goes to GitHub." onClick={() => void useCi.getState().run()}>
              {busy === "preflight" ? <Spinner size={10} /> : null}
              {fresh ? "Run again" : "Run pre-flight"}
            </button>
          )}
          {!st.skill && (
            <button type="button" className="hud-btn" disabled={!!busy && busy !== "load"} title="Your agent reads the CI config and its recent runs and writes how to run each job here (a Shrike skill in .shrike/skills)" onClick={() => void useCi.getState().learn()}>
              {busy === "learn" || st.busy === "learning" ? <Spinner size={10} /> : <span className="ci-agent" aria-hidden>✦</span>}
              Learn this CI
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Running() {
  const run = useCi((s) => s.state?.run);
  if (!run) return null;
  return (
    <>
      <ol className="ci-pf-legs" aria-label="Checks">
        {run.legs.map((l) => (
          <li key={l.job} className="ci-pf-leg">
            <i className="ci-st" data-tone={l.state} aria-hidden />
            <div className="min-w-0 flex-1">
              <span className={cx(l.state === "skipped" && "text-faint", l.state === "fail" && "text-fail")}>{short(l.name)}</span>
              {l.state === "skipped" && <span className="text-[11px] text-faint"> · {l.why}</span>}
              {l.state === "running" && (l.why ? <p className="ci-pf-tail">{l.why}</p> : l.tail?.length ? <p className="ci-pf-tail">{l.tail.at(-1)}</p> : l.command ? <p className="ci-pf-tail">$ {l.command}</p> : null)}
            </div>
            {l.state === "pass" && l.seconds !== undefined && <span className="font-mono text-[10px] text-faint">{l.seconds}s</span>}
          </li>
        ))}
      </ol>
      <div className="mt-2">
        <button type="button" className="hud-btn" onClick={() => void useCi.getState().stop()}>Stop</button>
      </div>
    </>
  );
}

/** CI4: "Backend typecheck ✓ · Schema migrations ✗ (the database schema) → Fix it · Dashboard tests ✓", then the verdict. */
function Result() {
  const run = useCi((s) => s.state?.run);
  const busy = useCi((s) => s.busy);
  if (!run) return null;
  const parts = resultParts(run);
  const red = run.legs.filter((l) => l.state === "fail");
  const skipped = skippedLine(run);
  const hosted = hostedLine(run);
  return (
    <>
      {run.warnings.map((w) => (
        <p key={w} className="ci-warn">{w}</p>
      ))}
      {parts.length > 0 && (
        <p className="ci-result" data-testid="ci-result">
          {parts.map((p, i) => (
            <Fragment key={p.job}>
              {i > 0 && (
                <>
                  {" "}
                  <span className="sep" aria-hidden>·</span>{" "}
                </>
              )}
              <span className="whitespace-nowrap">
                {p.name} <span className={p.state === "pass" ? "ok" : "no"} aria-label={p.state === "pass" ? "passed" : "failed"}>{p.state === "pass" ? "✓" : "✗"}</span>
              </span>
              {p.why && <span className="why"> ({p.why})</span>}
              {p.state === "fail" && (
                <span className="whitespace-nowrap">
                  {" "}
                  <span className="text-faint"> → </span>
                  <button type="button" className="hud-btn !h-5 !px-1.5" disabled={!!busy} title="Your agent finds the cause and proposes the smallest fix you approve" onClick={() => void useCi.getState().fix(p.job)}>
                    {busy === `fix:${p.job}` ? <Spinner size={9} /> : <span className="ci-agent" aria-hidden>✦</span>}
                    Fix it
                  </button>
                </span>
              )}
            </Fragment>
          ))}
        </p>
      )}
      {red.slice(0, 1).map((l) => <FailLine key={l.job} l={l} />)}
      {skipped && <p className="m-0 mt-1 text-[11px] text-faint">{skipped}</p>}
      <p className={cx("ci-verdict", red.length ? "fail" : run.safe ? "ok" : "info")} data-testid="ci-verdict">{run.verdict}</p>
      {hosted && <p className={cx("m-0 mt-1 text-[11.5px]", hosted.tone === "ok" ? "text-ok" : hosted.tone === "fail" ? "text-fail" : "text-dim")}>{hosted.tone === "info" && hosted.text.startsWith("Watching") && <Dot on tone="var(--signal)" className="mr-1.5 align-middle" />}{hosted.text}</p>}
    </>
  );
}

function FailLine({ l }: { l: PreflightLeg }) {
  return (
    <div className="ci-fail-line">
      {l.line && <code>{l.line}</code>}
      {l.fix && <p className="m-0 mt-1 text-[11.5px] leading-snug text-dim">{l.fix}</p>}
    </div>
  );
}

/** A leg waiting on Allow (R6), right here instead of on the agent's card. */
function Approval() {
  const ask = useAgent((s) => s.approvals.find((a) => !a.patch && ASK.test(a.title)));
  useInlineApproval(ask?.id);
  if (!ask) return null;
  const [lead, ...cmds] = ask.reason.split("\n\n");
  return (
    <div role="group" aria-label="Allow this?" className="ci-approval">
      <p className="m-0 text-[12.5px] text-ink">{ask.title}</p>
      <p className="m-0 mt-1 text-[11.5px] text-dim">{lead}</p>
      <pre>{cmds.join("\n\n")}</pre>
      <div className="flex gap-2">
        <button type="button" className="btn go" onClick={() => void useAgent.getState().answer(ask.id, true)}>Allow</button>
        <button type="button" className="btn" onClick={() => void useAgent.getState().answer(ask.id, false)}>Not now</button>
      </div>
    </div>
  );
}
