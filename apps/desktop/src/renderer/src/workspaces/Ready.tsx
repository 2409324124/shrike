import { useEffect } from "react";
import { SystemFrame, SystemTag, useCalm } from "../system/System.tsx";
import { useWorkspaces } from "./store.ts";

// WS3: [Workspace ready], the System's window once a new workspace is open. Auto-dismissed; a click sends it away.
export function WorkspaceReady() {
  const r = useWorkspaces((s) => s.ready);
  const calm = useCalm();
  useEffect(() => {
    if (!r) return;
    const t = setTimeout(() => useWorkspaces.setState({ ready: null }), 3200);
    return () => clearTimeout(t);
  }, [r?.at]);
  if (!r) return null;
  const next = [r.ran ? "Starting your app with its run skill" : "", r.prompted ? "your agent has the first prompt" : ""].filter(Boolean).join(", and ");
  return (
    <div className="pointer-events-none! absolute inset-x-0 top-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto max-w-full" onClick={() => useWorkspaces.setState({ ready: null })}>
        <SystemFrame calm={calm} label="Workspace ready">
          <SystemTag>System</SystemTag>
          <p className="m-0 mt-1 text-[15px] text-ink">
            Workspace ready: <span className="font-mono">{r.name}</span>
          </p>
          <p className="m-0 mt-1 text-[12px] text-dim">
            {r.project} · its own copy, ports and agent{next ? `. ${next[0]!.toUpperCase()}${next.slice(1)}.` : "."}
          </p>
        </SystemFrame>
      </div>
    </div>
  );
}
