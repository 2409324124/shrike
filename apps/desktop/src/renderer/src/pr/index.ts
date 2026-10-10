// pr-ci: the pull request and CI panel (docs/13 PR1–PR10). The source control dock mounts <PrPanel docked /> as a tab
// and switches to it when `usePr` `want` changes; openPrPanel() is how Ship, the SDLC rail and others show it.
import { useMemo } from "react";
import { fileComments } from "./logic.ts";
import { usePr } from "./store.ts";

export { PrDrawer, PrPanel } from "./PrPanel.tsx";
export { openPrPanel, usePr } from "./store.ts";

/** PR7: open and resolved review comments per file (project paths), for the source control file list. Empty until the panel has loaded. */
export function usePrFileComments(): Record<string, { open: number; resolved: number }> {
  const threads = usePr((s) => s.view?.threads);
  const prefix = usePr((s) => s.view?.prefix);
  return useMemo(() => fileComments(threads ?? [], prefix), [threads, prefix]);
}
