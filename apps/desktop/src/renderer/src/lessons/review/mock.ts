import type { ReviewLessonsView, SelfCheck, ShrikeApi } from "@shrike/schema";

// The browser mock's Lessons tab (dev/mock-api.ts): two lessons, two reviewers, a self-check.

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const ex = (commentId: string, pr: number, path: string, line: number, reviewer: string, quote: string, d: number) => ({ commentId, pr, path, line, reviewer, quote, at: day(d), url: `https://github.com/you/todo-app/pull/${pr}` });
const check: SelfCheck = { key: "mock", at: Date.now(), state: "done", reviewers: ["ana"], checked: 2, found: [{ lessonId: "missing-loading-state", title: "Missing loading state", where: "web/src/TodoForm.tsx:31 the save button has no spinner" }], by: "shrike" };

const view: ReviewLessonsView = {
  ready: true, repo: "you/todo-app", viewer: "you", limit: 50, prs: 14, reviewed: 12, minedAt: Date.now() - 3600_000,
  lessons: [
    { id: "missing-loading-state", title: "Missing loading state", spot: "A button or list that fetches with no pending state", fix: ["Disable the control and show a spinner from the click until the answer", "Add a test that clicks twice"], count: 4, prs: [42, 38, 35, 31], reviewers: ["ana"], trend: "down", spark: [1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0], clean: 3, rank: "B", status: "not-working", pending: true, examples: [ex("C1", 42, "web/src/TodoForm.tsx", 31, "ana", "W02: The save button has no loading state", 3), ex("C7", 38, "web/src/TodoList.tsx", 12, "ana", "W01: No loading state while todos load", 9)] },
    { id: "unvalidated-input", title: "Unvalidated input", spot: "A request body used without a schema check", fix: ["Parse the body with zod first"], count: 3, prs: [40, 36, 33], reviewers: ["bo", "coderabbitai"], trend: "flat", spark: [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], clean: 1, rank: "D", status: "learning", examples: [ex("C2", 40, "server/todos.controller.ts", 18, "bo", "Can we validate the request body here?", 5)] },
    { id: "clear-names", title: "Clear names", spot: "Names like loading2", fix: ["Name booleans isX"], count: 2, prs: [30, 29], reviewers: ["ana"], trend: "down", spark: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], clean: 9, rank: "S", status: "mastered", examples: [] },
  ],
  reviewers: [
    { login: "ana", bot: false, prs: 12, comments: 19, perPr: [3, 2, 3, 1, 2, 1, 1, 0, 1, 0], trend: "down", blocking: 11, nits: 5, questions: 2, notes: 1, approvals: 10, changes: 2, concerns: [{ lessonId: "missing-loading-state", title: "Missing loading state", count: 4 }, { lessonId: "clear-names", title: "Clear names", count: 2 }], style: ["Numbers findings W01 (blocks) and N01 (nit) with a severity dot"], habit: "Blocks on missing states, nits on naming" },
    { login: "bo", bot: false, prs: 6, comments: 7, perPr: [1, 2, 1, 1, 1, 1], trend: "flat", blocking: 1, nits: 1, questions: 5, notes: 0, approvals: 5, changes: 0, concerns: [{ lessonId: "unvalidated-input", title: "Unvalidated input", count: 2 }], style: ["Asks a question instead of saying what to do"] },
  ],
  burn: [{ pr: 31, flagged: 3 }, { pr: 32, flagged: 2 }, { pr: 33, flagged: 2 }, { pr: 34, flagged: 1 }, { pr: 35, flagged: 2 }, { pr: 36, flagged: 1 }, { pr: 37, flagged: 0 }, { pr: 38, flagged: 1 }, { pr: 39, flagged: 0 }, { pr: 40, flagged: 1 }, { pr: 41, flagged: 0 }, { pr: 42, flagged: 1 }],
  byComment: { C1: { lessonId: "missing-loading-state", nth: 4, title: "Missing loading state" } },
  check,
};

export const lessonsMock: Pick<ShrikeApi, "reviewLessons" | "refreshReviewLessons" | "learnFromComment" | "selfCheck" | "fixSelfCheck"> = {
  reviewLessons: async () => view,
  refreshReviewLessons: async () => view,
  learnFromComment: async () => view,
  selfCheck: async () => check,
  fixSelfCheck: async () => ({ id: "mock-lessons", goal: "Fix the repeat review issues", brain: "builtin", status: "running" }),
};
