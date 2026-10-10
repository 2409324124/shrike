import type { ScmFile, ScmState, ShrikeApi } from "@shrike/schema";

// SC: the Changes dock in the browser-only dev build. One fake branch; stage, commit and undo move files between sections.

const H = 3_600_000;
let s: ScmState = {
  isRepo: true,
  branch: "fix-userid",
  upstream: "origin/fix-userid",
  ahead: 1,
  behind: 0,
  base: "main",
  baseAhead: 2,
  baseBehind: 1,
  remote: "origin",
  web: true,
  pull: "ff-only",
  files: [
    { path: "server/todos.controller.ts", letter: "M", area: "changes", added: 1, removed: 1 },
    { path: "src/api.ts", letter: "M", area: "changes", added: 3, removed: 2 },
    { path: "notes/plan.md", letter: "U", area: "untracked", added: 4, removed: 0 },
    { path: "src/TodoForm.tsx", letter: "M", area: "branch", added: 6, removed: 2 },
    { path: "src/lib/user.ts", letter: "A", area: "branch", added: 12, removed: 0 },
  ],
  commits: [
    { sha: "b".repeat(40), short: "bbbbbbb", author: "You", at: Date.now() - 0.3 * H, subject: "Send userId from the todo form", mine: true, pushed: false },
    { sha: "c".repeat(40), short: "ccccccc", author: "You", at: Date.now() - 5 * H, subject: "Add a user helper", mine: true, pushed: true },
    { sha: "d".repeat(40), short: "ddddddd", author: "Priya", at: Date.now() - 30 * H, subject: "Todo list renders done items", mine: false, pushed: true },
  ],
};
let listeners: ((s: ScmState) => void)[] = [];
const set = (next: Partial<ScmState>) => ((s = { ...s, ...next }), listeners.forEach((l) => l(s)), s);
const move = (paths: string[], from: ScmFile["area"][], to: ScmFile["area"]) =>
  set({ files: s.files.map((f) => (from.includes(f.area) && (!paths.length || paths.includes(f.path)) ? { ...f, area: to, letter: f.letter === "U" && to === "staged" ? "A" : f.letter === "A" && to !== "staged" ? "U" : f.letter } : f)) });

export const onMockScm = (cb: (s: ScmState) => void) => (listeners.push(cb), () => void (listeners = listeners.filter((l) => l !== cb)));

export const mockScm: Pick<ShrikeApi, "scmState" | "scmDiff" | "scmStage" | "scmUnstage" | "scmDiscard" | "scmCommit" | "scmUndoCommit" | "scmWriteMessage" | "scmSync" | "scmCommitFiles" | "scmOpenOnGitHub"> = {
  scmState: async () => s,
  scmDiff: async (t) => ({
    path: t.path,
    binary: false,
    hunks: [{ header: "export function createTodo(req, res) {", lines: [{ kind: "ctx", text: "  const { title } = req.body;", old: 13, new: 13 }, { kind: "del", text: "  insertTodo({ title, userId: req.body.user });", old: 14 }, { kind: "add", text: "  insertTodo({ title, userId: req.body.userId });", new: 14 }, { kind: "ctx", text: "  res.status(201).end();", old: 15, new: 15 }] }],
  }),
  scmStage: async (p) => move(p, ["changes", "untracked"], "staged"),
  scmUnstage: async (p) => move(p, ["staged"], "changes"),
  scmDiscard: async (p) => set({ files: s.files.filter((f) => !((f.area === "changes" || f.area === "untracked") && (!p.length || p.includes(f.path)))) }),
  scmCommit: async (m) => {
    const staged = s.files.some((f) => f.area === "staged");
    const going = s.files.filter((f) => (staged ? f.area === "staged" : f.area !== "branch"));
    const subject = m.split("\n")[0]!;
    return set({ files: [...s.files.filter((f) => !going.includes(f)), ...going.map((f) => ({ ...f, area: "branch" as const }))], commits: [{ sha: "e".repeat(40), short: "eeeeeee", author: "You", at: Date.now(), subject, mine: true, pushed: false }, ...s.commits], ahead: s.ahead + 1, baseAhead: s.baseAhead + 1, undo: subject });
  },
  scmUndoCommit: async () => set({ commits: s.commits.slice(1), ahead: s.ahead - 1, baseAhead: s.baseAhead - 1, undo: undefined, files: s.files.map((f) => (f.area === "branch" && f.path === "server/todos.controller.ts" ? { ...f, area: "staged" } : f)) }),
  scmWriteMessage: async () => (await new Promise((r) => setTimeout(r, 900)), "Fix: Add Todo saves the user again\n\nThe form sent userId but the server read user, so every insert failed."),
  scmSync: async () => (await new Promise((r) => setTimeout(r, 700)), set({ ahead: 0, behind: 0, commits: s.commits.map((c) => ({ ...c, pushed: true })), undo: undefined })),
  scmCommitFiles: async () => s.files.filter((f) => f.area === "branch").slice(0, 2),
  scmOpenOnGitHub: async () => {},
};
