import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { FileNode } from "@shrike/schema";
import { useActions } from "../stores/actions.ts";
import { useProject } from "../stores/project.ts";
import { tripOrder } from "../stores/thread.ts";
import { useUi } from "../stores/ui.ts";
import { clockTime, isBackgroundAction } from "../lib/format.ts";
import { cx, MethodTag } from "../components/ui.tsx";
import { rankQuick } from "./logic.ts";
import { focusEvent, viewTrip } from "./commands.ts";
import { keys } from "../lib/platform.ts";

// ⌘P (O5): one list over files, trips, routes and log lines. Keyboard first, 8 results at most.

interface Item {
  key: string;
  kind: "file" | "trip" | "route" | "log";
  label: string; // what the fuzzy match runs on
  exact?: boolean; // match the typed words as they are (log lines)
  detail?: string;
  tone?: "error" | "ok";
  method?: string;
  go(): void;
}

const KIND: Record<Item["kind"], string> = { file: "File", trip: "Trip", route: "Route", log: "Log" };

function flatten(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) n.dir ? flatten(n.children ?? [], out) : out.push(n.path);
  return out;
}

function useItems(open: boolean): Item[] {
  const byId = useActions((s) => s.byId);
  const files = useProject((s) => s.files);
  const routes = useProject((s) => s.project?.routes);
  return useMemo(() => {
    if (!open) return [];
    const ui = useUi.getState();
    const trips: Item[] = tripOrder()
      .reverse()
      .flatMap((id) => {
        const a = byId[id];
        return a ? [{ key: `t:${id}`, kind: "trip" as const, label: a.label, detail: `${a.status === "error" ? "broke" : a.status === "slow" ? "slow" : "worked"} · ${clockTime(a.startMs)}`, tone: a.status === "error" ? ("error" as const) : ("ok" as const), go: () => viewTrip(id) }] : [];
      });
    const rts: Item[] = (routes ?? []).map((r) => ({
      key: `r:${r.method} ${r.path}`,
      kind: "route",
      label: `${r.method} ${r.path}`,
      method: r.method,
      detail: r.handler ? `${r.handler.file.split("/").pop()}:${r.handler.line}` : undefined,
      go: () => {
        ui.prefillExplorer({ method: r.method, url: r.path });
        useUi.setState({ sheet: "api", file: null });
      },
    }));
    const fls: Item[] = flatten(files).map((path) => ({ key: `f:${path}`, kind: "file", label: path, go: () => ui.openFile({ path, line: 1 }) }));
    const logs: Item[] = [];
    for (const a of Object.values(byId)) {
      if (!a) continue;
      const bg = isBackgroundAction(a);
      const walk = (nodes: typeof a.tree) => {
        for (const n of nodes) {
          const e = n.event;
          if (e.kind === "log" && e.log) logs.push({ key: `l:${e.id}`, kind: "log", label: e.log.message.slice(0, 160), exact: true, detail: e.source ? `${e.source.file.split("/").pop()}:${e.source.line}` : undefined, tone: e.log.level === "error" ? "error" : undefined, go: () => (bg ? useUi.setState({ sheet: "logs" }) : focusEvent(a.id, e.id)) });
          walk(n.children ?? []);
        }
      };
      walk(a.tree ?? []);
    }
    return [...trips, ...rts, ...fls, ...logs];
  }, [open, byId, files, routes]);
}

export function QuickOpen() {
  const open = useUi((s) => s.quickOpen);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const items = useItems(open);
  const shown = useMemo(() => rankQuick(q, items, 8), [q, items]);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQ(""); // on close too, so the next open never shows (or merges with) the last query
    setSel(0);
    if (open) setTimeout(() => ref.current?.focus(), 0);
  }, [open]);
  useEffect(() => setSel(0), [q]);

  if (!open) return null;
  const close = () => useUi.setState({ quickOpen: false });
  const pick = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.go();
  };

  return (
    <div className="absolute inset-0 z-50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="Quick open" className="glass solid rise absolute top-14 left-1/2 w-[min(560px,92%)] -translate-x-1/2 overflow-hidden rounded-[var(--r-card)] shadow-[0_30px_80px_var(--void)]">
        <div className="flex items-center gap-2.5 border-b border-hair px-4 py-3">
          <Search size={14} className="text-signal" aria-hidden />
          <input
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (shown.length) setSel((i) => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(shown[sel]);
              }
            }}
            placeholder="Find a file, trip, route or log line"
            aria-label="Find a file, trip, route or log line"
            role="combobox"
            aria-expanded
            aria-controls="quick-list"
            aria-activedescendant={shown[sel] ? `qo-${sel}` : undefined}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-display text-[14px] font-medium text-ink outline-none placeholder:text-dim"
          />
          <span className="micro text-[9.5px] text-faint">{keys("⌘P")}</span>
        </div>
        <ul id="quick-list" role="listbox" aria-label="Results" className="py-1">
          {shown.length === 0 && <li className="px-4 py-3 text-[12.5px] text-dim">Nothing matches "{q}".</li>}
          {shown.map((it, i) => (
            <li
              key={it.key}
              id={`qo-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(it);
              }}
              className={cx("flex cursor-pointer items-center gap-3 px-4 py-[7px]", i === sel && "bg-signal/[0.07]")}
            >
              <span className={cx("lbl w-[44px] shrink-0 text-[9.5px]", i === sel ? "text-signal" : "text-faint")}>{KIND[it.kind]}</span>
              {it.method && <MethodTag method={it.method} />}
              <span className={cx("min-w-0 flex-1 truncate text-[13px]", it.kind === "file" || it.kind === "log" ? "font-mono text-[12px]" : "", it.tone === "error" && it.kind === "log" ? "text-fail" : "text-ink")}>
                {it.method ? it.label.slice(it.method.length + 1) : it.label}
              </span>
              {it.detail && <span className={cx("shrink-0 font-mono text-[10.5px]", it.kind === "trip" && it.tone === "error" ? "text-fail" : "text-faint")}>{it.detail}</span>}
            </li>
          ))}
        </ul>
        <p className="micro border-t border-hair px-4 py-2 text-[9.5px] text-faint" aria-hidden>
          ↑ ↓ choose · Enter open · Esc close
        </p>
      </div>
    </div>
  );
}
