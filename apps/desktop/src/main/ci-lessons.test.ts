import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { CiLessonsState, ShrikeEvents, SkillEvent } from "@shrike/schema";
import type { Exec, Gh } from "./github.ts";
import { circleJobs, classify, cleanLog, compare, createCiLessons, decideIf, evalExpr, fill, githubJobs, gitlabJobs, historyStats, jenkinsJobs, legsOf, lessonsBody, parseYaml, scopeOf, touches, verdictOf, workspacePackages, type RunJobs, type Runner } from "./ci-lessons.ts";
import { configureSkills, listDrafts, loadSkills, type SkillDirs } from "./skills.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

// ---- recorded from juspay/xyne-spaces (public), trimmed: gh run view --json jobs and --log-failed of real failures ----
const VIEW_37917833838 = { jobs: [
  { databaseId: 113778252421, name: "ci / Backend typecheck + build", conclusion: "success", startedAt: "2026-10-09T10:27:49Z", completedAt: "2026-10-09T10:31:42Z" },
  { databaseId: 113778252850, name: "ci / Framework lint", conclusion: "success", startedAt: "2026-10-09T10:27:49Z", completedAt: "2026-10-09T10:28:27Z" },
  { databaseId: 113778252940, name: "ci / Secret scan (gitleaks)", conclusion: "success", startedAt: "2026-10-09T10:27:49Z", completedAt: "2026-10-09T10:28:03Z" },
  { databaseId: 113778252972, name: "ci / Dashboard lint", conclusion: "failure", startedAt: "2026-10-09T10:28:40Z", completedAt: "2026-10-09T10:34:38Z" },
  { databaseId: 113778252993, name: "ci / xyne-claw typecheck", conclusion: "success", startedAt: "2026-10-09T10:27:49Z", completedAt: "2026-10-09T10:28:48Z" },
  { databaseId: 113778253018, name: "ci / Dashboard build", conclusion: "success", startedAt: "2026-10-09T10:28:40Z", completedAt: "2026-10-09T10:32:41Z" },
  { databaseId: 113778253043, name: "ci / Dashboard typecheck", conclusion: "failure", startedAt: "2026-10-09T10:28:40Z", completedAt: "2026-10-09T10:31:05Z" },
  { databaseId: 113778254089, name: "ci / Automation tests", conclusion: "skipped", startedAt: "2026-10-09T10:27:47Z", completedAt: "2026-10-09T10:27:47Z" },
] };
const VIEW_37914292195 = { jobs: [
  { databaseId: 113766607131, name: "ci / Backend typecheck + build", conclusion: "success", startedAt: "2026-10-09T09:58:02Z", completedAt: "2026-10-09T10:01:33Z" },
  { databaseId: 113766607373, name: "ci / Dashboard lint", conclusion: "failure", startedAt: "2026-10-09T09:58:02Z", completedAt: "2026-10-09T10:03:09Z" },
  { databaseId: 113766607391, name: "ci / Dashboard typecheck", conclusion: "success", startedAt: "2026-10-09T09:58:02Z", completedAt: "2026-10-09T10:01:09Z" },
] };
const LOG_FORMAT = [
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:27.9329807Z ##[group]Run pnpm --filter xyne-spaces-dashboard run format:check",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:27.9330331Z ^[[36;1mpnpm --filter xyne-spaces-dashboard run format:check^[[0m",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:27.9394838Z env:",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:27.9395286Z   PNPM_FLAGS: --frozen-lockfile --prod=false",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:27.9396295Z ##[endgroup]",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:28.3475330Z > xyne-spaces-dashboard@1.484.0 format:check /home/runner/work/xyne-spaces/xyne-spaces/apps/dashboard",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:30:28.3476859Z > prettier --check \"src/**/*.{ts,tsx,js,jsx,json,css,md}\"",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:28:51.0932546Z (node:2323) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications.",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:31:05.0789395Z [\u001b[33mwarn\u001b[39m] src/utils/bootSplashAssets.ts",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:31:05.9106129Z [\u001b[33mwarn\u001b[39m] Code style issues found in 3 files. Run Prettier with --write to fix.",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:31:05.9558001Z  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  xyne-spaces-dashboard@1.484.0 format:check: `prettier --check \"src/**/*.{ts,tsx,js,jsx,json,css,md}\"`",
  "ci / Dashboard typecheck\tUNKNOWN STEP\t2026-10-09T10:31:05.9775067Z ##[error]Process completed with exit code 1.",
].join("\n");
const LOG_LINT = [
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:30:35.2473903Z ##[group]Run pnpm --filter xyne-spaces-dashboard run lint:errors-only:ci",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:30:35.2474491Z ^[[36;1mpnpm --filter xyne-spaces-dashboard run lint:errors-only:ci^[[0m",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:30:35.25Z ##[endgroup]",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:30:35.6810478Z > xyne-spaces-dashboard@1.484.0 lint:errors-only:ci /home/runner/work/xyne-spaces/xyne-spaces/apps/dashboard",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:34:37.4743662Z ##[error]  671:19  error  Element must have data-track-category and data-track-name attributes for activity tracking  local-rules/require-tracking-on-click",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:34:37.4751758Z ✖ 1 problem (1 error, 0 warnings)",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:34:38.2318229Z  ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  xyne-spaces-dashboard@1.484.0 lint:errors-only:ci: `eslint . --quiet && pnpm run lint:css`",
  "ci / Dashboard lint\tUNKNOWN STEP\t2026-10-09T10:34:38.2528985Z ##[error]Process completed with exit code 1.",
].join("\n");
const LOG_LOCKFILE = [
  "ci / Backend typecheck + build\tUNKNOWN STEP\t2026-10-09T10:00:39.8Z ##[group]Run pnpm install --frozen-lockfile --prod=false --filter xyne-spaces-backend...",
  "ci / Backend typecheck + build\tUNKNOWN STEP\t2026-10-09T10:00:39.81Z ##[endgroup]",
  "ci / Backend typecheck + build\tUNKNOWN STEP\t2026-10-09T10:00:41.7064461Z  ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation. The current \"overrides\" configuration doesn't match the value found in the lockfile",
  "ci / Backend typecheck + build\tUNKNOWN STEP\t2026-10-09T10:00:41.7431488Z ##[error]Process completed with exit code 1.",
  "ci / Backend typecheck + build\tUNKNOWN STEP\t2026-10-09T10:00:41.99Z ##[warning]Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: pnpm/action-setup@v4.",
].join("\n");

