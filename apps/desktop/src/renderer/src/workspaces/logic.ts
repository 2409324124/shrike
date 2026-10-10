// WS1/WS2 pure helpers, shared with main (workspaces.ts). No runtime imports.
import type { Workspace, WorkspaceGroup } from "@shrike/schema";

export type Smart =
  | { kind: "pr"; number: number; url?: string; say: string }
  | { kind: "branch"; branch: string; say: string }
  | { kind: "name"; name: string; note?: string; say: string };

/** A short worktree name from any text: "Feature/Login page" -> "feature-login-page". */
export function slugName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}

/** WS2 Smart: one box that understands a name, #12, a branch (only an existing one once the list is known), a GitHub PR or issue URL, or a Jira link (kept as a note). */
export function parseSmart(text: string, branches: string[] = []): Smart | null {
  const t = text.trim();
  if (!t) return null;
  let m = /^#?(\d{1,7})$/.exec(t);
  if (m) return { kind: "pr", number: Number(m[1]), say: `Pull request #${m[1]}` };
  m = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i.exec(t);
  if (m) return { kind: "pr", number: Number(m[1]), url: t, say: `Pull request #${m[1]}` };
  m = /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i.exec(t);
  if (m) return { kind: "name", name: `issue-${m[1]}`, note: t, say: `Issue #${m[1]}, kept as a note` };
  m = /\/browse\/([A-Z][A-Z0-9]+-\d+)/.exec(t) ?? /^([A-Z][A-Z0-9]+-\d+)$/.exec(t);
  if (m) return { kind: "name", name: slugName(m[1]!), note: /^https?:/.test(t) ? t : m[1], say: `Jira ${m[1]}, kept as a note` };
  if (/^https?:\/\//.test(t)) {
    const last = t.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? "";
    return { kind: "name", name: slugName(last) || "link", note: t, say: "A link, kept as a note" };
  }
  const known = branches.find((b) => b === t || b === `origin/${t}`);
  if (known || (!branches.length && /^[\w.-]+(\/[\w.-]+)+$/.test(t))) return { kind: "branch", branch: known ?? t, say: `Branch ${known ?? t}` };
  const name = slugName(t);
  return name ? { kind: "name", name, say: `New workspace ${name}` } : null;
}

export function groupOf(w: Pick<Workspace, "agent" | "pr">): WorkspaceGroup {
  if (w.agent === "waiting") return "needs-you";
  if (w.agent === "working") return "working";
  if (w.pr?.state === "open") return "review";
  if (w.pr?.state === "merged") return "done";
  return "idle";
}

// Most urgent first (ADHD-first): what needs you, what's moving, what waits on others, then the quiet ones.
export const GROUPS: { id: WorkspaceGroup; word: string }[] = [
  { id: "needs-you", word: "Needs you" },
  { id: "working", word: "Working" },
  { id: "review", word: "Ready for review" },
  { id: "idle", word: "Idle" },
  { id: "done", word: "Done" },
];

export function grouped(list: Workspace[]): { id: WorkspaceGroup; word: string; items: Workspace[] }[] {
  return GROUPS.map((g) => ({ ...g, items: list.filter((w) => w.group === g.id) })).filter((g) => g.items.length);
}

/** Parses `git worktree list --porcelain`: main checkout first. */
export function parsePorcelain(out: string): { path: string; branch: string; head?: string; prunable: boolean }[] {
  return out
    .trim()
    .split(/\n\n+/)
    .map((b) => ({
      path: /^worktree (.+)$/m.exec(b)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? "",
      head: /^HEAD (\w+)$/m.exec(b)?.[1],
      prunable: /^prunable/m.test(b),
    }))
    .filter((w) => w.path);
}
