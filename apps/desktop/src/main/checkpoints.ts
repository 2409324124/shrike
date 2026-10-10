import { randomBytes } from "node:crypto";
import type { Checkpoint, Patch } from "@shrike/schema";

// A6: one checkpoint per applied patch, oldest first. `current` follows the patch: applied = current.
// ponytail: in memory for the session, like patches. Upgrade: persist both under .shrike/.

const list: Checkpoint[] = [];

export const getCheckpoints = (): Checkpoint[] => list.map((c) => ({ ...c, files: [...c.files] }));

export function clearCheckpoints(): void {
  list.length = 0;
}

function label(rationale: string): string {
  const first = rationale.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]$/, "");
  return first.length > 56 ? `${first.slice(0, 55)}…` : first || "Applied fix";
}

/** Call on every patch update. Returns the new list when a checkpoint was added or changed, else null. */
export function syncCheckpoint(patch: Patch): Checkpoint[] | null {
  const cp = list.find((c) => c.patchId === patch.id);
  const current = patch.status === "applied";
  if (!cp) {
    if (!current) return null;
    list.push({ id: randomBytes(6).toString("hex"), patchId: patch.id, label: label(patch.rationale), files: patch.files.map((f) => f.path), createdAt: Date.now(), current: true });
    return getCheckpoints();
  }
  if (cp.current === current) return null;
  cp.current = current;
  return getCheckpoints();
}

export interface RewindDeps {
  revert(patchId: string): Promise<void>;
  reapply(patchId: string): Promise<void>;
  settle(files: string[], sinceMs: number): Promise<void>; // wait for the server restart, like apply
}

/**
 * Rewind to a current checkpoint: undo it and every later current one, newest first.
 * On a rewound checkpoint it goes forward instead: re-apply every rewound one up to it, oldest first.
 * Stops at the first file that changed underneath, leaving the earlier steps done.
 */
export async function rewindTo(deps: RewindDeps, checkpointId: string): Promise<void> {
  const i = list.findIndex((c) => c.id === checkpointId);
  if (i < 0) throw new Error("That checkpoint doesn't exist.");
  const back = list[i]!.current;
  const steps = back ? list.slice(i).filter((c) => c.current).reverse() : list.slice(0, i + 1).filter((c) => !c.current);
  const since = Date.now();
  const files = new Set<string>();
  try {
    for (const c of steps) {
      await (back ? deps.revert(c.patchId) : deps.reapply(c.patchId));
      c.files.forEach((f) => files.add(f));
    }
  } finally {
    if (files.size) await deps.settle([...files], since);
  }
}
