import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { ActionRecipe, RecipeAgent, Skill } from "@shrike/schema";
import { api } from "../lib/api.ts";
import { cx } from "../components/ui.tsx";
import { useAgent } from "../stores/agent.ts";
import { useProject } from "../stores/project.ts";
import { improvedAgo, useSkills } from "../stores/skills.ts";
import { RankBadge } from "../system/System.tsx";
import { rankOf } from "../system/ranks.ts";
import { asSkillEvent, useSystem } from "../system/store.ts";
import { parseArgs, runSkillFor } from "./catalog.ts";
import { useRecipes } from "./store.ts";

// S8: action recipes. One line per action until clicked; open, it shows the agent, CLI arguments, the prompt template
// with clickable variables, and the skill behind it (level, rank, uses, what it learned).

const AGENTS: { id: RecipeAgent; word: string; why?: string }[] = [
  { id: "default", word: "Use default agent" },
  { id: "claude-code", word: "Claude Code" },
  { id: "builtin", word: "Built-in (API key)" },
  { id: "claude-teams", word: "Claude Agent Teams", why: "Shrike can't start it yet" },
  { id: "codex", word: "Codex", why: "Shrike can't start it yet" },
  { id: "opencode", word: "OpenCode", why: "Shrike can't start it yet" },
];

export function Recipes() {
  const list = useRecipes((s) => s.list);
  useEffect(() => {
    void useRecipes.getState().load();
    void Promise.resolve()
      .then(() => api().getSkillLog())
      .then((l) => Array.isArray(l) && useSystem.getState().addLog(l.map(asSkillEvent).filter((e) => e !== null)), () => {});
  }, []);
  return (
    <section aria-label="Action recipes">
      <p className="m-0 mb-2.5 text-[12px] text-dim">What Shrike tells your agent for each action. Your changes save to this project; the skill behind each one keeps evolving.</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {list.map((r) => (
          <RecipeCard key={`${r.id}:${r.from}:${r.agent}:${r.args}:${r.template}`} r={r} />
        ))}
      </ul>
    </section>
  );
}

/** The same skill main's resolveRecipe uses. */
function skillFor(r: ActionRecipe, skills: Skill[], project?: string): Skill | undefined {
  const own = r.id === "get-running" && project ? skills.find((s) => s.id === runSkillFor(project)) : undefined;
  return own ?? skills.find((s) => s.id === r.skillId);
}