// ---- a repo shaped like xyne-spaces: a PR workflow calling a reusable one, matrix legs, a merge-queue-only job ----
const CI_PR = `name: CI-pr
on:
  pull_request:
  merge_group:
jobs:
  ci:
    uses: acme/spaces/.github/workflows/ci.yml@main
    secrets: inherit
`;
const CI = `name: CI
on:
  workflow_call:
env:
  NODE_VERSION: "22"
  PNPM_FLAGS: "--frozen-lockfile --prod=false"
jobs:
  backend:
    name: Backend typecheck + build
    runs-on: \${{ vars.USE_SELF_HOSTED_CI == 'true' && 'mini' || 'ubuntu-latest' }}
    env:
      NODE_OPTIONS: "--max-old-space-size=8192"
    services:
      postgres:
        image: postgres:16
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        if: vars.USE_SELF_HOSTED_CI != 'true'
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: pnpm
      - name: Install dependencies
        run: pnpm install \${{ env.PNPM_FLAGS }} --filter xyne-spaces-backend...
      - name: Build workspace libraries
        run: pnpm --filter @xyne/shared --filter agentic-framework run build
      - name: Prisma generate (app + common schemas)
        run: |
          pnpm --filter xyne-spaces-backend run db:generate
          pnpm --filter xyne-spaces-backend run db:common:generate
      # backend lint intentionally omitted
      - name: Typecheck + build
        run: pnpm --filter xyne-spaces-backend run build
  dashboard:
    name: Dashboard \${{ matrix.task }}
    strategy:
      fail-fast: false
      matrix:
        task: [lint, typecheck, build]
    steps:
      - uses: actions/checkout@v5
      - name: Install dependencies
        run: pnpm install \${{ env.PNPM_FLAGS }} --filter xyne-spaces-dashboard...
      - name: Lint (errors only)
        if: matrix.task == 'lint'
        run: pnpm --filter xyne-spaces-dashboard run lint:errors-only
      - name: Format check
        if: matrix.task == 'typecheck'
        run: pnpm --filter xyne-spaces-dashboard run format:check
      - name: Restore tsc incremental state
        if: matrix.task == 'typecheck'
        uses: actions/cache@v4
        with:
          path: apps/dashboard/node_modules/.tmp/tsconfig.app.tsbuildinfo
          key: dashboard-tsbuildinfo-\${{ runner.os }}-\${{ github.sha }}
      - name: Typecheck
        if: matrix.task == 'typecheck'
        run: pnpm --filter xyne-spaces-dashboard run typecheck
      - name: Build
        if: matrix.task == 'build'
        run: pnpm --filter xyne-spaces-dashboard run build
  test:
    name: Automation tests
    if: github.event_name == 'merge_group' && vars.RUN_TEST_CASE == 'true'
    steps:
      - run: pnpm run test
  xyne-claw:
    name: xyne-claw typecheck
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Install dependencies
        run: pnpm install \${{ env.PNPM_FLAGS }} --filter xyne-claw...
      - name: Typecheck xyne-claw
        run: pnpm --filter xyne-claw run typecheck
  gitleaks:
    name: Secret scan (gitleaks)
    env:
      GITLEAKS_VERSION: "8.30.1"
    steps:
      - name: Install gitleaks
        run: |
          curl -sfL "https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/gitleaks.tar.gz" | tar -xz -C "$RUNNER_TEMP/bin" gitleaks
          echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"
      - name: Run gitleaks
        run: gitleaks dir . --config .gitleaks.toml --redact --no-banner --exit-code 1
  report:
    name: Push report
    needs: [backend]
    steps:
      - env:
          JWT: \${{ secrets.TESTCASES_JWT }}
        run: curl -sS -X POST "$SPACES_URL" -H "Authorization: Bearer $JWT"
`;
const SCHEMA = `name: Schema Migration Check
on:
  pull_request:
jobs:
  schema-migrations:
    name: Validate schema migrations
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Stage PR changes for schema validation
        env:
          BASE_REF: \${{ github.base_ref }}
        run: |
          git fetch --no-tags origin "+refs/heads/\${BASE_REF}:refs/remotes/origin/\${BASE_REF}"
          git reset --soft "$(git merge-base HEAD "origin/\${BASE_REF}")"
      - name: Validate schema migrations
        run: bash scripts/validate-schema-migrations.sh --ci-mode
`;
const HELM = `name: Helm Charts CI
on:
  pull_request:
    paths:
      - helm-charts/**
      - .github/workflows/helm-charts-ci.yml
jobs:
  lint:
    name: Lint + template
    steps:
      - run: bash ci/scripts/lint-charts.sh
`;
const NIX = `name: Nix CI
on:
  pull_request:
  push:
    branches: [main, "release**"]
jobs:
  nix:
    name: Nix flake check
    steps:
      - uses: nix-community/cache-nix-action@v6
        with:
          primary-key: nix-\${{ runner.os }}-\${{ hashFiles('flake.lock', '**/flake.nix', 'project.nix', 'nix/**') }}
      - name: nix flake check
        run: nix flake check --no-build -L
`;
const PUSH = `name: CI-push
on:
  push:
    branches:
      - main
      - "release**"
jobs:
  ci:
    uses: ./.github/workflows/ci.yml
`;

