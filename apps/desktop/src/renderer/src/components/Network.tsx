import { useMemo, useState } from "react";
import type { ActionView, DebugEvent } from "@shrike/schema";
import { useActions } from "../stores/actions.ts";
import { byteLength, formatBytes, formatDuration, httpPath, isBackgroundAction, prettyBody, statusWords } from "../lib/format.ts";
import { focusEvent } from "../hud/commands.ts";
import { CodeBlock, cx, Empty, MethodTag, Pairs, Tabs } from "./ui.tsx";

interface NetRow {
  event: DebugEvent;
  action: ActionView;
}

/** Browser requests, plus server requests no browser request led to (explorer, agent, curl). */
function useNetworkRows(): NetRow[] {
  const byId = useActions((s) => s.byId);
  const order = useActions((s) => s.order);
  return useMemo(() => {
    const out: NetRow[] = [];
    for (const id of order) {
      const a = byId[id];
      if (!a || isBackgroundAction(a)) continue;
      const visit = (nodes: ActionView["tree"], underHttp: boolean) => {
        for (const n of nodes) {
          const isHttp = n.event.kind === "http_request" && !!n.event.http;
          if (isHttp && (n.event.origin === "browser" || !underHttp)) out.push({ event: n.event, action: a });
          visit(n.children ?? [], underHttp || isHttp);
        }
      };
      visit(a.tree ?? [], false);
    }
    return out.sort((x, y) => y.event.startMs - x.event.startMs);
  }, [byId, order]);
}

const tone = (code: number | undefined) => (code == null || code === 0 || code >= 500 ? "text-fail" : code >= 400 ? "text-slow" : "text-dim");

export function NetworkSheet() {
  const rows = useNetworkRows();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.event.id === openId);

  if (rows.length === 0) return <Empty title="No calls to the server yet.">Calls your app makes show up here with their status and timing.</Empty>;

  return (
    <div className="flex h-full">
      <div className={cx("min-w-0 overflow-auto px-1.5 pb-2", open ? "w-[46%] border-r border-hair" : "flex-1")}>
        <table className="w-full table-fixed border-collapse text-[12px]">
          <tbody>
            {rows.slice(0, 2000).map((r) => {
              const h = r.event.http!;
              const on = r.event.id === openId;
              return (
                <tr
                  key={r.event.id}
                  onClick={() => {
                    setOpenId(on ? null : r.event.id);
                    focusEvent(r.action.id, r.event.id);
                  }}
                  aria-selected={on}
                  className={cx("h-7 cursor-pointer", on ? "bg-signal/[0.07]" : "hover:bg-white/[0.04]")}
                >
                  <td className="rounded-l-[6px] pr-3 pl-2">
                    <div className="flex items-center">
                      <MethodTag method={h.method} />
                      <span className="truncate font-mono text-[11.5px] text-ink" title={h.url}>
                        {httpPath(h.url)}
                      </span>
                    </div>
                  </td>
                  <td className={cx("w-[150px] truncate pr-2", tone(h.status))}>{statusWords(h.status)}</td>
                  {!open && <td className="w-[64px] pr-2 text-right font-mono text-[11px] text-dim tabular-nums">{formatDuration(r.event.durationMs)}</td>}
                  {!open && <td className="w-[72px] rounded-r-[6px] pr-2 text-right font-mono text-[11px] text-faint tabular-nums">{h.resBody != null ? formatBytes(byteLength(h.resBody)) : ""}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && <Detail key={open.event.id} row={open} />}
    </div>
  );
}

function Detail({ row }: { row: NetRow }) {
  const [tab, setTab] = useState<"response" | "request" | "headers">("response");
  const e = row.event;
  const h = e.http!;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 pt-1 text-[12px]">
        <span className={tone(h.status)}>{statusWords(h.status)}</span>
        <span className="font-mono text-[11px] text-dim">{formatDuration(e.durationMs)}</span>
        <div className="flex-1" />
        <Tabs label="Call details" value={tab} onChange={setTab} tabs={[{ id: "response", label: "Response" }, { id: "request", label: "Request" }, { id: "headers", label: "Headers" }]} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "response" && (h.resBody ? <CodeBlock>{prettyBody(h.resBody)}</CodeBlock> : <p className="text-[12px] text-dim">No response body.</p>)}
        {tab === "request" && (h.reqBody ? <CodeBlock>{prettyBody(h.reqBody)}</CodeBlock> : <p className="text-[12px] text-dim">No request body.</p>)}
        {tab === "headers" && (
          <div className="flex flex-col gap-4">
            <section>
              <h4 className="micro mb-2 text-faint">Response headers</h4>
              <Pairs data={h.resHeaders} />
            </section>
            <section>
              <h4 className="micro mb-2 text-faint">Request headers</h4>
              <Pairs data={h.reqHeaders} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
