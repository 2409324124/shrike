import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { DebugEvent } from "@shrike/schema";
import { useUi, type Sheet as SheetId } from "../stores/ui.ts";
import { useActions } from "../stores/actions.ts";
import { tripFor, useThread } from "../stores/thread.ts";
import { formatDuration, prettyBody, statusWords } from "../lib/format.ts";
import { eventsById, stationLoc } from "./logic.ts";
import { CodeBlock, IconButton, Kbd, Pairs } from "../components/ui.tsx";
import { LogsSheet } from "../components/Logs.tsx";
import { NetworkSheet } from "../components/Network.tsx";
import { ApiSheet } from "../components/ApiExplorer.tsx";
import { TerminalSheet } from "../components/Terminal.tsx";
import { openFocusedFile } from "./commands.ts";

const SHEETS: Record<NonNullable<SheetId>, { title: string; key: string; body: () => ReactNode }> = {
  logs: { title: "Logs", key: "G", body: () => <LogsSheet /> },
  network: { title: "Network", key: "N", body: () => <NetworkSheet /> },
  api: { title: "API client", key: "A", body: () => <ApiSheet /> }, // AP: taller, it holds a whole workspace
  terminal: { title: "Terminal", key: "`", body: () => <TerminalSheet /> },
  details: { title: "Details", key: "D", body: () => <Details /> },
};

/** One summoned sheet at a time over the bottom 45% of the feed. Esc closes. */
export function Sheet() {
  const overlay = useUi((s) => s.sheet);
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem("shrike.api.wide") === "1";
    } catch {
      return false;
    }
  });
  const sheet = overlay ? SHEETS[overlay] : undefined;
  if (!sheet) return null;
  const full = overlay === "api" && wide; // AP: the API client can take the whole window, like Bruno
  const toggle = () => {
    setWide(!wide);
    try {
      localStorage.setItem("shrike.api.wide", wide ? "0" : "1");
    } catch {}
  };
  const el = (
    <section
      key={overlay}
      aria-label={sheet.title}
      className={
        full
          ? "glass solid @container sheet-in fixed inset-x-3 top-14 bottom-3 z-[46] flex flex-col rounded-[var(--r-card)] shadow-[0_20px_60px_var(--void)]"
          : `glass solid @container sheet-in absolute inset-x-2 bottom-0 z-30 flex ${overlay === "api" ? "h-[82%] min-h-[360px]" : "h-[45%] min-h-[240px]"} flex-col rounded-t-[var(--r-card)] border-b-0 shadow-[0_-20px_60px_var(--void)]`
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-2.5 pr-2 pl-4">
        <span className="lbl text-ink">{sheet.title}</span>
        <Kbd>{sheet.key}</Kbd>
        <div className="flex-1" />
        <span className="micro hidden text-[9.5px] whitespace-nowrap text-faint @sm:inline">Esc closes</span>
        {overlay === "api" && (
          <IconButton label={full ? "Back over the Thread" : "Use the whole window"} onClick={toggle}>
            {full ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </IconButton>
        )}
        <IconButton label={`Close ${sheet.title}`} onClick={() => useUi.setState({ sheet: null })}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">{sheet.body()}</div>
    </section>
  );
  return full ? createPortal(el, document.body) : el;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="micro mb-2 text-faint">{title}</h4>
      {children}
    </section>
  );
}

function body(s: string | undefined) {
  return s ? <CodeBlock className="max-h-[220px]">{prettyBody(s)}</CodeBlock> : <p className="text-[12px] text-dim">None.</p>;
}

function Details() {
  const focus = useThread((s) => s.focus);
  const view = useActions((s) => (focus.actionId ? s.byId[focus.actionId] : undefined));
  const st = view && focus.actionId ? tripFor(focus.actionId)?.stations[focus.station] : undefined;
  const e: DebugEvent | undefined = view && st ? eventsById(view).get(st.id) : undefined;
  if (!view || !st || !e) return <p className="px-4 text-[12.5px] text-dim">Pick a step on the thread first.</p>;
  const loc = stationLoc(view, st);
  return (
    <div className="h-full overflow-auto px-4 pb-4">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="font-display text-[15px] text-ink">{st.caption}</p>
        <span className="font-mono text-[11px] text-dim">{formatDuration(e.durationMs)}</span>
        {loc && (
          <button type="button" className="font-mono text-[11px] text-signal hover:underline" onClick={openFocusedFile} title="Open the file here (E)">
            {loc.precision === "approximate" ? "roughly " : ""}
            {loc.file}:{loc.line}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5">
        {e.args && e.args.length > 0 && (
          <Block title="Arguments">
            <CodeBlock>{e.args.join("\n")}</CodeBlock>
          </Block>
        )}
        {e.returned != null && <Block title="Returned">{body(e.returned)}</Block>}
        {e.error && (
          <Block title="Where it broke">
            <CodeBlock className="text-fail">{[e.error.message, e.error.stack?.split("\n").slice(1).join("\n")].filter(Boolean).join("\n")}</CodeBlock>
          </Block>
        )}
        {e.db && (
          <Block title="Database">
            <CodeBlock>{e.db.statement + (e.db.params ? `\n\nvalues ${e.db.params}` : "")}</CodeBlock>
          </Block>
        )}
        {e.log && (
          <Block title={`Log (${e.log.level})`}>
            <CodeBlock>{e.log.message}</CodeBlock>
          </Block>
        )}
        {e.http && (
          <>
            <Block title="Call">
              <p className="font-mono text-[12px] text-ink">
                {e.http.method} {e.http.url}
              </p>
              <p className="mt-1 text-[12px] text-dim">{e.http.status != null ? statusWords(e.http.status) : "No response"}</p>
            </Block>
            <Block title="Request body">{body(e.http.reqBody)}</Block>
            <Block title="Response body">{body(e.http.resBody)}</Block>
            <Block title="Request headers">
              <Pairs data={e.http.reqHeaders} />
            </Block>
            <Block title="Response headers">
              <Pairs data={e.http.resHeaders} />
            </Block>
          </>
        )}
      </div>
    </div>
  );
}
