import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolNeed } from "@shrike/schema";
import { spawnShell } from "../platform.ts";

// Missing tools (docs/14): what a project needs on this computer, checked before Claude starts it. Shrike never installs a
// runtime; it says what's missing and how to get it. No Electron imports, so node:test drives every branch.

type Tool = ToolNeed["tool"];
export type Probe = (cmd: string, cwd: string) => Promise<string | undefined>; // the command's output, undefined when it couldn't run

/** Runs `cmd` in the user's shell (their PATH) and returns what it printed, or undefined when it failed or isn't there. */
export const probe: Probe = (cmd, cwd) =>
  new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawnShell(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return done(undefined);
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.once("error", () => {});
    child.once("close", (code) => (clearTimeout(timer), done(code === 0 ? out.trim() : undefined)));
  });

const NAMES: Record<Tool, string> = { node: "Node.js", npm: "npm", pnpm: "pnpm", yarn: "Yarn", bun: "Bun", python: "Python", uv: "uv", docker: "Docker", nix: "Nix", devbox: "Devbox", git: "Git" };
const URLS: Record<Tool, string> = {
  node: "https://nodejs.org/en/download",
  npm: "https://nodejs.org/en/download",
  pnpm: "https://pnpm.io/installation",
  yarn: "https://yarnpkg.com/getting-started/install",
  bun: "https://bun.sh",
  python: "https://www.python.org/downloads/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/get-docker/",
  nix: "https://nixos.org/download/",
  devbox: "https://www.jetify.com/devbox/docs/installing_devbox/",
  git: "https://git-scm.com/downloads",
};
const BREW: Partial<Record<Tool, string>> = { node: "brew install node", npm: "brew install node", pnpm: "brew install pnpm", yarn: "brew install yarn", bun: "brew install oven-sh/bun/bun", python: "brew install python@3.12", uv: "brew install uv", docker: "brew install --cask docker", git: "brew install git" };
const WINGET: Partial<Record<Tool, string>> = { node: "winget install OpenJS.NodeJS.LTS", npm: "winget install OpenJS.NodeJS.LTS", python: "winget install Python.Python.3.12", uv: "winget install astral-sh.uv", docker: "winget install Docker.DockerDesktop", git: "winget install Git.Git" };

/** The command to paste: Homebrew when it's there, winget on Windows, npm for a package manager when Node is there. */
export function installCommand(tool: Tool, o: { brew: boolean; os: NodeJS.Platform; npm: boolean }): string | undefined {
  if (o.brew && BREW[tool]) return BREW[tool];
  if (o.os === "win32" && WINGET[tool]) return WINGET[tool];
  if (o.npm && (tool === "pnpm" || tool === "yarn")) return `npm install -g ${tool}`;
  if (tool === "git" && o.os === "darwin") return "xcode-select --install";
  return undefined;
}

/** "v22.12.0" or "Python 3.9.6" → [22, 12, 0]. */
export const versionOf = (s: string | undefined): number[] | undefined => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
};
const atLeast = (v: number[], min: number[]) => v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= (min[2] ?? 0);

// node-agent loads through NODE_OPTIONS=--import with module.register: Node 18.19+. Older Node refuses to start at all with the flag.
export const NODE_AGENT_MIN = [18, 19, 0];
export const PYTHON_AGENT_MIN = [3, 12, 0];

export interface ProjectNeeds {
  node: boolean;
  pm?: "npm" | "pnpm" | "yarn" | "bun";
  python?: string; // the interpreter to check: the project's venv, else python3
  uv: boolean;
  docker: boolean;
  env?: "nix" | "devbox"; // tools come from the project's environment, not the PATH
}

/** What the project needs, from its setup files (scanner's setupFiles: repo-relative paths). */
export function projectNeeds(root: string, files: string[], os: NodeJS.Platform = process.platform): ProjectNeeds {
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const at = (f: string) => existsSync(join(root, f));
  let pm: ProjectNeeds["pm"];
  try {
    pm = /^(npm|pnpm|yarn|bun)@/.exec((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string }).packageManager ?? "")?.[1] as ProjectNeeds["pm"];
  } catch {}
  pm ??= at("pnpm-lock.yaml") || at("pnpm-workspace.yaml") ? "pnpm" : at("yarn.lock") ? "yarn" : at("bun.lockb") || at("bun.lock") ? "bun" : "npm";
  const node = has(/(^|\/)package\.json$/);
  const py = has(/(^|\/)(pyproject\.toml|requirements\.txt|Pipfile|uv\.lock|poetry\.lock|manage\.py)$/);
  const pyDirs = ["", ...new Set(files.filter((f) => /\/(pyproject\.toml|requirements\.txt|manage\.py)$/.test(f)).map((f) => f.replace(/\/[^/]+$/, "")))];
  const bin = os === "win32" ? "Scripts/python.exe" : "bin/python";
  const venv = pyDirs.flatMap((d) => [".venv", "venv"].map((v) => join(root, d, v, bin))).find(existsSync);
  return {
    node,
    ...(node ? { pm } : {}),
    ...(py ? { python: venv ? JSON.stringify(venv) : os === "win32" ? "python" : "python3" } : {}),
    uv: has(/(^|\/)uv\.lock$/),
    docker: has(/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/),
    ...(has(/^(flake\.nix|shell\.nix)$/) ? { env: "nix" as const } : has(/^devbox\.json$/) ? { env: "devbox" as const } : {}),
  };
}

