import { useMemo, useState } from "react";
import type { ActionView } from "@shrike/schema";
import { Spinner } from "../components/ui.tsx";
import { formatBytes } from "../lib/format.ts";
import { cacheMarks, formatTtl, type CacheMark } from "./logic.ts";
import { Problem, Quiet, useDebounced, useLook } from "./look.tsx";

const MARK_WORD: Record<CacheMark, string> = { hit: "hit", miss: "miss", set: "saved", delete: "removed" };

/** I4: the cache's keys with value previews, size and time left; this click's hits and misses lit. */
export function CacheView({ placeId, view, tick }: { placeId: string; view?: ActionView; tick: number }) {
  const [search, setSearch] = useState("");
  const match = useDebounced(search.trim(), 250);
  const [open, setOpen] = useState<string | null>(null);
  const marks = useMemo(() => cacheMarks(view, placeId), [view, placeId]);
  const keys = useLook<"cacheKeys">({ op: "cacheKeys", placeId, match: match || undefined }, [placeId, match, tick]);

  if (keys.error && !keys.data) return <Problem text={keys.error} again={keys.again} />;
  if (!keys.data) return <Quiet text="Reading the cache" busy />;
  const { entries, system, size, max } = keys.data;
  const present = new Set(entries.map((e) => e.key));
  const missing = [...marks].filter(([k, m]) => m === "miss" && !present.has(k) && (!match || k.includes(match)));
  const summary = [...marks.values()].reduce<Record<string, number>>((n, m) => ((n[m] = (n[m] ?? 0) + 1), n), {});

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="insp-bar">
        <input type="search" className="insp-search" placeholder="Search keys" aria-label="Search keys" value={search} onChange={(e) => setSearch(e.target.value)} />
        {keys.loading && <Spinner size={10} className="text-faint" />}
      </div>
      <p className="insp-how">
        Read only · {system === "lru" ? "peeked, so nothing moves up the queue" : "a separate read-only connection"} · {size}
        {max ? ` of ${max}` : ""} {(max ?? size) === 1 ? "entry" : "entries"}
        {view && marks.size ? ` · this click: ${Object.entries(summary).map(([m, c]) => `${c} ${MARK_WORD[m as CacheMark]}`).join(", ")}` : ""}
      </p>
      <ul className="min-h-0 flex-1 overflow-auto" aria-label="Cache entries">
        {missing.map(([k]) => (
          <li key={`miss:${k}`} className="insp-call focus">
            <div className="flex items-center gap-2 px-2.5 py-2 font-mono text-[11px] text-ink">
              <i className="insp-mark miss" aria-hidden />
              <span className="min-w-0 truncate">{k}</span>
              <span className="ml-auto text-slow">miss · not in the cache now</span>
            </div>
          </li>
        ))}
        {entries.map((e) => {
          const mark = marks.get(e.key);
          return (
            <li key={e.key} className={`insp-call${mark ? " focus" : ""}`} data-mark={mark}>
              <button type="button" aria-expanded={open === e.key} onClick={() => setOpen((o) => (o === e.key ? null : e.key))}>
                {mark ? <i className={`insp-mark ${mark}`} aria-label={MARK_WORD[mark]} /> : <i className="insp-mark" aria-hidden />}
                <span className="shrink-0 text-ink">{e.key}</span>
                <span className="min-w-0 flex-1 truncate">{e.preview}</span>
                {mark && <span className={mark === "hit" ? "good" : mark === "miss" ? "text-slow" : ""}>{MARK_WORD[mark]}</span>}
                <span className="shrink-0 text-faint">{formatTtl(e.ttlMs)}</span>
                {e.bytes !== undefined && <span className="shrink-0 text-faint">{formatBytes(e.bytes)}</span>}
              </button>
              {open === e.key && <Value placeId={placeId} k={e.key} tick={tick} />}
            </li>
          );
        })}
        {!entries.length && !missing.length && <Quiet text={match ? `No keys match "${match}".` : "The cache is empty."} />}
      </ul>
    </div>
  );
}

function Value({ placeId, k, tick }: { placeId: string; k: string; tick: number }) {
  const v = useLook<"cacheGet">({ op: "cacheGet", placeId, key: k }, [placeId, k, tick]);
  return <pre className="insp-out max-h-[240px] overflow-auto px-2.5 pb-2.5">{v.error ?? v.data?.value ?? "Reading"}</pre>;
}