function RecipeCard({ r }: { r: ActionRecipe }) {
  const skills = useSkills((s) => s.list);
  const brains = useAgent((s) => s.brains);
  const project = useProject((s) => s.project?.name);
  const skill = skillFor(r, skills, project);
  const rank = skill ? rankOf(skill.version, skill.proficiency) : undefined;
  const [agent, setAgent] = useState(r.agent);
  const [args, setArgs] = useState(r.args);
  const [template, setTemplate] = useState(r.template);
  const box = useRef<HTMLTextAreaElement>(null);
  const argsError = useMemo(() => {
    try {
      parseArgs(args);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  }, [args]);
  const dirty = agent !== r.agent || args !== r.args || template !== r.template;
  const settings = { agent, args, template };

  const insert = (name: string) => {
    const el = box.current;
    const chip = `{${name}}`;
    const at = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? at;
    setTemplate(template.slice(0, at) + chip + template.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + chip.length, at + chip.length);
    });
  };

  return (
    <li data-recipe={r.id}>
      <details className="group rounded-[10px] border border-hair bg-[color-mix(in_srgb,var(--void)_35%,transparent)] open:border-[var(--glass-edge)]">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} className="shrink-0 text-faint transition-transform group-open:rotate-90" aria-hidden />
          <b className="shrink-0 font-mono text-[12px] font-medium text-ink">{r.name}</b>
          <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{r.description}</span>
          {r.from !== "builtin" && <span className="lbl shrink-0 text-[8.5px] text-signal">{r.from === "project" ? "This project" : "Your default"}</span>}
          {!r.wired && <span className="lbl shrink-0 text-[8.5px] text-faint" title="Shrike doesn't hand this action to an agent yet. Your recipe is kept for when it does.">Soon</span>}
          {rank && <RankBadge rank={rank.rank} small className="shrink-0" />}
          {rank && <span className="shrink-0 font-mono text-[9.5px] text-dim">Lv.{rank.level}</span>}
        </summary>
        <div className="flex flex-col gap-2.5 border-t border-hair px-3 pt-2.5 pb-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="micro text-[9.5px] text-faint">Agent</span>
              <select className="field" value={agent} onChange={(e) => setAgent(e.target.value as RecipeAgent)}>
                {AGENTS.map((a) => {
                  const brain = brains.find((b) => b.id === a.id);
                  const why = a.why ?? (brain && !brain.available ? "not set up" : undefined);
                  return (
                    <option key={a.id} value={a.id} disabled={!!why && a.id !== r.agent}>
                      {why ? `${a.word} (${why})` : a.word}
                    </option>
                  );
                })}
              </select>
            </label>
            <label className="flex min-w-[200px] flex-1 flex-col gap-1">
              <span className="micro text-[9.5px] text-faint">CLI arguments</span>
              <input className="field" value={args} placeholder="--model opus" spellCheck={false} aria-invalid={!!argsError} onChange={(e) => setArgs(e.target.value)} />
            </label>
          </div>
          {argsError ? (
            <p role="alert" className="m-0 -mt-1 text-[11.5px] text-fail">{argsError}</p>
          ) : (
            args.trim() && <p className="m-0 -mt-1 text-[11.5px] text-faint">Kept with the recipe. Shrike doesn't pass these to the agent yet.</p>
          )}
          <label className="flex flex-col gap-1">
            <span className="micro text-[9.5px] text-faint">Prompt</span>
            <textarea
              ref={box}
              className="field h-auto min-h-[96px] resize-y py-1.5 leading-snug"
              rows={Math.min(12, template.split("\n").length + 1)}
              spellCheck={false}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-1.5" aria-label="Variables: click to insert">
            {r.vars.map((v) => (
              <button key={v.name} type="button" className="hud-btn font-mono normal-case" title={v.hint} onClick={() => insert(v.name)}>
                {`{${v.name}}`}
              </button>
            ))}
          </div>
          <SkillInfo r={r} skill={skill} />
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <button type="button" className={cx("btn", dirty && "go")} disabled={!dirty || !!argsError} onClick={() => void useRecipes.getState().save(r.id, settings, "project")}>
              {dirty || r.from !== "project" ? "Save" : "Saved"}
            </button>
            <button type="button" className="btn" disabled={!!argsError} title="Every project uses it unless that project has its own" onClick={() => void useRecipes.getState().save(r.id, settings, "personal")}>
              Make it my default
            </button>
            <span className="flex-1" />
            <button
              type="button"
              className="hud-btn"
              disabled={r.from === "builtin" && !dirty}
              title={r.from === "project" ? "This project goes back to your default, or built-in if you have none" : r.from === "personal" ? "Every project without its own recipe goes back to built-in" : "Undo your edits"}
              onClick={() => (r.from === "builtin" ? (setAgent(r.agent), setArgs(r.args), setTemplate(r.template)) : void useRecipes.getState().reset(r.id))}
            >
              <RotateCcw size={10} />
              {r.from === "project" ? "Reset this project" : r.from === "personal" ? "Clear my default" : "Undo edits"}
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}

/** The skill behind the action: level, rank, uses, last evolved and what it learned. View only. */
function SkillInfo({ r, skill }: { r: ActionRecipe; skill?: Skill }) {
  const log = useSystem((s) => s.log);
  const changes = useMemo(() => (skill ? log.filter((e) => e.skillId === skill.id && (e.kind === "leveled" || e.kind === "acquired")).reverse().slice(0, 6) : []), [log, skill]);
  if (!skill) return <p className="m-0 text-[11.5px] text-faint">{r.skillId ? `Uses the ${r.skillId} skill.` : "Your agent picks the debugging playbook that matches."}</p>;
  const rk = rankOf(skill.version, skill.proficiency);
  const meta = [`Lv.${rk.level}`, `Rank ${rk.rank}`, skill.uses ? `used ${skill.uses} time${skill.uses === 1 ? "" : "s"}` : "not used yet", skill.improvedAt ? `evolved ${improvedAgo(skill.improvedAt)}` : null].filter(Boolean).join(" · ");
  return (
    <div className="rounded-md border border-hair px-2.5 py-2">
      <p className="m-0 flex items-center gap-2 text-[12px]">
        <span className="text-violet" aria-hidden>
          ✦
        </span>
        <span className="text-ink">{skill.name}</span>
        <span className="lbl text-[8.5px] text-faint">{meta}</span>
      </p>
      {changes.length > 0 ? (
        <ol className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0" aria-label={`${skill.name} changelog`}>
          {changes.map((e) => (
            <li key={`${e.kind}:${e.at}`} className="text-[11.5px] text-dim">
              <span className="font-mono text-violet">v{e.level}</span> {e.kind === "acquired" ? "Acquired" : e.learned ? `Learned: ${e.learned}` : "Improved"}
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 mt-1 text-[11.5px] text-faint">No changes yet. It levels up by itself once a run reaches its goal with something new learned.</p>
      )}
    </div>
  );
}
