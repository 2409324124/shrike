import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProjectInfo, StartPlan } from "@shrike/schema";
import { plannedPlaces } from "@shrike/scanner";
import { settle } from "../skills.ts";
import type { StartRunner } from "./session.ts";
import { StartSession } from "./session.ts";

// Lanes-from-plan: expected lanes come from Claude's start plan / the run skill. Evolve-on-outcome: a start's drafts apply only when it ends verified ready.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const tmp = mkdtempSync(join(tmpdir(), "shrike-lanes-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const XYNE = "/projects/xyne-spaces/.shrike/skills/run-xyne-spaces.md";
// A trimmed copy of the real xyne-spaces run skill's wording.
const XYNE_LIKE = `# Run xyne-spaces (Shrike)

pnpm monorepo: **infra** via Nix process-compose (\`just services\`: postgres 5433, redis 6379, fake-gcs 4443, zero-cache 4848, ysweet 8080, plus livekit 7880), the **backend** (Express, :3001) and the **dashboard** (Vite SPA, :5173).

## Run

1. **Infra**: \`start_service\` named \`infra\`, \`instrument: false\`, cwd root:
   \`PC_DISABLE_TUI=true direnv exec . just services\`
   Healthy when tcp 5433, 6379, 4443, 4848 and 8080 are open.
3. **Backend**: \`start_service\` named \`backend\`, cwd \`apps/backend\`:
   \`direnv exec . pnpm run dev\`
   Healthy: \`GET http://localhost:3001/api/health\` returns 200.
4. **Dashboard**: \`start_service\` named \`dashboard\`, cwd \`apps/dashboard\`:
   \`direnv exec . pnpm run dev\`
   Healthy: \`http://localhost:5173/\` returns 200.
5. **App pane**: \`app_ready http://localhost:5173\`.

## Health checks

- Core: \`tcp:5433\` postgres, \`tcp:6379\` redis, \`tcp:4443\` fake-gcs
`;
const skillText = XYNE_LIKE;
const lanes = (ps: { kind: string; name: string; detail?: string }[]) => ps.map((p) => `${p.kind} ${p.name} ${p.detail ?? ""}`.trim());
const WANT = ["service BACKEND localhost:3001", "client DASHBOARD localhost:5173", "data POSTGRES localhost:5433", "data GCS localhost:4443", "cache ZERO-CACHE localhost:4848", "cache REDIS localhost:6379"];

test("the xyne-spaces run skill gives BACKEND :3001, DASHBOARD :5173 (client), POSTGRES :5433, REDIS :6379; infra is not a lane", () => {
  assert.deepEqual(lanes(plannedPlaces([], skillText)), WANT);
});

test("the plan keeps the guess's stores, outside APIs and declared places; negated stores and an API named app are not lanes", () => {
  const guess = {
    expectedPlaces: [
      { id: "client:http://localhost:5173", kind: "client" as const, name: "WEB", detail: "localhost:5173" },
      { id: "service:dev", kind: "service" as const, name: "DEV" },
      { id: "data:sqlite", kind: "data" as const, name: "SQLITE" },
      { id: "outside:localhost:4199", kind: "outside" as const, name: "Stripe (test double)", detail: "localhost:4199" },
      { id: "outside:api.openai.com", kind: "outside" as const, name: "OPENAI", detail: "api.openai.com" },
    ],
    declaredPlaces: { "localhost:4199": { kind: "outside" as const, name: "Stripe (test double)" } },
  };
  const p = plannedPlaces([{ name: "web", port: 5173 }, { name: "api", port: 3001 }, { name: "payments", port: 4199 }], "Uses SQLite, no postgres or redis needed.", guess);
  assert.deepEqual(lanes(p), ["client WEB localhost:5173", "service API localhost:3001", "outside Stripe (test double) localhost:4199", "data SQLITE", "outside OPENAI api.openai.com"]);
  assert.deepEqual(lanes(plannedPlaces([{ name: "app", port: 3000 }], "")), ["service APP localhost:3000"]);
});

test("Claude's plan services win on ports; a store named as a service is a store lane; no plan and no skill is []", () => {
  const p = plannedPlaces([{ name: "infra" }, { name: "backend", port: 3002 }, { name: "web", url: "http://127.0.0.1:5174/" }, { name: "postgres", port: 5432 }, { name: "worker" }], "");
  assert.deepEqual(lanes(p), ["service BACKEND localhost:3002", "client WEB localhost:5174", "data POSTGRES localhost:5432", "service WORKER"]);
  assert.deepEqual(plannedPlaces([], "Run `pnpm dev:all`. The API is on localhost:3001."), []);
});

