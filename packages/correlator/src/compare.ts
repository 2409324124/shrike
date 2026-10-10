import type { ActionView, TimelineNode } from "@shrike/schema";
import { allEvents, errMsg, fmtMs, httpStatus, isFailure, reqName, topRequests, trunc, withWord } from "./util.ts";

interface Req {
  key: string;
  status?: number;
  failed: boolean;
  ms?: number;
  body?: string;
}

function requests(view: ActionView): Req[] {
  const seen = new Map<string, number>();
  return topRequests(view.tree).map((n: TimelineNode) => {
    const e = n.event;
    const base = e.http ? `${e.http.method} ${e.http.url.replace(/[?#].*$/, "")}` : e.name;
    const i = seen.get(base) ?? 0;
    seen.set(base, i + 1);
    const server = n.children.find((c) => c.event.kind === "http_request")?.event;
    return {
      key: i ? `${base} #${i + 1}` : base,
      status: httpStatus(n),
      failed: e.status === "error",
      ms: e.durationMs,
      body: e.http?.resBody ?? server?.http?.resBody,
    };
  });
}

const errors = (view: ActionView): string[] => [
  ...new Set(
    allEvents(view.tree)
      .filter(isFailure)
      .map((e) => trunc(e.kind === "error" ? `Error: ${errMsg(e)}` : `${e.name} failed: ${errMsg(e) || "unknown error"}`, 160)),
  ),
];

const statusText = (r: Req | undefined): string =>
  !r ? "not sent" : r.status !== undefined ? withWord(r.status) : r.failed ? "no response" : "pending";

const header = (v: ActionView): string => `${v.label} · ${v.status}${v.complete ? "" : " (still running)"} · ${fmtMs(v.durationMs)}`;

export function compareActions(before: ActionView, after: ActionView): string {
  const out = [`Before: Action ${before.id} · ${header(before)}`, `After: Action ${after.id} · ${header(after)}`];

  const b = requests(before);
  const a = requests(after);
  const keys = [...new Set([...b.map((r) => r.key), ...a.map((r) => r.key)])];
  let changed: { key: string; after: Req } | undefined;
  const bodyLines: string[] = [];
  if (keys.length) out.push("Requests:");
  for (const key of keys) {
    const rb = b.find((r) => r.key === key);
    const ra = a.find((r) => r.key === key);
    const same = rb && ra && statusText(rb) === statusText(ra);
    const ms = rb?.ms !== undefined && ra?.ms !== undefined ? ` (${fmtMs(rb.ms)} → ${fmtMs(ra.ms)})` : "";
    out.push(`  ${key}: ${same ? `${statusText(ra)}, unchanged` : `${statusText(rb)} → ${statusText(ra)}`}${ms}`);
    if (!same && ra && !changed) changed = { key, after: ra };
    if (rb && ra && (rb.body ?? "") !== (ra.body ?? "")) bodyLines.push(`  ${key}: ${trunc(rb.body ?? "(empty)", 120)} → ${trunc(ra.body ?? "(empty)", 120)}`);
  }

  const eb = errors(before);
  const ea = errors(after);
  const gone = eb.filter((x) => !ea.includes(x));
  const added = ea.filter((x) => !eb.includes(x));
  out.push(gone.length ? "Errors gone:" : "Errors gone: none", ...gone.map((x) => `  - ${x}`));
  out.push(added.length ? "Errors added:" : "Errors added: none", ...added.map((x) => `  - ${x}`));
  if (bodyLines.length) out.push("Responses changed:", ...bodyLines);
  const fb = before.flags.map((f) => f.kind);
  const fa = after.flags.map((f) => f.kind);
  if (fb.join() !== fa.join()) out.push(`Flags: ${fb.join(", ") || "none"} → ${fa.join(", ") || "none"}`);
  out.push(`Took ${fmtMs(before.durationMs)} → ${fmtMs(after.durationMs)}`);

  const bErr = before.status === "error";
  const aErr = after.status === "error";
  const now = changed ? `, ${changed.key} now ${changed.after.status ?? statusText(changed.after)}` : "";
  const firstBad = (v: ActionView, list: string[]) =>
    list[0] ?? requests(v).find((r) => (r.status ?? 0) >= 500 || r.failed)?.key.concat(" failed") ?? "an error";
  let verdict: string;
  if (bErr && !aErr) verdict = `fixed (no errors${now})`;
  else if (!bErr && aErr) verdict = `regressed (${firstBad(after, added.length ? added : ea)})`;
  else if (bErr && aErr) verdict = added.length || gone.length || changed ? `not fixed (now: ${firstBad(after, ea)})` : `not fixed (same error: ${firstBad(after, ea)})`;
  else if (after.durationMs < before.durationMs * 0.8) verdict = `faster (${fmtMs(before.durationMs)} → ${fmtMs(after.durationMs)})`;
  else if (after.durationMs > before.durationMs * 1.25) verdict = `slower (${fmtMs(before.durationMs)} → ${fmtMs(after.durationMs)})`;
  else verdict = changed ? `both worked, but ${changed.key} is now ${statusText(changed.after)}` : "no change (both worked)";
  out.push(`Verdict: ${verdict}`);
  return out.join("\n");
}
