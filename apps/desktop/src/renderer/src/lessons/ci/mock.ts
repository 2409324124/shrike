import type { CiJob, CiLessonsState, PreflightRun, ShrikeApi } from "@shrike/schema";

// CI in the dev mock (renderer only): a pipeline shaped like a real pnpm monorepo's, a scripted pre-flight, and a push CI disagreed with.

const now = Date.now();
const job = (o: Partial<CiJob> & { id: string; name: string }): CiJob => ({ workflow: "CI-pr", file: ".github/workflows/ci.yml", system: "github", stage: 0, needs: [], services: [], env: {}, secrets: [], steps: [], scope: [], ...o });
const run = (name: string, cmd: string) => ({ name, run: cmd, local: "run" as const });
const pnpm = { NODE_VERSION: "22", PNPM_FLAGS: "--frozen-lockfile --prod=false" };
const jobs: CiJob[] = [
  job({ id: "be", name: "ci / Backend typecheck + build", node: "22", env: { ...pnpm, NODE_OPTIONS: "--max-old-space-size=8192" }, scope: ["apps/backend", "packages/shared"], steps: [run("Build workspace libraries", "pnpm --filter @app/shared run build"), run("Typecheck + build", "pnpm --filter app-backend run build")], stats: { runs: 6, fails: 1, flaky: 0, seconds: 237, last: { kind: "install", line: "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation." } } }),
  job({ id: "dl", name: "ci / Dashboard lint", node: "22", env: pnpm, scope: ["apps/dashboard", "packages/shared"], steps: [run("Lint (errors only)", "pnpm --filter app-dashboard run lint:errors-only")], stats: { runs: 6, fails: 2, flaky: 0, seconds: 336, last: { kind: "lint", line: "671:19  error  Element must have data-track-category and data-track-name attributes" } } }),
  job({ id: "dt", name: "ci / Dashboard typecheck", node: "22", env: pnpm, scope: ["apps/dashboard", "packages/shared"], steps: [run("Format check", "pnpm --filter app-dashboard run format:check"), run("Typecheck", "pnpm --filter app-dashboard run typecheck")], stats: { runs: 6, fails: 2, flaky: 1, seconds: 200, last: { kind: "format", line: "[warn] Code style issues found in 3 files. Run Prettier with --write to fix." } } }),
  job({ id: "db", name: "ci / Dashboard build", node: "22", env: pnpm, scope: ["apps/dashboard"], steps: [run("Build", "pnpm --filter app-dashboard run build")], stats: { runs: 6, fails: 0, flaky: 0, seconds: 241 } }),
  job({ id: "at", name: "ci / Automation tests", off: "Doesn't run on pull requests (it runs only when github.event_name == 'merge_group')" }),
  job({ id: "gl", name: "ci / Secret scan (gitleaks)", steps: [{ name: "Install gitleaks", local: "prep", why: "Downloads a tool for CI; here Shrike uses yours when it's installed" }, run("Run gitleaks", "gitleaks dir . --exit-code 1")], stats: { runs: 6, fails: 0, flaky: 0, seconds: 14 } }),
  job({ id: "sm", name: "Validate schema migrations", workflow: "Schema Migration Check", file: ".github/workflows/schema-migration-check.yml", steps: [{ name: "Stage PR changes", local: "skip", why: "Changes git state, which CI does on a throwaway copy" }, run("Validate schema migrations", "bash scripts/validate-schema-migrations.sh --ci-mode")], stats: { runs: 6, fails: 1, flaky: 0, seconds: 17 } }),
  job({ id: "rs", name: "Raw SQL guard", workflow: "Schema Migration Check", file: ".github/workflows/schema-migration-check.yml", steps: [run("Raw SQL guard", "bash scripts/validate-no-raw-sql.sh --ci")], stats: { runs: 6, fails: 0, flaky: 0, seconds: 14 } }),
  job({ id: "nx", name: "Nix flake check", workflow: "Nix CI", file: ".github/workflows/nix-ci.yml", scope: ["flake.lock", "nix/**"], steps: [run("nix flake check", "nix flake check --no-build -L")], stats: { runs: 4, fails: 0, flaky: 0, seconds: 412 } }),
  job({ id: "rp", name: "ci / Push report", stage: 1, needs: ["be"], secrets: ["JWT"], steps: [{ name: "Push report", local: "skip", why: "Needs a secret only CI has" }] }),
];
const last: PreflightRun = {
  id: "r0", at: now - 50 * 60_000, state: "done", files: 3, from: "skill", safe: true, verdict: "Safe to push", warnings: [],
  legs: [{ job: "be", name: "ci / Backend typecheck + build", state: "pass", seconds: 41 }, { job: "sm", name: "Validate schema migrations", state: "pass", seconds: 2 }, { job: "gl", name: "ci / Secret scan (gitleaks)", state: "skipped", why: "Needs gitleaks, which this computer doesn't have" }],
  hosted: { sha: "abc", state: "done", matched: false, first: "ci / Backend typecheck + build", jobs: [{ name: "ci / Backend typecheck + build", state: "fail" }, { name: "Validate schema migrations", state: "pass" }, { name: "ci / Secret scan (gitleaks)", state: "pass" }] },
};
let state: CiLessonsState = {
  ready: true,
  pipeline: { systems: ["github"], files: [".github/workflows/CI-pr.yml", ".github/workflows/schema-migration-check.yml", ".github/workflows/nix-ci.yml"], jobs, history: { runs: 66 }, at: now },
  touched: ["be", "dt", "gl", "sm", "rs"],
  files: 4,
  run: last,
  record: { pushes: ["clean", "clean", "caught", "clean", "surprise", "clean", "clean", "clean"], surprises: 1, streak: 3 },
  skill: { version: 3, pending: true, lessons: 2 },
};
let listener: (s: CiLessonsState) => void = () => {};
export const onMockCi = (fn: (s: CiLessonsState) => void): void => void (listener = fn);
const put = (s: Partial<CiLessonsState>) => ((state = { ...state, ...s }), listener(state), state);
let stopped = false;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ciMock: Pick<ShrikeApi, "ciLessons" | "ciLearn" | "preflight" | "stopPreflight" | "ciFixLeg"> = {
  async ciLessons() {
    return state;
  },
  async ciLearn() {
    put({ busy: "learning" });
    await wait(900);
    return put({ busy: undefined, skill: { version: state.skill?.version ?? 1, pending: true, lessons: (state.skill?.lessons ?? 0) + 1 }, note: "Saved as a lesson. The next pre-flight tries it, and Shrike keeps it once CI agrees." });
  },
  async preflight() {
    stopped = false;
    const ids = ["be", "dt", "sm", "gl"];
    const r: PreflightRun = { id: "r1", at: Date.now(), state: "running", files: 4, from: "draft", warnings: ["CI uses Node 22, this computer has Node 24. Results can differ."], legs: ids.map((id) => ({ job: id, name: jobs.find((j) => j.id === id)!.name, state: "waiting" })) };
    put({ run: r });
    const lines = ["> tsc -p tsconfig.build.json", "src/routes/todos.ts compiled", "Checking formatting...", "All matched files use Prettier code style!"];
    for (let k = 0; k < r.legs.length && !stopped; k++) {
      const leg = r.legs[k]!;
      if (leg.job === "gl") {
        Object.assign(leg, { state: "skipped", why: "Needs gitleaks, which this computer doesn't have" });
        continue;
      }
      Object.assign(leg, { state: "running", command: "pnpm --filter app-backend run build" });
      for (const l of lines.slice(0, 3)) {
        leg.tail = [...(leg.tail ?? []), l].slice(-3);
        put({ run: { ...r } });
        await wait(350);
      }
      if (leg.job === "sm") Object.assign(leg, { state: "fail", kind: "schema", why: "the database schema", line: "schema.prisma changed (model Invoice) but no new migration under prisma/migrations", fix: "The database schema changed without what CI expects with it, usually a migration. Make the migration and commit it.", seconds: 3 });
      else Object.assign(leg, { state: "pass", seconds: 12 + k * 9 });
      delete leg.tail;
      put({ run: { ...r } });
    }
    Object.assign(r, { state: stopped ? "stopped" : "done", safe: false, verdict: "Fix 1 thing before you push" });
    put({ run: { ...r } });
    return r;
  },
  async stopPreflight() {
    stopped = true;
  },
  async ciFixLeg(id) {
    return { id: `fix-${id}`, goal: "Fix the schema migration check", brain: "claude-code", status: "running", startedAt: Date.now() } as Awaited<ReturnType<ShrikeApi["ciFixLeg"]>>;
  },
};