function session(o: { recipeBody?: string } = {}) {
  const root = join(tmp, `p${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const base = join(root, "_home");
  for (const d of ["personal", "claude", "state"]) mkdirSync(join(base, d), { recursive: true });
  const dirs = { builtin: join(repo, "prompts/skills"), project: root, personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
  const project: ProjectInfo = { root, name: "xyne-spaces", devCommand: "pnpm dev:all", routes: [], processes: [{ name: "all", command: "pnpm dev:all", url: "http://localhost:3001" }], expectedPlaces: [{ id: "service:all", kind: "service", name: "ALL", detail: "localhost:3001" }] };
  const plans: StartPlan[] = [];
  const outcomes: { ok: boolean; why?: string }[] = [];
  const runner = { services: () => [], markFailed: () => {} } as unknown as StartRunner;
  const s = new StartSession({
    project,
    runner,
    runEnv: async () => ({ nodeAgentRegister: "", ingestUrl: "", token: "" }),
    skillDirs: () => dirs,
    emit: (ch, p) => void (ch === "start:plan" && plans.push(p as StartPlan)),
    recipes: o.recipeBody ? [{ id: "shrike:run-xyne-spaces", name: "Run xyne-spaces", source: "shrike-skill", path: XYNE, when: "Start it", body: o.recipeBody }] : [],
    lessons: [],
    always: new Set(),
    outcome: async (x) => {
      outcomes.push({ ok: x.ok, ...(x.why ? { why: x.why } : {}) });
      const r = await settle(dirs, { ...x, expect: "run" });
      return r.applied.map((a) => ({ kind: "leveled" as const, skillId: a.skillId, name: a.name, level: a.version ?? 2, learned: a.reason }));
    },
  });
  after(() => s.stop());
  return { s, project, plans, outcomes, root };
}

test("a plan replaces the package.json guess (ALL :3001) with its services and the stores its recipe names", async () => {
  const { s, project, plans } = session({ recipeBody: skillText });
  assert.equal(project.placesFrom, undefined, "before a plan the lanes are the scanner's guess");
  await s.plan({ source: "shrike-skill", services: [{ name: "infra" }, { name: "backend", port: 3001 }, { name: "dashboard", port: 5173 }], steps: [{ title: "Start infra", kind: "service", command: "just services" }] });
  assert.deepEqual(lanes(project.expectedPlaces), WANT);
  assert.equal(project.placesFrom, "plan");
  assert.deepEqual(lanes(plans.at(-1)!.places ?? []), WANT, "start:plan carries the lanes to the Thread");
});

const BODY = (extra = "") => `## Prerequisites\n\n- Node\n\n## Run\n\n1. \`direnv exec . pnpm run dev\` in apps/backend, :3001\n2. \`direnv exec . pnpm run dev\` in apps/dashboard, :5173\n\n## Gotchas\n\n- Run everything through direnv exec.${extra}\n`;

test("a start's improvement is a draft until it ends verified ready; then it levels up with a changelog line and a backup", async () => {
  const { s, root } = session();
  s.appUp = true;
  await s.saveRunSkill({ body: BODY() });
  const file = join(root, ".shrike/skills/run-xyne-spaces.md");
  const v1 = readFileSync(file);
  await s.saveRunSkill({ body: BODY("\n- process-compose needs PC_DISABLE_TUI=true"), learned: "process-compose needs PC_DISABLE_TUI=true" });
  assert.equal(s.quest.plan.rewards!.find((x) => x.kind === "proposed")?.skillId, "run-xyne-spaces");
  assert.deepEqual(readFileSync(file), v1, "nothing is written before the outcome");
  await s.finishReady();
  assert.equal(s.quest.plan.state, "ready");
  assert.deepEqual(s.quest.plan.rewards!.map((r) => [r.kind, r.skillId, r.level]), [["acquired", "run-xyne-spaces", 1], ["leveled", "run-xyne-spaces", 2]]);
  const v2 = readFileSync(file, "utf8");
  assert.match(v2, /version: 2[\s\S]*PC_DISABLE_TUI[\s\S]*## Changelog\n\n- v2: process-compose needs PC_DISABLE_TUI=true, learned on run of \d{1,2} \w{3}/);
  assert.deepEqual(readFileSync(join(root, ".shrike/skills/versions/run-xyne-spaces.v1.md")), v1);
});

test("a start that never comes up learns nothing: the skill stays byte-identical and the draft waits", async () => {
  const { s, root, outcomes } = session();
  s.appUp = true;
  await s.saveRunSkill({ body: BODY() });
  const file = join(root, ".shrike/skills/run-xyne-spaces.md");
  const v1 = readFileSync(file);
  await s.saveRunSkill({ body: BODY("\n- wait for MySQL login before seeding"), learned: "wait for MySQL login before seeding" });
  s.appUp = false; // the app went down before the end
  s.finishFailed("The backend stopped.");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(outcomes, [{ ok: false, why: "the app never came up" }]);
  assert.deepEqual(readFileSync(file), v1);
});
