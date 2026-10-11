import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkTools, missingFrom, nodeAgentOk, projectNeeds, type Probe } from "./tools.ts";

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "shrike-tools-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
};
// A computer with these tools: the command's first word → what `--version` prints.
const computer = (have: Record<string, string>): Probe => async (cmd) => have[cmd.split(" ")[0]!.replace(/^".*\/(python)"$/, "venv-$1")];

test("missing tools: what a project needs, and what this computer lacks, with the command to get it", async () => {
  const pnpmApp = project({ "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }), "docker-compose.yml": "" });
  const files = ["package.json", "docker-compose.yml"];
  assert.deepEqual(projectNeeds(pnpmApp, files, "darwin"), { node: true, pm: "pnpm", uv: false, docker: true });

  // No Node: Run stops before Claude, with Homebrew's command when it's there and the download page always.
  let tools = await checkTools(pnpmApp, files, { os: "darwin", run: computer({ brew: "Homebrew 4.6" }) });
  assert.deepEqual(tools.map((t) => [t.tool, t.blocking, t.command]), [["node", true, "brew install node"], ["docker", false, "brew install --cask docker"]]);
  assert.equal(tools[0]!.url, "https://nodejs.org/en/download");
  assert.doesNotMatch(tools.map((t) => t.message).join(" "), /—/);

  // Node but no pnpm, and no Homebrew: npm can get it.
  tools = await checkTools(pnpmApp, files, { os: "linux", run: computer({ node: "v22.12.0", docker: "Docker 27" }) });
  assert.deepEqual(tools.map((t) => [t.tool, t.blocking, t.command]), [["pnpm", true, "npm install -g pnpm"]]);

  // Node too old for node-agent: still runs, says so, and the runner leaves NODE_OPTIONS alone.
  tools = await checkTools(pnpmApp, files, { os: "darwin", run: computer({ node: "v16.20.2", pnpm: "8.0.0", docker: "Docker 27" }) });
  assert.deepEqual(tools.map((t) => [t.tool, t.blocking, t.found]), [["node", false, "v16.20.2"]]);
  assert.equal(await nodeAgentOk(pnpmApp), false);
  await checkTools(pnpmApp, files, { os: "darwin", run: computer({ node: "v18.20.4", pnpm: "8.0.0", docker: "Docker 27" }) });
  assert.equal(await nodeAgentOk(pnpmApp), true);

  // Python: none blocks; older than 3.12 only says steps need 3.12; the project's venv is what counts.
  const py = project({ "requirements.txt": "fastapi", "api/.venv/bin/python": "", "api/requirements.txt": "fastapi" });
  const pyFiles = ["requirements.txt", "api/requirements.txt"];
  assert.deepEqual((await checkTools(py, pyFiles, { os: "darwin", run: computer({}) })).map((t) => [t.tool, t.blocking, t.url]), [["python", true, "https://www.python.org/downloads/"]]);
  tools = await checkTools(py, pyFiles, { os: "darwin", run: computer({ python3: "Python 3.13.0", "venv-python": "Python 3.9.6" }) });
  assert.deepEqual(tools.map((t) => [t.tool, t.blocking, t.found]), [["python", false, "3.9.6"]]);
  assert.match(tools[0]!.message, /older than 3\.12.*still runs/);
  // uv brings its own Python.
  assert.deepEqual(await checkTools(project({ "pyproject.toml": "", "uv.lock": "" }), ["pyproject.toml", "uv.lock"], { os: "darwin", run: computer({ uv: "uv 0.8" }) }), []);

  // Nix projects: Nix is the one thing to have.
  const nix = project({ "flake.nix": "", "package.json": "{}" });
  assert.deepEqual((await checkTools(nix, ["flake.nix", "package.json"], { os: "darwin", run: computer({}) })).map((t) => [t.tool, t.blocking]), [["nix", true]]);
  assert.deepEqual(await checkTools(nix, ["flake.nix", "package.json"], { os: "darwin", run: computer({ nix: "nix 2.24" }) }), []);

  // Windows: winget.
  assert.equal((await checkTools(pnpmApp, files, { os: "win32", run: computer({ docker: "Docker 27" }) }))[0]!.command, "winget install OpenJS.NodeJS.LTS");
});

test("missing tools: a step that hit a missing runtime names it, other missing commands don't", () => {
  assert.equal(missingFrom("zsh:1: command not found: docker")?.tool, "docker");
  assert.equal(missingFrom("/bin/bash: line 1: pnpm: command not found")?.tool, "pnpm");
  assert.equal(missingFrom("'node' is not recognized as an internal or external command")?.tool, "node");
  assert.equal(missingFrom("sh: vite: command not found"), undefined, "the project's own tools come from its runner (npx, pnpm exec)");
});
