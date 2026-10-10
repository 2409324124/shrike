// CI1–CI8 in the built app on a scratch repo: the pipeline map, Learn this CI, pre-flight (an ask in the dock, a red leg, then green),
// a push CI disagrees with (the snap, a lesson draft), then a push CI agrees with ([Level Up], [Lesson Mastered]).
// gh is fake-gh-ci.mjs (reads only; writes are refused and asserted absent), Claude is fake-claude.mjs. Nothing reaches GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeClaude, gitIn, key, launch, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const WORKFLOW = `name: CI
on: [pull_request]
env:
  NODE_VERSION: "22"
jobs:
  typecheck:
    name: Typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Typecheck
        run: node scripts/check.mjs
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Lint
        run: cd src && bash ../scripts/lint.sh
  docs:
    name: Docs
    if: github.event_name == 'merge_group'
    runs-on: ubuntu-latest
    steps:
      - run: echo docs
`;
const CHECK = `import { readFileSync } from "node:fs";\nif (readFileSync("src/sum.mjs", "utf8").includes("BUG")) { console.error("src/sum.mjs(1,1): error TS2322: Type 'string' is not assignable to type 'number'."); process.exit(1); }\nconsole.log("types ok");\n`;
const GOOD = "export const sum = (a, b) => a + b;\n";
const BAD = "export const sum = (a, b) => a + b + 'BUG';\n";

test("ci lessons: map, learn, pre-flight, a surprise from CI, then a match that keeps the lesson", { timeout: 300_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "shrike-e2e-ci-"));
  const proj = join(base, "ci-demo");
  const w = (rel: string, text: string) => (mkdirSync(dirname(join(proj, rel)), { recursive: true }), writeFileSync(join(proj, rel), text));
  w("package.json", JSON.stringify({ name: "ci-demo", private: true, type: "module" }));
  w(".github/workflows/ci.yml", WORKFLOW);
  w("scripts/check.mjs", CHECK);
  w("scripts/lint.sh", "echo lint ok\n");
  w("src/sum.mjs", GOOD);
  mkdirSync(join(proj, "node_modules"));
  w(".gitignore", "node_modules\n");
  const remote = join(base, "origin.git");
  gitIn(base, "init", "-q", "--bare", "-b", "main", remote);
  gitIn(proj, "init", "-q", "-b", "main");
  gitIn(proj, "add", "-A");
  gitIn(proj, "commit", "-qm", "init");
  gitIn(proj, "remote", "add", "origin", remote);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  gitIn(proj, "switch", "-qc", "fix/sum");
  w("src/sum.mjs", BAD); // the change pre-flight looks at: red here

  const gh = mkdtempSync(join(tmpdir(), "shrike-e2e-gh-"));
  writeFileSync(join(gh, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-ci.mjs")}" "$@"\n`, { mode: 0o755 });
  const claude = fakeClaude(30);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(gh, "gh"), SHRIKE_FAKE_GH_DIR: gh, SHRIKE_CI_POLL_MS: "400", ...claude.env });
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    await openFolder(win);
    if (await win.getByRole("button", { name: "Close setup" }).count()) await win.getByRole("button", { name: "Close setup" }).click();
    await key(win, "Meta+Shift+KeyG");
    const dock = win.getByRole("complementary", { name: "Right dock" });
    const pf = dock.getByRole("region", { name: "Pre-flight" });
    await pf.getByText("2 of 2 CI jobs look at this change").waitFor({ timeout: 30_000 });

    // CI1: the pipeline view, with history read through gh
    await pf.getByRole("button", { name: "See the pipeline" }).click();
    const view = win.getByRole("dialog", { name: "CI lessons" });
    await view.getByRole("button", { name: /Typecheck/ }).waitFor();
    await view.getByText("not on pull requests").waitFor();
    await view.getByRole("button", { name: /Typecheck/ }).click();
    await view.getByText("node scripts/check.mjs").waitFor();
    await view.getByText(/Last failed on types/).waitFor({ timeout: 20_000 });
    await sleep(300);
    await shot(app, "01-pipeline", "ci");

    // CI2: Learn this CI writes the project's lessons skill (v1)
    await view.getByRole("button", { name: "Learn this CI" }).click();
    const skillFile = join(proj, ".shrike", "skills", "ci-lessons.md");
    await waitFor("the lessons skill", () => existsSync(skillFile), 60_000);
    assert.match(readFileSync(skillFile, "utf8"), /### Typecheck[\s\S]*1\. `node scripts\/check\.mjs`[\s\S]*## Legs/);
    await view.getByText(/ci-lessons v1/).waitFor({ timeout: 20_000 });
    await win.keyboard.press("Escape");

    // CI3: pre-flight; the lint script asks first (R6) right in the dock; typecheck goes red
    await pf.getByRole("button", { name: "Run pre-flight" }).click();
    const ask = pf.getByRole("group", { name: "Allow this?" });
    await ask.waitFor({ timeout: 30_000 });
    assert.match(await ask.innerText(), /cd src && bash \.\.\/scripts\/lint\.sh/);
    await sleep(200);
    await shot(app, "02-ask", "ci");
    await ask.getByRole("button", { name: "Allow" }).click();
    await pf.getByTestId("ci-verdict").waitFor({ timeout: 60_000 });
    assert.equal(await pf.getByTestId("ci-verdict").innerText(), "Fix 1 thing before you push");
    assert.match(await pf.getByTestId("ci-result").innerText(), /Typecheck\s*✗\s*\(a type error\)[\s\S]*Fix it[\s\S]*Lint\s*✓/i);
    await pf.getByText("src/sum.mjs(1,1): error TS2322").waitFor();
    await sleep(300);
    await shot(app, "03-red", "ci");

    // fixed: green, and the allowed command doesn't ask again
    writeFileSync(join(proj, "src/sum.mjs"), GOOD.replace("b;", "b; // ok"));
    await pf.getByRole("button", { name: "Run again" }).click();
    await waitFor("a green pre-flight", async () => (await pf.getByTestId("ci-verdict").innerText().catch(() => "")) === "Safe to push", 60_000);
    assert.equal(await pf.getByRole("group", { name: "Allow this?" }).count(), 0);
    await shot(app, "04-green", "ci");

    // CI5: push; CI goes red on Typecheck anyway: a surprise, the snap, and a lesson draft
    writeFileSync(join(gh, "hosted.json"), JSON.stringify({ run: 700, jobs: [{ databaseId: 9100, name: "Typecheck", conclusion: "failure", status: "completed" }, { databaseId: 9101, name: "Lint", conclusion: "success", status: "completed" }] }));
    gitIn(proj, "commit", "-qam", "Fix sum");
    gitIn(proj, "push", "-q", "-u", "origin", "fix/sum");
    await pf.getByText("Last push · CI disagreed on Typecheck. Shrike is learning why").waitFor({ timeout: 60_000 });
    await pf.getByRole("button", { name: "See the pipeline" }).click();
    await view.locator("tr.snap").getByText("Typecheck").waitFor();
    await view.getByText("surprise from CI in your last push").waitFor();
    await view.getByText(/1 trying/).waitFor({ timeout: 30_000 });
    await sleep(250);
    await shot(app, "05-surprise-snap", "ci");
    await win.keyboard.press("Escape");
    const drafts = await win.evaluate(() => window.shrike.listSkillDrafts());
    assert.ok(drafts.some((d) => d.skillId === "ci-lessons" && d.status === "pending" && /CI went red on Typecheck after the pre-flight said green/.test(d.reason)), JSON.stringify(drafts));

    // the next pre-flight tries the draft; red here and red in CI: they agree, so the lesson is kept
    writeFileSync(join(proj, "src/sum.mjs"), BAD);
    await pf.getByRole("button", { name: "Run pre-flight" }).click();
    await waitFor("a red pre-flight", async () => (await pf.getByTestId("ci-verdict").innerText().catch(() => "")) === "Fix 1 thing before you push", 60_000);
    gitIn(proj, "commit", "-qam", "Try again");
    gitIn(proj, "push", "-q");
    await win.getByRole("status", { name: /leveled up to level 2/ }).waitFor({ timeout: 60_000 });
    await shot(app, "06-level-up", "ci");
    await win.getByRole("status", { name: "Lesson mastered: Typecheck" }).waitFor({ timeout: 30_000 });
    await shot(app, "07-lesson-mastered", "ci");
    assert.match(readFileSync(skillFile, "utf8"), /^version: 2$/m);
    assert.match(readFileSync(skillFile, "utf8"), /## Changelog\n\n- v2: CI went red on Typecheck after the pre-flight said green/);

    // nothing but reads ever reached gh
    const calls = readFileSync(join(gh, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const writes = calls.filter((c) => !(c[0] === "--version" || ["auth status", "run list", "run view", "pr view", "pr list", "pr checks", "repo view"].includes(c.slice(0, 2).join(" ")) || (c[0] === "api" && c[1] === "graphql" && !c.some((x) => /^query=\s*mutation/.test(x)))));
    assert.deepEqual(writes, []);
  } catch (err) {
    await shot(app, "failure", "ci").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    claude.remove();
  }
});