const PKGS: Record<string, { name: string; deps?: string[] }> = {
  "apps/backend": { name: "xyne-spaces-backend", deps: ["@xyne/shared", "agentic-framework"] },
  "apps/dashboard": { name: "xyne-spaces-dashboard", deps: ["@xyne/shared", "@xyne/icons"] },
  "apps/xyne-claw": { name: "xyne-claw", deps: ["xyne-claw-shared"] },
  "packages/shared": { name: "@xyne/shared" },
  "packages/icons": { name: "@xyne/icons" },
  "packages/framework": { name: "agentic-framework" },
  "packages/xyne-claw-shared": { name: "xyne-claw-shared" },
};

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function repo(): string {
  const top = mkdtempSync(join(tmpdir(), "shrike-ci-"));
  const w = (rel: string, text: string) => (mkdirSync(dirname(join(top, rel)), { recursive: true }), writeFileSync(join(top, rel), text));
  w("package.json", JSON.stringify({ name: "spaces", private: true }));
  w("pnpm-workspace.yaml", `# members\npackages:\n${Object.keys(PKGS).map((d) => `  - ${d}`).join("\n")}\n`);
  for (const [d, p] of Object.entries(PKGS)) w(`${d}/package.json`, JSON.stringify({ name: p.name, dependencies: Object.fromEntries((p.deps ?? []).map((x) => [x, "workspace:*"])) }));
  w(".github/workflows/CI-pr.yml", CI_PR);
  w(".github/workflows/ci.yml", CI);
  w(".github/workflows/schema-migration-check.yml", SCHEMA);
  w(".github/workflows/helm-charts-ci.yml", HELM);
  w(".github/workflows/nix-ci.yml", NIX);
  w(".github/workflows/CI-push.yml", PUSH);
  w("apps/xyne-claw/src/a.ts", "export const a = 1;\n");
  mkdirSync(join(top, "node_modules"));
  git(top, "init", "-q", "-b", "main");
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "add", "-A");
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", "init");
  git(top, "remote", "add", "origin", "https://github.com/acme/spaces.git");
  git(top, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(top, "switch", "-qc", "feature/claw");
  return top;
}

test("ci-lessons: YAML reader covers what workflows and GitLab use", () => {
  const y = parseYaml(`# c\nname: "CI: x" # note\non: [push, pull_request]\nenv:\n  A: 'it''s'\n  B: plain text # gone\njobs:\n  j:\n    steps:\n    - uses: a/b@v1\n      with: { x: 1, y: [p, q] }\n    - run: |\n        echo one\n\n        echo two\n    - run: >-\n        folded\n        line\n.base: &base\n  image: node:22\n  script: [npm ci]\nt:\n  <<: *base\n  stage: test\n`);
  assert.deepEqual(y, {
    name: "CI: x",
    on: ["push", "pull_request"],
    env: { A: "it's", B: "plain text" },
    jobs: { j: { steps: [{ uses: "a/b@v1", with: { x: "1", y: ["p", "q"] } }, { run: "echo one\n\necho two\n" }, { run: "folded line" }] } },
    ".base": { image: "node:22", script: ["npm ci"] },
    t: { image: "node:22", script: ["npm ci"], stage: "test" },
  });
});

