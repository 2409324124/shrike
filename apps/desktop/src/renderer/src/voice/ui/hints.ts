import { ACTIONS, BY_ID, type ActionDef } from "../../actions/registry.ts";

// "What can I say" per panel, read from the action registry. Tested in hints.test.ts.

export type Where = "thread" | "logs" | "network" | "api" | "terminal" | "details" | "skills" | "flows" | "ship" | "changes" | "pr" | "file";

const SHEETS: Where[] = ["logs", "network", "api", "terminal", "details", "skills", "flows", "ship", "file"];

/** Which commands belong to which panel; the registry stays panel-free. */
const HERE: Record<string, readonly Where[]> = {
  "step.next": ["thread"], "step.prev": ["thread"], "failure.next": ["thread"], dive: ["thread"], replay: ["thread"], "trip.next": ["thread"], "agent.explain": ["thread", "file"],
  "panel.hide": SHEETS, "file.open_focused": ["thread"], "agent.find_cause": ["file", "logs"],
  "api.send": ["api", "network"], "api.new": ["api"], "route.open": ["api"],
  "git.stage_all": ["changes"], "git.commit": ["changes"], "git.push": ["changes", "ship"], "git.undo_commit": ["changes"], "git.pull": ["changes"], "git.discard": ["changes"],
  "pr.list": ["pr", "ship"], "pr.merge": ["pr"], "pr.review": ["pr"], "pr.fix_comments": ["pr"], "ci.open_check": ["pr", "ship"], "ci.explain": ["pr"], "ci.rerun": ["pr", "ship"], "pr.create": ["ship"],
  "skill.run": ["skills"], "skill.save": ["skills"], "flow.run": ["flows"], "flow.record": ["flows"], "flow.watch": ["flows"],
};

/** The global few, in the order a new person needs them. */
const ANYWHERE = ["panel.show", "app.run", "failure.next", "pr.open", "git.push", "agent.ask", "plan.undo", "voice.off"];

export interface Hint {
  id: string;
  say: string;
  also?: string; // the Hinglish way to say it, in Roman script
  does: string;
}

const ROMAN = /^[\x20-\x7e]+$/;
const HINGLISH = /\b(karo|kar do|dikhao|kholo|chalao|jao|kahan|banao|dhundo|band|wapas|pichl\w*|agl\w*|dobara|shuru|pucho|hai|hua)\b/;

export function hint(a: ActionDef): Hint {
  const roman = a.examples.filter((e) => ROMAN.test(e));
  return { id: a.id, say: roman[0] ?? a.title, also: roman.find((e) => HINGLISH.test(e) && e !== roman[0]), does: a.title.includes("{") ? a.help.split(":")[0]! : a.title };
}

/** Commands for the focused panel first, then the global ones. */
export function hintsFor(where: Where, actions: readonly ActionDef[] = ACTIONS): { here: Hint[]; anywhere: Hint[] } {
  const here = actions.filter((a) => HERE[a.id]?.includes(where));
  return {
    here: here.slice(0, 6).map(hint),
    anywhere: ANYWHERE.filter((id) => !here.some((a) => a.id === id)).flatMap((id) => (BY_ID.get(id) ? [hint(BY_ID.get(id)!)] : [])),
  };
}
