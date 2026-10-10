import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { PrThread, ScmDiff, ScmDiffLine } from "@shrike/schema";
import { api, errorMessage } from "../lib/api.ts";
import { CODE_FG, highlight, type Token } from "../lib/highlight.ts";
import { useAgent } from "../stores/agent.ts";
import { useUi } from "../stores/ui.ts";
import { VARS } from "../thread/Thread.tsx";
import { openPrPanel, usePr } from "../pr/index.ts";
import { askLine, changedRange, counts, inlineRows, paint, splitRows, type Row } from "./logic.ts";
import { useScm } from "./store.ts";

// SC6: a file's changes, split or inline, syntax coloured, the words that changed lit. Opens beside the dock, over the stage.

const AREA_WORD = { conflicts: "conflicts", staged: "staged", changes: "not staged", untracked: "new file", branch: "on this branch", commit: "in this commit" } as const;
const SPLIT_KEY = "shrike.diff.split";

type Side = Map<ScmDiffLine, Token[]>;
type Notes = Map<number, PrThread[]>; // SC8: open review threads by new-file line

/** Each side's lines highlighted as one text, so tokens keep their colours across a hunk. */
async function tokens(d: ScmDiff): Promise<Side> {
  const out: Side = new Map();
  for (const side of ["old", "new"] as const) {
    const lines = d.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "ctx" || l.kind === (side === "old" ? "del" : "add")));
    const toks = await highlight(`scm-${side}/${d.path}`, lines.map((l) => l.text).join("\n"));
    lines.forEach((l, i) => {
      if (side === "new" || l.kind === "del") out.set(l, toks[i] ?? []);
    });
  }
  return out;
}

