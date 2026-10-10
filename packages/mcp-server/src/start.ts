import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { StartPlan, StartStep } from "@shrike/schema";
import { redactText } from "@shrike/redact";

// R: the start agent's tools. Served only by the start agent's own MCP server, so the debug agent never gets a shell.
// Shrike runs every command itself (policy R6 in main); Claude Code's own Bash stays off.

export type StepKind = StartStep["kind"];
export interface PlanArgs {
  source: StartPlan["source"];
  skillId?: string;
  services: StartPlan["services"];
  steps: { id?: string; title: string; kind: StepKind; command?: string; cwd?: string; service?: string }[];
}

/** What the start tools need from the desktop (main/start/session.ts). Each returns the text Claude reads; a thrown error is shown as a tool error. */
export interface StartHost {
  readRecipe(id: string): Promise<string>;
  plan(p: PlanArgs): Promise<string>;
  updateStep(p: { id: string; state: "running" | "done" | "failed" | "fixed" | "skipped"; detail?: string; fix?: string }): Promise<string>;
  runCommand(p: { step?: string; title: string; command: string; cwd?: string; timeoutSec?: number; fix?: string }): Promise<string>;
  startService(p: { step?: string; title?: string; name: string; command: string; cwd?: string; url?: string; instrument?: boolean; waitSec?: number }): Promise<string>;
  stopService(p: { name: string }): Promise<string>;
  serviceLogs(p: { name: string; lines?: number }): Promise<string>;
  checkHealth(p: { step?: string; target: string; service?: string; timeoutSec?: number; expect?: string; fix?: string }): Promise<string>;
  envStatus(p: { dir?: string }): Promise<string>;
  writeEnv(p: { step?: string; file: string; values?: Record<string, string>; ask?: string[]; copyFrom?: string; reason: string }): Promise<string>;
  appReady(p: { url?: string }): Promise<string>;
  saveRunSkill(p: { body: string; when?: string; learned?: string }): Promise<string>;
  markSkillUsed(p: { skillId: string }): Promise<string>;
  proposeLesson(p: { lesson: string }): Promise<string>;
  say(text: string): void; // Claude's narration line on the quest
}

const KIND = z.enum(["check", "install", "build", "infra", "service", "env", "health", "other"]);
const SOURCE = z.enum(["shrike-skill", "project-skill", "claude-skill", "readme", "explored"]);

