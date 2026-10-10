// Lessons: what keeps going wrong, learned into Shrike skills. review/ (RL, review lessons) and ci/ (CI lessons) each add their own exports here.
export { RepeatOffenders } from "./review/RepeatOffenders.tsx"; // RL7 the dock's Lessons tab
export { LearnFromThis, LessonChip, openLesson } from "./review/LessonChip.tsx"; // RL8 in the PR panel
export { SelfCheckCard } from "./review/SelfCheck.tsx"; // RL6 in Ship
export { LessonsLayer } from "./review/LessonsLayer.tsx"; // RL9 [Lesson Mastered], mounted once in the Shell
export { useLessons } from "./review/store.ts";
