import type { ApprovalRequest, Checkpoint, Patch } from "@shrike/schema";
import { randomBytes } from "node:crypto";
import { syncCheckpoint } from "./checkpoints.ts";
import { readFile, writeFile } from "./files.ts";

export interface Edit {
  oldText: string;
  newText: string;
}

export interface PatchDeps {
  root: string;
  requestApproval(req: Omit<ApprovalRequest, "id">): Promise<boolean>;
  // Resolves true once node-agent says hello after `sinceMs`, false after `timeoutMs`.
  waitForServerHello(sinceMs: number, timeoutMs: number): Promise<boolean>;
  onUpdate(patch: Patch): void;
  onCheckpoints?(list: Checkpoint[]): void; // A6: every applied patch is a checkpoint
}

const patches = new Map<string, Patch>();
const feedback = new Map<string, string>(); // A13: diff comments sent with a rejection

export const getPatch = (id: string): Patch | undefined => patches.get(id);

/** A13: the next rejection of this patch carries these comments back to the agent. */
export function setFeedback(patchId: string, text: string): void {
  feedback.set(patchId, text);
}

function update(deps: Pick<PatchDeps, "onUpdate" | "onCheckpoints">, patch: Patch): void {
  deps.onUpdate(patch);
  const cps = syncCheckpoint(patch);
  if (cps) deps.onCheckpoints?.(cps);
}

/** After writing files: wait for the server restart, or a moment for the page's hot reload. */
export async function settle(deps: Pick<PatchDeps, "waitForServerHello">, paths: string[], since: number): Promise<void> {
  if (paths.every((p) => isFrontendFile(p))) await new Promise((r) => setTimeout(r, 1500));
  else await deps.waitForServerHello(since, 6000);
}

export function applyEdits(path: string, text: string, edits: Edit[]): string {
  if (!edits.length) throw new Error(`No edits given for ${path}.`);
  let out = text;
  for (const [i, { oldText, newText }] of edits.entries()) {
    if (!oldText) throw new Error(`Edit ${i + 1} for ${path} has empty oldText.`);
    const at = out.indexOf(oldText);
    if (at === -1) throw new Error(`Edit ${i + 1} for ${path}: oldText was not found. Read the file again and copy the exact text.`);
    if (out.indexOf(oldText, at + 1) !== -1) throw new Error(`Edit ${i + 1} for ${path}: oldText matches more than once. Include more surrounding lines.`);
    out = out.slice(0, at) + newText + out.slice(at + oldText.length);
  }
  return out;
}

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"]);

export function checkPatchPath(path: string): void {
  const parts = path.replace(/\\/g, "/").split("/");
  const name = parts.at(-1) ?? "";
  if (parts.some((p) => p === "node_modules" || p === ".git" || p === "..") || name.startsWith(".env") || LOCKFILES.has(name)) {
    throw new Error(`Shrike doesn't change ${path}. Patches can't touch .env files, lockfiles, .git or node_modules.`);
  }
}

// ponytail: path heuristic for "frontend only"; upgrade by checking which files node-agent actually loaded.
export function isFrontendFile(path: string): boolean {
  return /\.(tsx|jsx|css|scss|less|html|vue|svelte)$/.test(path) || /^(src|app|components|pages|public)\//.test(path);
}

export async function proposePatch(
  deps: PatchDeps,
  files: { path: string; edits: Edit[] }[],
  rationale: string,
): Promise<{ patchId: string; status: "applied" | "rejected" }> {
  if (!files.length) throw new Error("The patch has no files.");
  const seen = new Set<string>();
  const changes: Patch["files"] = [];
  for (const f of files) {
    const path = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    checkPatchPath(path);
    if (seen.has(path)) throw new Error(`${path} appears twice. Put all its edits in one entry.`);
    seen.add(path);
    let before: string;
    try {
      before = await readFile(deps.root, path);
    } catch (err) {
      throw new Error(`Couldn't read ${path}: ${(err as Error).message}`);
    }
    changes.push({ path, before, after: applyEdits(path, before, f.edits) });
  }

  const patch: Patch = { id: randomBytes(8).toString("hex"), files: changes, rationale, status: "proposed" };
  patches.set(patch.id, patch);
  update(deps, patch);

  const names = changes.map((c) => c.path).join(", ");
  const approved = await deps.requestApproval({ kind: "patch", title: `Apply this change to ${names}?`, reason: rationale, patch });
  if (!approved) return finish(deps, patch, "rejected");

  for (const c of changes) {
    if ((await readFile(deps.root, c.path)) !== c.before) {
      patch.status = "rejected";
      update(deps, patch);
      throw new Error(`${c.path} changed while waiting for approval, so nothing was applied. Read it again and propose a new patch.`);
    }
  }
  const since = Date.now();
  const written: Patch["files"] = [];
  try {
    for (const c of changes) {
      await writeFile(deps.root, c.path, c.after);
      written.push(c);
    }
  } catch (err) {
    for (const c of written) await writeFile(deps.root, c.path, c.before).catch(() => {});
    patch.status = "rejected";
    update(deps, patch);
    throw new Error(`Couldn't write the patch, so nothing changed: ${(err as Error).message}`);
  }
  await settle(deps, changes.map((c) => c.path), since);
  return finish(deps, patch, "applied");
}

function finish(deps: PatchDeps, patch: Patch, status: "applied" | "rejected"): { patchId: string; status: "applied" | "rejected"; feedback?: string } {
  patch.status = status;
  update(deps, patch);
  const note = status === "rejected" ? feedback.get(patch.id) : undefined;
  feedback.delete(patch.id);
  return { patchId: patch.id, status, ...(note ? { feedback: note } : {}) };
}

/** A6 forward: write a reverted patch again, if its files are still as it left them. */
export async function reapplyPatch(deps: Pick<PatchDeps, "root" | "onUpdate" | "onCheckpoints">, patchId: string): Promise<void> {
  const patch = patches.get(patchId);
  if (!patch) throw new Error("That patch doesn't exist.");
  if (patch.status !== "reverted") throw new Error(`That patch is ${patch.status}, so it can't be applied again.`);
  for (const c of patch.files) {
    if ((await readFile(deps.root, c.path)) !== c.before) throw new Error(`${c.path} changed after the fix was undone, so it wasn't applied again.`);
  }
  const written: Patch["files"] = [];
  try {
    for (const c of patch.files) {
      await writeFile(deps.root, c.path, c.after);
      written.push(c);
    }
  } catch (err) {
    for (const c of written) await writeFile(deps.root, c.path, c.before).catch(() => {});
    throw new Error(`Couldn't apply the fix again, so nothing changed: ${(err as Error).message}`);
  }
  patch.status = "applied";
  update(deps, patch);
}

export async function revertPatch(deps: Pick<PatchDeps, "root" | "onUpdate" | "onCheckpoints">, patchId: string): Promise<void> {
  const patch = patches.get(patchId);
  if (!patch) throw new Error("That patch doesn't exist.");
  if (patch.status !== "applied") throw new Error(`That patch is ${patch.status}, so there's nothing to revert.`);
  for (const c of patch.files) {
    if ((await readFile(deps.root, c.path)) !== c.after) throw new Error(`${c.path} changed after the patch was applied, so it wasn't reverted.`);
  }
  for (const c of patch.files) await writeFile(deps.root, c.path, c.before);
  patch.status = "reverted";
  update(deps, patch);
}