export function registerStartTools(mcp: McpServer, h: StartHost): void {
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, run: (args: ShapeOutput<S>) => Promise<string>) => {
    const cb = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
      try {
        return { content: [{ type: "text", text: redactText(await run(args)) }] };
      } catch (err) {
        return { content: [{ type: "text", text: redactText(err instanceof Error ? err.message : String(err)) }], isError: true };
      }
    };
    mcp.registerTool(name, { description, inputSchema }, cb as never);
  };
  const say = (s: string | undefined) => s?.trim() && h.say(s.trim());

  tool(
    "read_recipe",
    "Read one of the recipes listed in your instructions (a run skill, the project's own Claude Code skill, a README setup section, the starting-apps lessons), in full, with the other files in its folder. Pass its id exactly as listed.",
    { id: z.string().min(1).max(300) },
    async ({ id }) => h.readRecipe(id),
  );

  tool(
    "plan_steps",
    "Show the user the plan as a live checklist before you act, in plain words: every service, its port, prerequisites and the order. Call it again to change the plan; steps that keep their id keep their progress. source: where the plan came from (the recipe you are following, or explored). skillId: the Shrike run skill you are following, if any.",
    {
      source: SOURCE,
      skillId: z.string().max(80).optional(),
      services: z.array(z.object({ name: z.string().min(1).max(40), port: z.number().int().min(1).max(65535).optional(), url: z.string().max(300).optional(), health: z.string().max(300).optional().describe("How you'll check it: a local URL, tcp:<port>, or a command") })).max(20),
      steps: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional().describe("Short stable id like install, infra, backend"),
            title: z.string().min(3).max(120).describe('Plain words a non-developer understands: "Start the databases (Postgres, Redis)"'),
            kind: KIND,
            command: z.string().max(2000).optional(),
            cwd: z.string().max(300).optional(),
            service: z.string().max(40).optional(),
          }),
        )
        .min(1)
        .max(30),
    },
    async (p) => h.plan(p as PlanArgs),
  );

  tool(
    "update_step",
    'Move a checklist step. Use "fixed" (with fix: what you changed, in plain words, like "Used uv run uvicorn") when a step failed and now works; "skipped" when it isn\'t needed. run_command, start_service and check_health already move the step they are given.',
    { id: z.string().min(1).max(40), state: z.enum(["running", "done", "failed", "fixed", "skipped"]), detail: z.string().max(300).optional(), fix: z.string().max(200).optional() },
    async (p) => h.updateStep(p),
  );

  tool(
    "run_command",
    "Run one short command in the project (an install, a build, a look around) and wait for it. Its output streams into the step on the user's screen. Shrike checks it first: installs, builds, local services and health checks just run; env files, migrations, seeds, stopping other programs and paths outside the project ask the user; deleting data, sudo, git push and other machines are never allowed. Use the project's own runner (uv run, poetry run, npx, pnpm exec, nix develop -c). For anything that keeps running (a dev server, infra), use start_service instead.",
    {
      step: z.string().max(40).optional().describe("The plan step this belongs to"),
      title: z.string().min(3).max(120).describe("What this does, in plain words"),
      command: z.string().min(1).max(4000),
      cwd: z.string().max(300).optional().describe("Folder relative to the project root"),
      timeoutSec: z.number().int().min(5).max(570).optional().describe("Default 600s cap minus margin; long installs are fine"),
      fix: z.string().max(200).optional().describe("When re-running a step that failed: what you changed, in plain words"),
    },
    async (p) => {
      say(p.title);
      return h.runCommand(p);
    },
  );

  tool(
    "start_service",
    "Start one long-running process (a dev server, an API, the infra like `PC_DISABLE_TUI=true just services` or `docker compose up`) managed by Shrike. It keeps running after you finish; logs are kept per service (service_logs). Node services get Shrike's recorder unless instrument is false (set it false for infra and non-app processes). Returns after waitSec with its first output, or with the error if it already stopped.",
    {
      step: z.string().max(40).optional(),
      title: z.string().max(120).optional(),
      name: z.string().regex(/^[\w.-]{1,40}$/).describe("Short service name: web, api, infra"),
      command: z.string().min(1).max(4000),
      cwd: z.string().max(300).optional(),
      url: z.string().max(300).optional().describe("Where it listens, if known: http://localhost:5173"),
      instrument: z.boolean().optional(),
      waitSec: z.number().int().min(1).max(120).optional(),
    },
    async (p) => {
      say(p.title ?? `Starting ${p.name}`);
      return h.startService(p);
    },
  );

  tool("stop_service", "Stop a service you started (its whole process group), to restart it after a fix.", { name: z.string().min(1).max(40) }, async (p) => h.stopService(p));

  tool("service_logs", "Read the latest output of a service you started.", { name: z.string().min(1).max(40), lines: z.number().int().min(10).max(2000).optional() }, async (p) => h.serviceLogs(p));

  tool(
    "check_health",
    "Wait until something answers: a local URL (http://localhost:3001/api/health), a port (tcp:5433), or a command (cmd:pg_isready -p 5433). Fails fast if a service you started stopped meanwhile. Moves its step to done when it answers, failed when it doesn't.",
    {
      step: z.string().max(40).optional(),
      target: z.string().min(1).max(2000),
      service: z.string().max(40).optional().describe("The service this proves is up"),
      timeoutSec: z.number().int().min(1).max(300).optional(),
      expect: z.string().max(200).optional().describe("Text the response must contain"),
      fix: z.string().max(200).optional(),
    },
    async (p) => h.checkHealth(p),
  );

  tool(
    "check_env",
    "List the env templates (.env.example and friends) and which of their keys are missing from the real env files next to them. Shows key names only for real env files, never their values.",
    { dir: z.string().max(300).optional().describe("Folder relative to the project root; default: the whole project") },
    async (p) => h.envStatus(p),
  );

  tool(
    "write_env",
    "Add or change settings in an env file (.env, .env.local…). Always asks the user first. Put values you know (copied from .env.example, local ports) in values; put keys only the user knows (API keys, passwords) in ask: the user types them in a small form and you never see them. copyFrom copies a template first when the file doesn't exist.",
    {
      step: z.string().max(40).optional(),
      file: z.string().min(1).max(300),
      values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/), z.string().max(4000)).optional(),
      ask: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/)).max(20).optional(),
      copyFrom: z.string().max(300).optional(),
      reason: z.string().min(3).max(300).describe("Why, in plain words: \"The backend needs a database address\""),
    },
    async (p) => h.writeEnv(p),
  );

  tool(
    "app_ready",
    "Claim the app is up. Shrike checks every service you started is still running, every step is done, fixed or skipped, and the page (url, when the app has one) loads in the user's app pane; then it switches the pane to the live app and tells you the page's title and text, so you can see it isn't blank. Afterwards end with save_run_skill.",
    { url: z.string().max(300).optional().describe("The page to show, like http://localhost:5173. Leave out for an app with no web page.") },
    async (p) => h.appReady(p),
  );

  tool(
    "save_run_skill",
    "End with a skill (always, once the app is up). Writes what worked as this project's run skill in Shrike (.shrike/skills/run-<project>.md): prerequisites, every step with its exact command and folder, ports, health checks, the gotchas you hit and how you fixed them, how to stop it. A first save is the user's new skill; when one exists and you learned something, the change is a draft that Shrike keeps by itself once this start ends verified ready. If nothing changed, call mark_skill_used instead.",
    {
      body: z.string().min(1).max(40_000).describe("The whole skill in Markdown, without front matter"),
      when: z.string().max(200).optional().describe("One line: when to use it"),
      learned: z.string().max(200).optional().describe("One line: what's new this time, like \"process-compose needs PC_DISABLE_TUI=true\""),
    },
    async (p) => h.saveRunSkill(p),
  );

  tool("mark_skill_used", "End with a skill when you followed the run skill and learned nothing new: it counts as one more successful use.", { skillId: z.string().min(1).max(80) }, async (p) => h.markSkillUsed(p));

  tool(
    "propose_lesson",
    "R7: a lesson that would help start ANY project, not just this one (\"Python services in uv projects need uv run\"). It becomes a draft for the user's personal starting-apps skill, kept by itself once this start ends verified ready. One sentence; skip project-specific facts.",
    { lesson: z.string().min(12).max(300) },
    async (p) => h.proposeLesson(p),
  );
}
