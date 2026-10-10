import { useMemo, useState } from "react";
import type { Place } from "@shrike/schema";
import { CodeBlock, Label, MethodTag } from "../components/ui.tsx";
import { clockTime, formatDuration, httpPath, prettyBody, statusWords } from "../lib/format.ts";
import { useActions } from "../stores/actions.ts";
import { outsideCalls } from "./logic.ts";
import { Quiet } from "./look.tsx";

/** I6: every request this session sent to that host, newest first; the focused trip's call open. */
export function OutsideView({ place, actionId }: { place: Place; actionId?: string }) {
  const byId = useActions((s) => s.byId);
  const calls = useMemo(() => outsideCalls(Object.values(byId), place.id), [byId, place.id]);
  const [open, setOpen] = useState<string | null>(null);
  const focused = calls.find((c) => c.actionId === actionId)?.event.id;
  const shown = open ?? focused;

  if (!calls.length) return <Quiet text={`Your app hasn't called ${place.detail ?? place.name} yet in this session.`} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="insp-how pt-2">
        {calls.length} {calls.length === 1 ? "call" : "calls"} to {place.detail ?? place.name} · newest first
      </p>
      <ul className="min-h-0 flex-1 overflow-auto" aria-label={`Calls to ${place.detail ?? place.name}`}>
        {calls.map(({ actionId: a, event: e }) => {
          const st = e.http?.status;
          const bad = e.status === "error" || (st ?? 0) >= 400;
          return (
            <li key={e.id} className={`insp-call${a === actionId ? " focus" : ""}`}>
              <button type="button" aria-expanded={shown === e.id} onClick={() => setOpen(shown === e.id ? "" : e.id)}>
                <MethodTag method={e.http?.method ?? "GET"} />
                <span className="min-w-0 flex-1 truncate text-ink">{httpPath(e.http?.url ?? e.name)}</span>
                <span className={bad ? "bad" : "good"}>{st ? statusWords(st) : (e.error?.message ?? "No response")}</span>
                <span className="shrink-0 text-faint">{formatDuration(e.durationMs)}</span>
                <span className="shrink-0 text-faint">{clockTime(e.startMs)}</span>
              </button>
              {shown === e.id && (
                <div className="flex flex-col gap-2 px-2.5 pb-3">
                  {e.error && <p className="text-[12px] text-fail">{e.error.message}</p>}
                  <Label>Sent</Label>
                  <CodeBlock className="max-h-[160px]">{prettyBody(e.http?.reqBody) || "(no body)"}</CodeBlock>
                  <Label>{st ? `Answered ${statusWords(st)}` : "No answer"}</Label>
                  <CodeBlock className="max-h-[220px]">{prettyBody(e.http?.resBody) || "(no body)"}</CodeBlock>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