let brewHere = false;
let nodeVersion: Promise<string | undefined> | undefined;

/** Node is fine for node-agent (or absent, so nothing to break). Checked once per Run; checkTools refreshes it. */
export async function nodeAgentOk(cwd: string, run: Probe = probe): Promise<boolean> {
  const v = versionOf(await (nodeVersion ??= run("node --version", cwd)));
  return !v || atLeast(v, NODE_AGENT_MIN);
}

/** What this computer is missing for the project: blocking ones stop Run before Claude starts, the rest are notes. */
export async function checkTools(root: string, files: string[], o: { run?: Probe; os?: NodeJS.Platform } = {}): Promise<ToolNeed[]> {
  const run = o.run ?? probe;
  const os = o.os ?? process.platform;
  const need = projectNeeds(root, files, os);
  const v = (cmd: string | false | undefined) => (cmd ? run(cmd, root) : Promise.resolve(undefined));
  const envTool = need.env;
  nodeVersion = run("node --version", root);
  const [node, pm, python, uv, docker, env, brew] = await Promise.all([
    nodeVersion,
    v(need.pm && `${need.pm} --version`),
    v(need.python && `${need.python} --version`),
    v((need.uv || need.python) && "uv --version"),
    v(need.docker && "docker --version"),
    v(envTool && `${envTool} --version`),
    v(os !== "win32" && "brew --version"),
  ]);
  brewHere = !!brew;
  const tip = (tool: Tool, found?: string): Pick<ToolNeed, "tool" | "name" | "url" | "command" | "found"> => {
    const command = installCommand(tool, { brew: brewHere, os, npm: !!node });
    return { tool, name: NAMES[tool], url: URLS[tool], ...(command ? { command } : {}), ...(found ? { found } : {}) };
  };
  const out: ToolNeed[] = [];
  if (envTool) {
    if (!env) out.push({ ...tip(envTool), blocking: true, message: `This project gets its tools from ${NAMES[envTool]}, and ${NAMES[envTool]} isn't on this computer.` });
    return out; // ponytail: Node, Python and the rest come from the environment; their versions are Claude's to check inside it
  }
  if (need.node && !node) out.push({ ...tip("node"), blocking: true, message: "Your app needs Node.js, and it isn't on this computer." });
  else if (need.node && !atLeast(versionOf(node) ?? [99], NODE_AGENT_MIN))
    out.push({ ...tip("node", node), blocking: false, message: `Node.js ${node} is older than 18.19, so Shrike can't see inside your server. Your app still runs, and Shrike records the page and its network calls.` });
  if (need.node && node && need.pm && !pm) out.push({ ...tip(need.pm), blocking: true, message: `This project uses ${NAMES[need.pm]}, and it isn't on this computer.` });
  if (need.python && !python && !(need.uv && uv)) out.push({ ...tip("python"), blocking: true, message: "Your app has Python code, and Python isn't on this computer." });
  else if (python && !atLeast(versionOf(python) ?? [99], PYTHON_AGENT_MIN))
    out.push({ ...tip("python", python.replace(/^Python\s*/i, "")), blocking: false, message: `Python ${python.replace(/^Python\s*/i, "")} is older than 3.12, so Shrike can't show the steps inside your Python server. Your app still runs, and Shrike records the page and its network calls.` });
  if (need.uv && !uv) out.push({ ...tip("uv"), blocking: false, message: "This project uses uv, and it isn't on this computer. Claude tries pip instead." });
  if (need.docker && !docker) out.push({ ...tip("docker"), blocking: false, message: "This project has a Docker Compose file, and Docker isn't on this computer. If your app needs its databases from Docker, install it first." });
  return out;
}

// The commands that are runtimes or package managers: when one isn't there, retrying another way won't help.
const RUNTIMES: Record<string, Tool> = { node: "node", npm: "npm", npx: "npm", pnpm: "pnpm", yarn: "yarn", bun: "bun", python: "python", python3: "python", pip: "python", pip3: "python", uv: "uv", docker: "docker", nix: "nix", devbox: "devbox", git: "git" };

/** A runtime the output says isn't installed ("zsh:1: command not found: node", "bash: docker: command not found", "'node' is not recognized"), as a ToolNeed. */
export function missingFrom(output: string, os: NodeJS.Platform = process.platform): ToolNeed | undefined {
  const m = /command not found: ([A-Za-z][\w.-]*)|([A-Za-z][\w.-]*): command not found|'([A-Za-z][\w.-]*)' is not recognized/.exec(output);
  const tool = RUNTIMES[m?.[1] ?? m?.[2] ?? m?.[3] ?? ""];
  if (!tool) return undefined;
  const command = installCommand(tool, { brew: brewHere, os, npm: false });
  return { tool, name: NAMES[tool], url: URLS[tool], ...(command ? { command } : {}), blocking: true, message: `${NAMES[tool]} isn't on this computer, and this step needs it.` };
}