test("ci-lessons: expressions decide matrix steps and job ifs; unknown stays unknown", () => {
  const ctx = { matrix: { task: "lint" }, github: { event_name: "pull_request" }, env: { NODE_VERSION: "22" } };
  assert.equal(decideIf("matrix.task == 'lint'", ctx), true);
  assert.equal(decideIf("${{ matrix.task == 'build' }}", ctx), false);
  assert.equal(decideIf("github.event_name == 'merge_group' && vars.RUN_TEST_CASE == 'true'", ctx), false);
  assert.equal(decideIf("vars.USE_SELF_HOSTED_CI != 'true'", ctx), undefined);
  assert.equal(decideIf("always() && startsWith(github.event_name, 'PULL')", ctx), true);
  assert.equal(fill("node ${{ env.NODE_VERSION }} ${{ secrets.TOKEN }}", ctx), "node 22 ${{ secrets.TOKEN }}");
  assert.equal(evalExpr("format('{0}-{1}', 'a', matrix.task)", ctx), "a-lint");
});

test("ci-lessons: the pipeline map of a repo shaped like xyne-spaces", async () => {
  const top = repo();
  const { jobs, files } = await githubJobs({ top, branch: "feature/claw", base: "main", repo: "acme/spaces" });
  const by = (n: string) => jobs.find((j) => j.name === n)!;
  assert.ok(!files.includes(".github/workflows/CI-push.yml"), "a push-to-main workflow doesn't run for this branch");
  assert.deepEqual(jobs.filter((j) => j.workflow === "CI-pr").map((j) => j.name), ["ci / Backend typecheck + build", "ci / Dashboard lint", "ci / Dashboard typecheck", "ci / Dashboard build", "ci / Automation tests", "ci / xyne-claw typecheck", "ci / Secret scan (gitleaks)", "ci / Push report"]);
  const be = by("ci / Backend typecheck + build");
  assert.equal(be.node, "22");
  assert.deepEqual(be.env, { NODE_VERSION: "22", PNPM_FLAGS: "--frozen-lockfile --prod=false", NODE_OPTIONS: "--max-old-space-size=8192" });
  assert.deepEqual(be.services, [{ name: "postgres", image: "postgres:16", port: 5432 }]);
  assert.deepEqual(be.steps.map((s) => s.local), ["skip", "skip", "skip", "prep", "run", "run", "run"]);
  assert.equal(be.steps[3]!.run, "pnpm install --frozen-lockfile --prod=false --filter xyne-spaces-backend...");
  assert.deepEqual(by("ci / Dashboard typecheck").steps.filter((s) => s.local === "run").map((s) => s.run), ["pnpm --filter xyne-spaces-dashboard run format:check", "pnpm --filter xyne-spaces-dashboard run typecheck"]);
  assert.deepEqual(by("ci / Dashboard lint").steps.filter((s) => s.local === "run").map((s) => s.name), ["Lint (errors only)"]);
  assert.match(by("ci / Automation tests").off!, /Doesn't run on pull requests.*merge_group/);
  assert.equal(by("ci / Push report").stage, 1);
  assert.deepEqual(by("ci / Push report").secrets, ["JWT"]);
  assert.equal(by("ci / Push report").steps[0]!.local, "skip");
  assert.deepEqual(by("ci / Secret scan (gitleaks)").steps.map((s) => s.local), ["prep", "run"]);
  assert.deepEqual(by("Validate schema migrations").steps.map((s) => [s.local, s.why?.slice(0, 20)]), [["skip", "CI checks out the co"], ["skip", "Changes git state, w"], ["run", undefined]]);
  assert.deepEqual(by("Lint + template").paths, ["helm-charts/**", ".github/workflows/helm-charts-ci.yml"]);

  const pkgs = await workspacePackages(top);
  for (const j of jobs) j.scope = [...new Set([...j.scope, ...scopeOf(j, pkgs)])];
  assert.deepEqual(scopeOf(be, pkgs), ["apps/backend", "packages/framework", "packages/shared"]);
  const hit = (files: string[]) => jobs.filter((j) => touches(j, files)).map((j) => j.name);
  const everyChange = ["ci / Secret scan (gitleaks)", "ci / Push report", "Validate schema migrations"];
  assert.deepEqual(hit(["apps/xyne-claw/src/a.ts"]), ["ci / xyne-claw typecheck", ...everyChange]);
  assert.deepEqual(hit(["packages/shared/src/x.ts"]), ["ci / Backend typecheck + build", "ci / Dashboard lint", "ci / Dashboard typecheck", "ci / Dashboard build", ...everyChange]);
  assert.deepEqual(hit(["helm-charts/x/values.yaml"]), ["ci / Secret scan (gitleaks)", "ci / Push report", "Lint + template", "Validate schema migrations"]);
  assert.deepEqual(hit(["nix/scripts/check.sh"]), ["ci / Secret scan (gitleaks)", "ci / Push report", "Nix flake check", "Validate schema migrations"]);
  assert.ok(hit(["pnpm-lock.yaml"]).includes("ci / xyne-claw typecheck") && !hit(["pnpm-lock.yaml"]).includes("Nix flake check"), "the lockfile matters to package jobs only");
});

test("ci-lessons: GitLab, Jenkins and CircleCI as far as their plain parts go", () => {
  const gl = gitlabJobs(`stages: [build, test]\nvariables:\n  NODE_ENV: test\n.node: &node\n  image: node:20\nlint:\n  <<: *node\n  stage: build\n  script:\n    - npm ci\n    - npm run lint\nunit:\n  extends: .node\n  stage: test\n  needs: [lint]\n  services: [postgres:15]\n  script: npm test\n  rules:\n    - changes: [src/**/*]\ndeploy:\n  stage: test\n  when: manual\n  script: ./deploy.sh\n`);
  assert.deepEqual(gl.map((j) => [j.name, j.stage, j.stageName, j.node ?? null, j.steps.map((s) => s.local)]), [["lint", 0, "build", "20", ["prep", "run"]], ["unit", 1, "test", "20", ["run"]], ["deploy", 1, "test", null, ["run"]]]);
  assert.deepEqual(gl[1]!.paths, ["src/**/*"]);
  assert.deepEqual(gl[1]!.needs, [".gitlab-ci.yml#lint"]);
  assert.match(gl[2]!.off!, /by hand/);
  const jk = jenkinsJobs(`pipeline { stages {\n stage('Build') { steps { sh 'npm ci'\n sh "npm run build" } }\n stage("Test") { steps { sh '''\nnpm test\n''' } }\n} }`);
  assert.deepEqual(jk.map((j) => [j.name, j.stage, j.steps.map((s) => s.run)]), [["Build", 0, ["npm ci", "npm run build"]], ["Test", 1, ["npm test"]]]);
  const cc = circleJobs(`version: 2.1\njobs:\n  test:\n    docker:\n      - image: cimg/node:22.1\n    steps:\n      - checkout\n      - run: npm test\n      - run:\n          name: Lint\n          command: npm run lint\nworkflows:\n  main:\n    jobs:\n      - test\n      - deploy:\n          requires: [test]\n`);
  assert.deepEqual(cc.map((j) => [j.name, j.node, j.steps.map((s) => `${s.local}:${s.name}`)]), [["test", "22.1", ["skip:checkout", "run:npm test", "run:Lint"]]]);
});

test("ci-lessons: recorded history gives failure rates, flaky jobs and the kind of each failure", () => {
  const runs: RunJobs[] = [
    { run: { databaseId: 37917833838, headSha: "aaa", conclusion: "failure", attempt: 1, createdAt: "2026-10-09T10:27:40Z" }, jobs: VIEW_37917833838.jobs },
    { run: { databaseId: 37914292195, headSha: "bbb", conclusion: "failure", attempt: 1, createdAt: "2026-10-09T09:57:50Z" }, jobs: VIEW_37914292195.jobs },
    { run: { databaseId: 900, headSha: "ccc", conclusion: "success", attempt: 2, createdAt: "2026-10-08T09:00:00Z" }, jobs: [{ name: "ci / Backend typecheck + build", conclusion: "success" }], before: [{ name: "ci / Backend typecheck + build", conclusion: "failure" }] },
    { run: { databaseId: 901, headSha: "bbb", conclusion: "success", attempt: 1, createdAt: "2026-10-09T09:40:00Z" }, jobs: [{ name: "ci / Dashboard lint", conclusion: "success" }] },
  ];
  const s = historyStats(runs);
  assert.deepEqual(s.get("ci / Dashboard lint"), { runs: 3, fails: 2, flaky: 1, lastFail: { run: 37917833838, job: 113778252972, at: "2026-10-09T10:27:40Z" } });
  assert.equal(s.get("ci / Backend typecheck + build")!.flaky, 1, "failed on attempt 1, passed on the re-run");
  assert.equal(s.get("ci / Backend typecheck + build")!.seconds, 233);
  assert.equal(s.get("ci / Automation tests"), undefined, "skipped jobs don't count");

  const f = cleanLog(LOG_FORMAT);
  assert.equal(f.command, "pnpm --filter xyne-spaces-dashboard run format:check");
  assert.deepEqual(classify(f.lines).kind, "format");
  assert.match(classify(f.lines).line, /^\[warn\] Code style issues found in 3 files/);
  const l = classify(cleanLog(LOG_LINT).lines);
  assert.equal(l.kind, "lint");
  assert.match(l.line, /671:19 {2}error {2}Element must have data-track-category/);
  const i = classify(cleanLog(LOG_LOCKFILE).lines);
  assert.equal(i.kind, "install");
  assert.match(i.line, /ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/);
  assert.equal(classify(["src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."]).kind, "types");
  assert.equal(classify(["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"]).kind, "memory");
});

test("ci-lessons: verdicts and local-vs-hosted comparison", () => {
  const leg = (name: string, state: "pass" | "fail" | "skipped") => ({ job: name, name, state });
  assert.deepEqual(verdictOf([leg("a", "pass"), leg("b", "fail")]), { safe: false, verdict: "Fix 1 thing before you push" });
  assert.deepEqual(verdictOf([leg("a", "pass"), leg("b", "skipped")]), { safe: true, verdict: "Safe to push" });
  assert.equal(verdictOf([]).verdict, "No CI job looks at these files. Safe to push");
  assert.deepEqual(compare([leg("a", "pass"), leg("b", "pass")], [{ name: "a", state: "pass" }, { name: "b", state: "fail" }]), { matched: false, first: "b", surprises: ["b"], caught: [] });
  assert.deepEqual(compare([leg("a", "fail")], [{ name: "a", state: "fail" }, { name: "z", state: "fail" }]), { matched: true, surprises: [], caught: ["a"] });
  assert.equal(compare([leg("a", "skipped")], [{ name: "a", state: "fail" }]).matched, false, "nothing ran, nothing to agree on");
});

// ---- the service, end to end on a scratch repo: learn, pre-flight, hosted CI disagrees, the lesson, CI agrees, kept ----

const exec: Exec = (cmd, args, o) =>
  new Promise((done) => {
    const c = execFile(cmd, args, { cwd: o.cwd, encoding: "utf8" }, (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    c.stdin?.end(o.input ?? "");
  });

test("ci-lessons: learn, pre-flight, a surprise from CI rewrites the lessons, a match keeps them", async () => {
  const top = repo();
  const base = mkdtempSync(join(tmpdir(), "shrike-ci-state-"));
  const dirs: SkillDirs = { builtin: join(repoRoot, "prompts", "skills"), project: top, personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
  const skillEvents: SkillEvent[] = [];
  configureSkills(() => dirs, ((ch: keyof ShrikeEvents, p: unknown) => void (ch === "skill:event" && skillEvents.push(p as SkillEvent))) as never);

  // fake gh: history reads, then the hosted runs of the pushed commit
  let hostedJobs: { name: string; conclusion: string; databaseId: number }[] = [];
  const calls: string[][] = [];
  const gh: Gh = {
    run: async (a) => {
      calls.push(a);
      const k = a.slice(0, 2).join(" ");
      if (a[0] === "--version" || k === "auth status") return { code: 0, stdout: "ok", stderr: "" };
      if (k === "run list" && a.includes("--commit")) return { code: 0, stdout: JSON.stringify(hostedJobs.length ? [{ databaseId: 7, workflowName: "CI-pr", status: "completed", conclusion: "failure", event: "pull_request" }] : []), stderr: "" };
      if (k === "run list") return { code: 0, stdout: JSON.stringify([{ databaseId: 37917833838, workflowName: "CI-pr", headSha: "aaa", conclusion: "failure", attempt: 1, event: "pull_request", createdAt: "2026-10-09T10:27:40Z" }]), stderr: "" };
      if (k === "run view" && a.includes("--log-failed")) return { code: 0, stdout: a.includes("113778253043") ? LOG_FORMAT : a.includes("55") ? "ci / xyne-claw typecheck\tTypecheck\t2026-10-09T10:00:00Z src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n" : LOG_LINT, stderr: "" };
      if (k === "run view" && a[2] === "7") return { code: 0, stdout: JSON.stringify({ jobs: hostedJobs }), stderr: "" };
      if (k === "run view") return { code: 0, stdout: JSON.stringify(VIEW_37917833838), stderr: "" };
      return { code: 1, stdout: "", stderr: `fake gh: ${a.join(" ")}` };
    },
  };

  const ran: string[] = [];
  let failNext = "";
  const run: Runner = async (cmd, o) => {
    if (cmd.startsWith("command -v")) return { code: 0, output: cmd.includes("gitleaks") ? "missing:gitleaks\n" : "", timedOut: false };
    if (cmd === "node --version") return { code: 0, output: "v24.3.0\n", timedOut: false };
    ran.push(cmd);
    o.onLine(`running ${cmd}`);
    if (failNext && cmd.includes(failNext)) return { code: 1, output: "src/a.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\n", timedOut: false };
    return { code: 0, output: "ok\n", timedOut: false };
  };
  const emitted: CiLessonsState[] = [];
  const mastered: { job: string; learned: string }[] = [];
  const approvals: string[] = [];
  const xp: [string, number][] = [];
  const svc = createCiLessons({
    root: () => top,
    name: () => "spaces",
    gh,
    exec,
    state: join(base, "state"),
    dirs: () => dirs,
    emit: (s) => emitted.push(s),
    mastered: (m) => mastered.push(m),
    approve: async (title, reason) => (approvals.push(`${title}\n${reason}`), true),
    brain: async () => null, // no brain answers: the map's own text is kept
    startAgent: async () => ({ id: "r1", goal: "", brain: "claude-code", status: "running", startedAt: 0 }) as never,
    redact: (t) => t,
    xp: async (k, n) => void xp.push([k, n]),
    run,
    pollMs: 5,
  });

  // CI1 + CI2: the map with history, then the lessons file v1
  const st = await svc.state();
  assert.equal(st.ready, true);
  assert.equal(st.pipeline!.history.runs, 1);
  const dash = st.pipeline!.jobs.find((j) => j.name === "ci / Dashboard typecheck")!;
  assert.deepEqual(dash.stats, { runs: 1, fails: 1, flaky: 0, last: { kind: "format", line: "[warn] Code style issues found in 3 files. Run Prettier with --write to fix.", at: "2026-10-09T10:27:40Z" } });
  await svc.learn();
  const file = join(top, ".shrike", "skills", "ci-lessons.md");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^---\nname: CI lessons for spaces\nwhen: Before you push spaces/);
  assert.match(text, /### ci \/ Backend typecheck \+ build[\s\S]*Node 22[\s\S]*1\. `pnpm --filter @xyne\/shared --filter agentic-framework run build`/);
  assert.match(text, /\*\*format\*\* \(seen in ci \/ Dashboard typecheck/);
  assert.deepEqual(legsOf(text)!.find((l) => l.job === "ci / xyne-claw typecheck"), { job: "ci / xyne-claw typecheck", run: ["pnpm --filter xyne-claw run typecheck"], env: { NODE_VERSION: "22", PNPM_FLAGS: "--frozen-lockfile --prod=false" } });
  assert.ok(skillEvents.some((e) => e.kind === "acquired" && e.skillId === "ci-lessons"), "[Skill Acquired]");

  // CI3: a change in xyne-claw runs only its legs; gitleaks isn't installed here; a non-config command would ask
  writeFileSync(join(top, "apps/xyne-claw/src/a.ts"), "export const a = 2;\n");
  const r1 = await svc.preflight();
  assert.equal(r1.from, "skill");
  assert.deepEqual(r1.legs.map((l) => [l.name, l.state]), [["ci / xyne-claw typecheck", "pass"], ["ci / Secret scan (gitleaks)", "skipped"], ["Validate schema migrations", "pass"]]);
  assert.match(r1.legs[1]!.why!, /Needs gitleaks/);
  assert.deepEqual(ran, ["pnpm --filter xyne-claw run typecheck", "bash scripts/validate-schema-migrations.sh --ci-mode"]);
  assert.equal(r1.verdict, "Safe to push");
  assert.ok(r1.warnings.some((w) => w === "CI uses Node 22, this computer has Node 24. Results can differ."));
  assert.equal(approvals.length, 1, "allowed commands run; a repo script asks first (R6)");
  assert.match(approvals[0]!, /^Run the "Validate schema migrations" check here, like CI\?\nPre-flight runs this command in the project:\n\nbash scripts\/validate-schema-migrations\.sh --ci-mode\n {2}\(Run the script/);

  // CI5: commit and "push"; CI goes red on xyne-claw: a surprise; the gate says not learned; the lesson becomes a draft
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qam", "claw");
  const sha = git(top, "rev-parse", "HEAD");
  hostedJobs = [{ name: "ci / xyne-claw typecheck", conclusion: "failure", databaseId: 55 }, { name: "Validate schema migrations", conclusion: "success", databaseId: 56 }];
  svc.observe("scm:update", { commits: [{ sha, pushed: true }] });
  const wait = async (what: string, fn: () => Promise<boolean> | boolean) => {
    for (let k = 0; k < 400; k++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out: ${what}`);
  };
  await wait("the surprise to be recorded", async () => (await listDrafts(dirs)).some((d) => d.skillId === "ci-lessons" && d.status === "pending"));
  const s2 = await svc.state();
  assert.deepEqual(s2.record, { pushes: ["surprise"], surprises: 1, streak: 0 });
  assert.equal(s2.run!.hosted!.matched, false);
  assert.equal(s2.run!.hosted!.first, "ci / xyne-claw typecheck");
  const draft = (await listDrafts(dirs)).find((d) => d.status === "pending")!;
  assert.match(draft.reason, /CI went red on xyne-claw typecheck after the pre-flight said green/);
  assert.equal((await loadSkills(dirs)).find((s) => s.id === "ci-lessons")!.version, 1, "the skill file is untouched until CI agrees");

  // the next pre-flight tries the draft; it's red here too now, and CI agrees: the draft is kept, [Lesson Mastered]
  writeFileSync(join(top, "apps/xyne-claw/src/a.ts"), "export const a = 3;\n");
  failNext = "xyne-claw run typecheck";
  ran.length = 0;
  const r2 = await svc.preflight();
  assert.equal(r2.from, "draft");
  assert.deepEqual(r2.legs.map((l) => [l.name, l.state, l.kind ?? null]), [["ci / xyne-claw typecheck", "fail", "types"], ["ci / Secret scan (gitleaks)", "skipped", null], ["Validate schema migrations", "pass", null]]);
  assert.equal(r2.verdict, "Fix 1 thing before you push");
  assert.equal(approvals.length, 1, "an allowed command isn't asked again");
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qam", "claw 2");
  const sha2 = git(top, "rev-parse", "HEAD");
  svc.observe("scm:update", { commits: [{ sha: sha2, pushed: true }] });
  await wait("the match to keep the draft", async () => (await loadSkills(dirs)).find((s) => s.id === "ci-lessons")!.version === 2 && mastered.length > 0);
  const kept = readFileSync(file, "utf8");
  assert.match(kept, /## Lessons\n\n- CI went red on xyne-claw typecheck after the pre-flight said green \(a type error: "src\/a\.ts\(1,14\): error TS2322/);
  assert.match(kept, /## Changelog\n\n- v2: CI went red on xyne-claw typecheck/);
  assert.deepEqual(mastered.map((m) => m.job), ["xyne-claw typecheck"]);
  const s3 = await svc.state();
  assert.deepEqual(s3.record.pushes, ["surprise", "caught"]);
  assert.equal(xp.length, 0, "no XP while CI is red");

  // a clean push: pre-flight green, CI green: XP once for that commit
  failNext = "";
  writeFileSync(join(top, "apps/xyne-claw/src/a.ts"), "export const a = 4;\n");
  await svc.preflight();
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qam", "claw 3");
  hostedJobs = [{ name: "ci / xyne-claw typecheck", conclusion: "success", databaseId: 57 }];
  svc.observe("scm:update", { commits: [{ sha: git(top, "rev-parse", "HEAD"), pushed: true }] });
  await wait("the clean push", () => xp.length > 0);
  assert.deepEqual(xp, [[`ci-clean:${top}:${git(top, "rev-parse", "HEAD")}`, 15]]);
  assert.deepEqual((await svc.state()).record, { pushes: ["surprise", "caught", "clean"], surprises: 1, streak: 1 });
  assert.ok(existsSync(join(base, "state", "ci-lessons")));

  // a lesson drafted after the pre-flight ran was never tried: CI agreeing doesn't keep it
  writeFileSync(join(top, "apps/xyne-claw/src/a.ts"), "export const a = 5;\n");
  await svc.preflight();
  await svc.learnLesson({ lesson: "Untried: run the claw build too." });
  git(top, "-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qam", "claw 4");
  hostedJobs = [{ name: "ci / xyne-claw typecheck", conclusion: "success", databaseId: 58 }];
  svc.observe("scm:update", { commits: [{ sha: git(top, "rev-parse", "HEAD"), pushed: true }] });
  await wait("the second clean push", () => xp.length > 1);
  assert.equal((await loadSkills(dirs)).find((s) => s.id === "ci-lessons")!.version, 2, "an untried draft isn't kept");
  assert.ok((await listDrafts(dirs)).some((d) => d.status === "pending" && /Untried/.test(d.reason)));

  // a setting a lesson adds asks first, even on a command from the CI config
  const pending = (await listDrafts(dirs)).find((d) => d.status === "pending")!;
  assert.ok(pending);
  const skillFile = readFileSync(file, "utf8");
  const body = skillFile.replace(/^---[\s\S]*?\n---\n\n/, "").replace(/\s*## Changelog[\s\S]*$/, "");
  const legs = legsOf(body)!;
  legs.find((l) => l.job === "ci / xyne-claw typecheck")!.env = { NODE_OPTIONS: "--require ./x.js" };
  await svc.learnLesson({ lesson: "Env lesson." }); // replaces the untried draft
  const { proposeUpdate } = await import("./skills.ts");
  await proposeUpdate(dirs, { skillId: "ci-lessons", reason: "env", after: body.replace(/```json\n[\s\S]*?\n```/, `\`\`\`json\n${JSON.stringify({ legs })}\n\`\`\``), runId: "ci-lessons" });
  writeFileSync(join(top, "apps/xyne-claw/src/a.ts"), "export const a = 6;\n");
  const before = approvals.length;
  const r5 = await svc.preflight();
  assert.equal(r5.from, "draft");
  assert.equal(approvals.length, before + 1);
  assert.match(approvals.at(-1)!, /env NODE_OPTIONS=--require \.\/x\.js\n {2}\(Written in the CI lessons/);

  for (const a of calls) assert.ok(/^(--version|auth status|run list|run view)$/.test(a[0] === "--version" ? "--version" : a.slice(0, 2).join(" ")), `gh only reads: ${a.join(" ")}`);
  svc.dispose();
});
