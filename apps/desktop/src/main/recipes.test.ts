import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, renderTemplate, runSkillFor } from "../renderer/src/recipes/catalog.ts";
import { runSkillId } from "./start/runskill.ts";
import { listRecipes, recipeFiles, resetRecipe, resolveRecipe, saveRecipe } from "./recipes.ts";
import type { SkillDirs } from "./skills.ts";

function fixture(): SkillDirs {
  const base = mkdtempSync(join(tmpdir(), "shrike-recipes-"));
  const d: SkillDirs = { builtin: join(base, "builtin"), project: join(base, "proj"), personal: join(base, "home/.shrike/skills"), claude: join(base, "claude"), state: join(base, "state") };
  for (const p of [d.builtin, join(d.project!, ".shrike/skills"), d.personal, d.state]) mkdirSync(p, { recursive: true });
  writeFileSync(join(d.builtin, "review-pr.md"), "---\nname: Review a pull request\nwhen: Review it\n---\n\n1. Read the diff.\n");
  writeFileSync(join(d.builtin, "starting-apps.md"), "---\nname: Starting apps\nwhen: Run\n---\n\nGeneric lessons.\n");
  writeFileSync(join(d.project!, ".shrike/skills/run-todo.md"), "---\nname: Run todo\nwhen: Start todo\nkind: run\n---\n\n1. pnpm dev\n");
  return d;
}

test("variables render in one pass; unknown ones stay visible", () => {
  assert.equal(renderTemplate("{basePrompt}\n\n{branch} into {baseBranch}: {typo}", { basePrompt: "Steps", branch: "fix/x", baseBranch: "main" }), "Steps\n\nfix/x into main: {typo}");
  assert.equal(renderTemplate("{context}", { context: "diff has {branch} and $& in it", branch: "no" }), "diff has {branch} and $& in it");
  assert.equal(renderTemplate("{constructor} {toString}", {}), "{constructor} {toString}");
});

