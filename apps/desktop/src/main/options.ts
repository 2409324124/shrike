import { randomBytes } from "node:crypto";
import type { OptionsAnswer, OptionsAsk, OptionsReply, OptionsSession } from "@shrike/schema";
import { optionsReplyText } from "@shrike/mcp-server";
import { addRound, answerProblem, MAX_OPTIONS, roundFor } from "../renderer/src/options/logic.ts";

// M: options and mockups. ask_options blocks here until the user answers a card; the answer goes back to that same call and
// Claude loops (vary, tweak, combine) until approve. Electron-free so it tests with node:test; ipc.ts wires it.
// After a timeout the cards stay up and Claude calls again with the session to keep waiting. An answer with nothing waiting
// (Claude ended its turn, or the run was stopped) resumes the run's conversation with it instead. One sent while the run is
// still live (the gap after a timeout) is held for its next call, or resumes it if the run ends first.

export const WAIT_MS = 9 * 60_000; // under Claude Code's MCP_TOOL_TIMEOUT (10 min)
const MAX_SESSIONS = 20;

export interface OptionsDeps {
  emit(s: OptionsSession): void;
  liveRun(): string | undefined; // the agent run calling the tool
  resume(runId: string, text: string): Promise<string | undefined>; // the new run's id
  onApproved?(runId: string | undefined): void; // skills: the design outcome gate
  waitMs?: number;
}

const cardsOf = (a: OptionsAnswer | undefined) => (!a ? [] : a.action === "vary" || a.action === "tweak" ? [a.card] : a.action === "combine" || a.action === "approve" ? a.cards : []);
const replyOf = (s: OptionsSession, a: OptionsAnswer | undefined): OptionsReply => ({
  action: a?.action ?? "waiting",
  session: s.id,
  ...(a ? { answer: a } : {}),
  cards: cardsOf(a).flatMap((c) => s.cards[c] ?? []),
});

export function createOptions(d: OptionsDeps) {
  const sessions = new Map<string, OptionsSession>();
  const waiters = new Map<string, (r: OptionsReply) => void>();
  const held = new Map<string, OptionsReply>();

  const put = (s: OptionsSession) => {
    sessions.delete(s.id);
    sessions.set(s.id, s);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    d.emit(s);
    return s;
  };

  async function ask(req: OptionsAsk): Promise<OptionsReply> {
    let s = req.session ? sessions.get(req.session) : undefined;
    if (req.session && !s) throw new Error(`No options thread "${req.session}". Start a new one without thread.`);
    const options = req.options ?? [];
    if (options.length > MAX_OPTIONS) throw new Error(`Show at most ${MAX_OPTIONS} options at a time.`);
    if (!s) {
      if (options.length < 2) throw new Error("Give the user 2 to 4 options to choose from.");
      if (!req.question?.trim()) throw new Error("Say what the user is choosing (question).");
      const runId = req.runId ?? d.liveRun();
      const fresh: OptionsSession = { id: randomBytes(4).toString("hex"), ...(runId ? { runId } : {}), question: req.question.trim(), header: (req.header?.trim() || "Options").slice(0, 24), multi: !!req.multi, cards: {}, rounds: [], state: "asking", waiting: false, at: Date.now() };
      s = addRound(fresh, { kind: "start", from: [] }, options);
    } else if (options.length) {
      s = addRound(s.state === "approved" ? { ...s, approved: undefined } : s, roundFor(s.last), options);
    }
    waiters.get(s.id)?.(replyOf(s, undefined)); // a second call for one session: the older one stops waiting
    const id = s.id;
    const h = held.get(id);
    if (h) return held.delete(id), put({ ...s, waiting: false }), h;
    const base = s;
    put({ ...s, question: req.question?.trim() || s.question, state: "asking", waiting: true });
    return new Promise<OptionsReply>((resolve) => {
      const done = (r: OptionsReply) => {
        clearTimeout(timer);
        if (waiters.get(id) !== done) return;
        waiters.delete(id);
        const cur = sessions.get(id);
        if (cur && r.action === "waiting") put({ ...cur, waiting: false });
        resolve(r);
      };
      const timer = setTimeout(() => done(replyOf(sessions.get(id) ?? base, undefined)), d.waitMs ?? WAIT_MS);
      timer.unref?.();
      waiters.set(id, done);
    });
  }

  async function answer(id: string, a: OptionsAnswer): Promise<OptionsSession> {
    const s = sessions.get(id);
    if (!s) throw new Error("Those options aren't open anymore.");
    if (s.state === "approved" && a.action === "approve") throw new Error("You approved one already.");
    const problem = answerProblem(s, a);
    if (problem) throw new Error(problem);
    const w = waiters.get(id);
    if (!w && !s.runId) throw new Error("Your agent isn't waiting on these anymore. Ask again.");
    const state = a.action === "approve" ? "approved" : a.action === "other" ? "closed" : "working";
    let next = put({ ...s, state, last: a, waiting: false, ...(a.action === "approve" ? { approved: [...new Set(a.cards)] } : {}) });
    if (w) w(replyOf(next, a));
    else if (d.liveRun() === s.runId) held.set(id, replyOf(next, a));
    else {
      try {
        const runId = await d.resume(s.runId!, `About the options you showed me ("${s.question}"):\n${optionsReplyText(replyOf(next, a))}`);
        if (runId) next = put({ ...next, runId }); // the run that answers it now owns the session (and its approved mockup)
      } catch (err) {
        put(s); // the cards come back as they were, so the answer can be sent again
        throw err;
      }
    }
    if (a.action === "approve") d.onApproved?.(next.runId);
    return next;
  }

  /** The run stopped: nothing waits on the user any more. A held answer resumes the run; cards it left mid-answer come back. */
  function release(runId?: string): void {
    for (const [id, w] of [...waiters]) {
      const s = sessions.get(id);
      if (!runId || s?.runId === runId) w(replyOf(s!, undefined));
    }
    for (const s of [...sessions.values()]) {
      if (runId && s.runId !== runId) continue;
      const h = held.get(s.id);
      held.delete(s.id);
      if (h && s.runId) {
        // agent.ts emits the status before it forgets the run, so resume on the next tick
        const fix = (p: Partial<OptionsSession>) => { const cur = sessions.get(s.id); if (cur) put({ ...cur, ...p }); };
        setTimeout(() => void d.resume(s.runId!, `About the options you showed me ("${s.question}"):\n${optionsReplyText(h)}`).then(
          (r) => { if (r) fix({ runId: r }); if (h.action === "approve") d.onApproved?.(r); },
          () => fix({ state: "asking", waiting: false, approved: undefined }), // the cards come back to answer again
        ), 0);
      } else if (s.state === "working") put({ ...s, state: "asking", waiting: false });
    }
  }

  return { ask, answer, release, list: () => [...sessions.values()] };
}

export type Options = ReturnType<typeof createOptions>;
