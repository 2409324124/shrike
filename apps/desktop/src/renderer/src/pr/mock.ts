import type { PrComment, PrView, ShrikeApi } from "@shrike/schema";

// The browser mock's PR panel (dev/mock-api.ts): one open PR with a failing check, review threads, bots and a table.

const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const cm = (id: string, author: string, bot: boolean, body: string, ago: number): PrComment => ({ id, author, bot, body, at: min(ago), url: `https://github.com/you/todo-app/pull/42#${id}`, reactions: [] });

let view: PrView = {
  ghReady: true,
  branch: "fix-userid",
  viewer: "you",
  pr: { id: "PR_42", number: 42, title: "Fix: Add Todo works again", url: "https://github.com/you/todo-app/pull/42", state: "open", author: "you", updatedAt: min(12), base: "main", head: "fix-userid", decision: "changes" },
  checks: [
    { name: "test", state: "fail", workflow: "CI", url: "https://github.com/you/todo-app/actions/runs/11/job/22", run: "11", startedAt: min(9), completedAt: min(7.9) },
    { name: "lint", state: "pass", workflow: "CI", url: "https://github.com/you/todo-app/actions/runs/11/job/23", run: "11", startedAt: min(9), completedAt: min(8.6) },
    { name: "typecheck", state: "pass", workflow: "CI", url: "https://github.com/you/todo-app/actions/runs/11/job/24", run: "11", startedAt: min(9), completedAt: min(8.2) },
    { name: "e2e", state: "pending", workflow: "CI", url: "https://github.com/you/todo-app/actions/runs/11/job/25", run: "11", startedAt: min(3) },
    { name: "Vercel preview", state: "pass", url: "https://vercel.com/you/todo-app" },
  ],
  threads: [
    { id: "T1", path: "server/todos.controller.ts", line: 18, resolved: false, outdated: false, comments: [cm("C1", "ana", false, "This still reads `req.body.user`. The form sends **userId**, so the insert gets `undefined`.\n\n```suggestion\ninsertTodo({ title, userId: req.body.userId });\n```", 40)] },
    { id: "T2", path: "web/src/api.ts", line: 12, resolved: true, outdated: true, comments: [cm("C2", "coderabbitai", true, "## Potential issue\n\nThe request body isn't typed. Consider a shared `CreateTodo` type.\n\n| File | Change |\n|---|---|\n| web/src/api.ts | add type |\n| server/types.ts | export it |", 55), cm("C3", "you", false, "Done in 3f2a1c.", 30)] },
  ],
  comments: [cm("C4", "vercel[bot]", true, "<!-- vercel -->Preview is ready: [todo-app-git-fix-userid.vercel.app](https://todo-app-git-fix-userid.vercel.app)", 50), cm("C5", "bo", false, "Can we add a test for the missing user case?", 20)],
  reviews: [{ id: "R1", author: "ana", bot: false, state: "changes", body: "One thing left, see the comment on the controller.", at: min(39) }],
  at: Date.now(),
};

export const prMock: Pick<ShrikeApi, "prView" | "prCheckJob" | "prAct" | "prAgent" | "openLink"> = {
  async prView() {
    return view;
  },
  async prCheckJob(_link, name) {
    if (name !== "test") return { steps: [{ name: "Set up job", state: "pass", seconds: 2 }, { name: `Run ${name}`, state: "pass", seconds: 31 }], lines: [] };
    return {
      steps: [{ name: "Set up job", state: "pass", seconds: 2 }, { name: "Install", state: "pass", seconds: 18 }, { name: "Run tests", state: "fail", seconds: 44 }, { name: "Upload report", state: "skipped" }],
      summary: `The "test" check failed during "Run tests". The first problem it printed: not ok 3 - creates a todo for the signed-in user`,
      lines: ["not ok 3 - creates a todo for the signed-in user", "AssertionError: expected 500 to equal 201", "Process completed with exit code 1."],
    };
  },
  async prAct(a) {
    if (a.kind === "resolve") view = { ...view, threads: view.threads.map((t) => (t.id === a.threadId ? { ...t, resolved: a.resolved } : t)) };
    if (a.kind === "reply") view = { ...view, threads: view.threads.map((t) => (t.id === a.threadId ? { ...t, comments: [...t.comments, cm(`C${Date.now()}`, "you", false, a.body, 0)] } : t)) };
    if (a.kind === "comment") view = { ...view, comments: [...view.comments, cm(`C${Date.now()}`, "you", false, a.body, 0)] };
    return view;
  },
  async prAgent() {
    return { items: [], paused: false, chain: null };
  },
  async openLink(url) {
    window.open(url, "_blank", "noopener");
  },
};