export function DiffView() {
  const target = useScm((s) => s.diff);
  const files = useScm((s) => s.state?.files);
  const threads = usePr((s) => s.view?.threads);
  const prefix = usePr((s) => s.view?.prefix ?? "");
  const [d, setD] = useState<ScmDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [side, setSide] = useState<Side | null>(null);
  const [split, setSplit] = useState(() => {
    try {
      return localStorage.getItem(SPLIT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const close = () => useScm.setState({ diff: null });
  const box = useRef<HTMLDivElement>(null);

  // Span the space between the workspaces rail and the dock, so it never covers the rail.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el?.parentElement) return;
    const dock = el.parentElement;
    const rail = document.querySelector('[aria-label="Workspaces"]');
    const fit = () => el.style.setProperty("--scm-diff-room", `${dock.getBoundingClientRect().left - (rail?.getBoundingClientRect().right ?? 0)}px`);
    fit();
    const ro = new ResizeObserver(fit);
    if (rail) ro.observe(rail);
    ro.observe(dock);
    window.addEventListener("resize", fit);
    return () => (ro.disconnect(), window.removeEventListener("resize", fit));
  }, [!!target]);

  // Refetch on target change, and when the file list changes (the agent edited it while it was open).
  const stamp = target && files ? JSON.stringify(files.find((f) => f.path === target.path && f.area === target.area) ?? null) : "";
  useEffect(() => {
    if (!target) return;
    let live = true;
    setErr(null);
    api()
      .scmDiff(target)
      .then((x) => {
        if (!live) return;
        setD(x);
        return tokens(x).then((t) => live && setSide(t));
      })
      .catch((e: unknown) => live && (setErr(errorMessage(e)), setD(null)));
    return () => void (live = false);
  }, [target?.path, target?.area, target?.sha, stamp]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || useUi.getState().file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target]);

  const toggle = (v: boolean) => {
    setSplit(v);
    try {
      localStorage.setItem(SPLIT_KEY, v ? "1" : "0");
    } catch {}
  };

  if (!target) return null;
  const shown = d && d.path === target.path ? d : null;
  const c = shown ? counts(shown) : null;
  const ask = () => {
    if (!shown) return;
    useUi.getState().addChip({ id: `diff:${target.area}:${target.path}`, kind: "file", label: `changes · ${target.path.split("/").pop()}`, line: askLine(shown, `the ${AREA_WORD[target.area]} changes`) });
    close(); // the Ask box sits under this view
    useAgent.getState().openAndFocus();
  };
  const first = shown?.hunks[0]?.lines.find((l) => l.kind !== "del")?.new ?? 1;
  const notes: Notes = new Map();
  for (const t of threads ?? []) if (!t.resolved && t.line && t.path === prefix + target.path) notes.set(t.line, [...(notes.get(t.line) ?? []), t]);

  return (
    <div ref={box} className="fv scm-diff" style={VARS} role="dialog" aria-label={`Changes to ${target.path}`}>
      <div className="fv-head">
        <i className="dot" /><i className="dot" /><i className="dot" />
        <span className="f" title={shown?.oldPath ? `${shown.oldPath} → ${target.path}` : target.path}>{target.path}</span>
        <span className="lbl shrink-0 whitespace-nowrap">{AREA_WORD[target.area]}</span>
        {c && (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
            <span className="text-ok">+{c.added}</span> <span className="text-fail">−{c.removed}</span>
          </span>
        )}
        <span className="flex-1" />
        <span role="group" aria-label="Layout" className="flex">
          <button type="button" className={`fv-btn seg${!split ? " on" : ""}`} aria-pressed={!split} onClick={() => toggle(false)}>Inline</button>
          <button type="button" className={`fv-btn seg${split ? " on" : ""}`} aria-pressed={split} onClick={() => toggle(true)}>Split</button>
        </span>
        <button type="button" className="fv-btn scm-ask" disabled={!shown?.hunks.length} onClick={ask} aria-label="Ask about this change" title="Puts this change on the Ask box so you can ask your agent about it">
          <span aria-hidden>✦</span> Ask<span className="scm-wide"> about this change</span>
        </button>
        {target.area !== "commit" && target.area !== "branch" && (
          <button type="button" className="fv-link" onClick={() => useUi.getState().openFile({ path: target.path, line: first })} title="Open the whole file">Open file</button>
        )}
        <button type="button" className="fv-btn" onClick={close}>Esc back</button>
      </div>
      {err ? (
        <div className="fv-none">{err}</div>
      ) : !shown ? (
        <div className="fv-none">Opening {target.path}…</div>
      ) : shown.tooBig ? (
        <div className="fv-none">These changes are too big to show here. Open the file instead.</div>
      ) : shown.binary ? (
        <div className="fv-none">This is a binary file, so there are no lines to compare.</div>
      ) : !shown.hunks.length ? (
        <div className="fv-none">No line changes. It may only be a rename or a permission change.</div>
      ) : (
        <div className="fv-body">
          <div className={`scm-hunks${split ? " split" : ""}`}>
            {shown.hunks.map((h, k) => (
              <section key={k} aria-label={`Change ${k + 1}`}>
                <div className="scm-hunk-head">
                  <span>@@</span> {h.header || `line ${h.lines[0]?.new ?? h.lines[0]?.old ?? ""}`}
                </div>
                {split
                  ? splitRows(h.lines).map((r, i) => (
                      <div key={i} className="scm-srow">
                        <Cell row={r.left} side={side} n={r.left?.line.old} />
                        <Cell row={r.right} side={side} n={r.right?.line.new} notes={notes} />
                      </div>
                    ))
                  : inlineRows(h.lines).map((r, i) => <Line key={i} row={r} side={side} notes={notes} />)}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ t }: { t: PrThread }) {
  const c = t.comments[0];
  if (!c) return null;
  const words = c.body.replace(/```[\s\S]*?```/g, " ").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim();
  return (
    <button type="button" className="scm-chip" title={`${c.author}: ${words}\nOpen it in PR and checks`} onClick={() => openPrPanel()}>
      <MessageSquare size={10} aria-hidden />
      <span className="who">{c.author}:</span> {words.length > 48 ? `${words.slice(0, 47)}…` : words}
      {t.comments.length > 1 && <span className="n">+{t.comments.length - 1}</span>}
    </button>
  );
}

function Code({ row, side, notes }: { row: Row; side: Side | null; notes?: Notes }) {
  const tab = (t: string) => t.replace(/\t/g, "  "); // highlight() expands tabs the same way
  const toks = side?.get(row.line) ?? [{ content: tab(row.line.text), color: CODE_FG }];
  const parts = paint(toks, row.kind === "ctx" ? undefined : changedRange(tab(row.line.text), row.pair === undefined ? undefined : tab(row.pair)));
  return (
    <code>
      {parts.map((t, i) => (
        <span key={i} style={{ color: t.color }} className={t.lit ? "lit" : undefined}>{t.content}</span>
      ))}
      {!row.line.text && " "}
      {row.kind !== "del" && row.line.new !== undefined && notes?.get(row.line.new)?.map((t) => <Chip key={t.id} t={t} />)}
    </code>
  );
}

function Line({ row, side, notes }: { row: Row; side: Side | null; notes: Notes }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  return (
    <div className={`scm-line ${row.kind}`}>
      <i>{row.line.old ?? ""}</i>
      <i>{row.line.new ?? ""}</i>
      <b aria-hidden>{sign}</b>
      <Code row={row} side={side} notes={notes} />
    </div>
  );
}

function Cell({ row, side, n, notes }: { row?: Row; side: Side | null; n?: number; notes?: Notes }) {
  if (!row) return <div className="scm-cell empty" />;
  return (
    <div className={`scm-cell ${row.kind}`}>
      <i>{n ?? ""}</i>
      <Code row={row} side={side} {...(notes ? { notes } : {})} />
    </div>
  );
}
