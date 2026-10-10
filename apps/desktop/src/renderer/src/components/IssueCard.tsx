import { useEffect, useState } from "react";
import { Share2, X } from "lucide-react";
import { useActions } from "../stores/actions.ts";
import { toast, useUi } from "../stores/ui.ts";
import { call } from "../lib/api.ts";
import { linearVariant } from "../hud/logic.ts";
import { IconButton, Spinner } from "./ui.tsx";
import { Markdown } from "./Markdown.tsx";

async function copy(text: string, where: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied. Paste it into a new ${where} issue.`, "ok");
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
  }
}

/** O6: GitHub/Linear-ready issue for one trip, with its clip saved beside it. Esc closes. */
export function IssueCard() {
  const id = useUi((s) => s.issue);
  const view = useActions((s) => (id ? s.byId[id] : undefined));
  const [out, setOut] = useState<{ markdown: string; clipPath?: string } | null>(null);

  useEffect(() => {
    setOut(null);
    if (!id) return;
    let live = true;
    void call((a) => a.exportIssue(id), "Couldn't write the issue").then((r) => {
      if (!live) return;
      if (!r) return useUi.setState({ issue: null });
      setOut(r);
    });
    return () => {
      live = false;
    };
  }, [id]);

  if (!id) return null;
  const close = () => useUi.setState({ issue: null });

  return (
    <div className="absolute inset-0 z-40 bg-[color-mix(in_srgb,var(--void)_60%,transparent)]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-label="Issue for this trip" className="glass rise absolute top-14 left-1/2 flex max-h-[min(560px,80%)] w-[min(620px,92%)] -translate-x-1/2 flex-col rounded-[var(--r-card)] shadow-[0_30px_80px_var(--void)]">
        <header className="flex items-center gap-2.5 py-3 pr-2 pl-4">
          <Share2 size={13} className="text-signal" aria-hidden />
          <span className="lbl text-ink">Issue</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{view?.label}</span>
          <IconButton label="Close" onClick={close}>
            <X size={13} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto border-y border-hair bg-black/20 px-4 py-3">
          {out ? (
            <Markdown text={out.markdown.replace(/<\/?sub>/g, "")} path="" />
          ) : (
            <p className="lbl flex items-center gap-2 py-6">
              <Spinner size={11} /> Writing it up
            </p>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button type="button" className="btn go" disabled={!out} onClick={() => out && void copy(out.markdown, "GitHub")}>
            Copy for GitHub
          </button>
          <button type="button" className="btn" disabled={!out} onClick={() => out && void copy(linearVariant(out.markdown), "Linear")}>
            Copy for Linear
          </button>
          <span className="flex-1" />
          {out?.clipPath ? (
            <button type="button" className="btn" onClick={() => void call((a) => a.showInFolder(out.clipPath!), "Couldn't show the clip")}>
              Show clip in Finder
            </button>
          ) : (
            out && <span className="text-[12px] text-faint">No clip yet. Press R to record one.</span>
          )}
        </footer>
      </section>
    </div>
  );
}