test("CLI arguments: model flags only", () => {
  assert.deepEqual(parseArgs(" --model opus  --fallback-model=sonnet "), ["--model", "opus", "--fallback-model", "sonnet"]);
  assert.deepEqual(parseArgs(""), []);
  assert.throws(() => parseArgs("--dangerously-skip-permissions"), /isn't allowed/);
  assert.throws(() => parseArgs("--model"), /needs a model name/);
  assert.throws(() => parseArgs("--model $(rm -rf ~)"), /needs a model name/);
});

test("project overrides personal overrides built-in; reset goes back to built-in", async () => {
  const d = fixture();
  const f = recipeFiles(d);
  let r = (await listRecipes(d)).find((x) => x.id === "review-pr")!;
  assert.equal(r.from, "builtin");
  assert.equal(r.template, r.defaultTemplate);

  await saveRecipe(d, "review-pr", { template: "Mine: {basePrompt}", agent: "builtin", args: "--model opus" }, "personal");
  assert.ok(f.personal.endsWith(join("home", ".shrike", "recipes.json")));
  r = (await listRecipes(d)).find((x) => x.id === "review-pr")!;
  assert.deepEqual([r.from, r.template, r.agent, r.args], ["personal", "Mine: {basePrompt}", "builtin", "--model opus"]);

  r = (await saveRecipe(d, "review-pr", { template: "Here: {basePrompt} on {branch}" }, "project")).find((x) => x.id === "review-pr")!;
  assert.deepEqual([r.from, r.template, r.agent], ["project", "Here: {basePrompt} on {branch}", "builtin"], "fields the project leaves unset come from personal");

  const out = await resolveRecipe("review-pr", { branch: "fix/a", context: "ctx" }, d);
  assert.equal(out.prompt, "Here: 1. Read the diff. on fix/a");
  assert.equal(out.skillId, "review-pr");
  assert.equal(out.brain, "builtin");
  assert.deepEqual(out.args, ["--model", "opus"]);

  r = (await resetRecipe(d, "review-pr")).find((x) => x.id === "review-pr")!;
  assert.deepEqual([r.from, r.template, r.agent], ["personal", "Mine: {basePrompt}", "builtin"], "reset in a project goes back to your default");
  r = (await resetRecipe(d, "review-pr")).find((x) => x.id === "review-pr")!;
  assert.deepEqual([r.from, r.template, r.agent, r.args], ["builtin", r.defaultTemplate, "default", ""]);
  assert.deepEqual(JSON.parse(readFileSync(f.personal, "utf8")), { recipes: {} });
});

test("a project can go back to built-in values over your default, and keeps inheriting what it didn't change", async () => {
  const d = fixture();
  const def = (await listRecipes(d)).find((x) => x.id === "review-pr")!.defaultTemplate;
  await saveRecipe(d, "review-pr", { template: "MINE {context}", agent: "builtin", args: "--model opus" }, "personal");
  let r = (await saveRecipe(d, "review-pr", { template: def, agent: "default", args: "" }, "project")).find((x) => x.id === "review-pr")!;
  assert.deepEqual([r.from, r.template, r.agent, r.args], ["project", def, "default", ""]);
  await resetRecipe(d, "review-pr");
  await saveRecipe(d, "review-pr", { template: "HERE {context}", agent: "builtin", args: "--model opus" }, "project");
  assert.deepEqual(JSON.parse(readFileSync(recipeFiles(d).project!, "utf8")).recipes["review-pr"], { template: "HERE {context}" }, "inherited fields aren't frozen into the project");
  await saveRecipe(d, "review-pr", { agent: "claude-code" }, "personal");
  r = (await listRecipes(d)).find((x) => x.id === "review-pr")!;
  assert.equal(r.agent, "claude-code", "a later change to your default still reaches the project");
});

test("wired actions hand over just the context by default; the agent loads the skill itself", async () => {
  const d = fixture();
  const out = await resolveRecipe("review-pr", { context: "CTX", branch: "x", baseBranch: "main" }, d);
  assert.deepEqual([out.prompt, out.skillId], ["CTX", "review-pr"]);
  for (const n of ["todo", "@acme/Web App", "!!!"]) assert.equal(runSkillFor(n), runSkillId(n));
});

test("saving the built-in template stores nothing; bad input is refused", async () => {
  const d = fixture();
  const def = (await listRecipes(d)).find((x) => x.id === "fix")!.defaultTemplate;
  await saveRecipe(d, "fix", { template: def, agent: "default", args: "" }, "project");
  assert.deepEqual(JSON.parse(readFileSync(recipeFiles(d).project!, "utf8")), { recipes: {} });
  await assert.rejects(saveRecipe(d, "fix", { agent: "codex" }, "project"), /can't start that agent/);
  await assert.rejects(saveRecipe(d, "fix", { args: "--tools Bash" }, "project"), /isn't allowed/);
  await assert.rejects(saveRecipe(d, "nope", {}, "project"), /no action/);
  writeFileSync(recipeFiles(d).project!, "{ not json");
  await assert.rejects(saveRecipe(d, "fix", { template: "x" }, "project"), /Fix it or delete it/);
  assert.equal(readFileSync(recipeFiles(d).project!, "utf8"), "{ not json", "a file Shrike can't read is never overwritten");
});

test("get it running uses the project's run skill; unconfigured falls back to the built-in template", async () => {
  const d = fixture();
  await saveRecipe(d, "get-running", { template: "{basePrompt}\n---\n{context}" }, "project");
  const out = await resolveRecipe("get-running", { project: "todo", context: "Get todo running" }, d);
  assert.equal(out.skillId, "run-todo");
  assert.equal(out.prompt, "1. pnpm dev\n---\nGet todo running");
  const bare = await resolveRecipe("broken-checks", { context: "The check failed" }, { ...d, personal: "/nonexistent/x", builtin: "/nonexistent/y", project: undefined });
  assert.equal(bare.prompt, "The check failed");
  assert.equal(bare.brain, undefined);
});
