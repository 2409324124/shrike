import { isAbsolute, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { StartCategory } from "@shrike/schema";

// R6: the start agent's guarded shell. Every command is judged here, in main, before it runs.
//   allow  read-only looks, dependency installs, builds, local services and containers, health checks
//   ask    env files, migrations/seeds, stopping other programs, paths outside the project, other file writes, unknown commands
//   never  deleting data, sudo, git push, non-local hosts

export type Verdict = "allow" | "ask" | "never";
export interface Judgement {
  verdict: Verdict;
  category: StartCategory;
  why: string; // plain words
  asks?: StartCategory[]; // every category a multi-part command asks for; "always" must cover all of them
}

export const CATEGORY_WORDS: Record<StartCategory, string> = {
  inspect: "Look around",
  install: "Install packages",
  build: "Build",
  service: "Start a local service",
  health: "Check it answers",
  env: "Write or read settings (env file)",
  migrate: "Change the database (migrations or seed data)",
  "free-port": "Stop another program to free a port",
  outside: "Touch files outside the project",
  write: "Change files in the project",
  clean: "Delete build output",
  other: "Run a command Shrike doesn't recognise",
};

const ALLOWED: StartCategory[] = ["inspect", "install", "build", "service", "health"];
/** Asks that "Always allow" never covers: Shrike can't tell what they do, or they leave the project. */
export const ASK_EVERY_TIME: StartCategory[] = ["other", "outside"];
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, never: 2 };
const WEIGHT: Partial<Record<StartCategory, number>> = { outside: 7, other: 6, service: 5, build: 4, install: 3, health: 2, inspect: 1 };

const allow = (category: StartCategory, why = CATEGORY_WORDS[category]): Judgement => ({ verdict: ALLOWED.includes(category) ? "allow" : "ask", category, why });
const ask = (category: StartCategory, why = CATEGORY_WORDS[category]): Judgement => ({ verdict: "ask", category, why });
const never = (why: string, category: StartCategory = "other"): Judgement => ({ verdict: "never", category, why });

const BUILD_DIRS = /^(node_modules|dist|build|out|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|\.cache|\.vite|\.parcel-cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|coverage|target|\.angular|storybook-static)$|\.tsbuildinfo$/;
const SAFE_DIRS = ["/dev/null", "/dev/stdout", "/dev/stderr", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\]|host\.docker\.internal|[\w-]+\.localhost)$/i;

/** Shell words of one segment, quotes removed. ponytail: no globbing, escapes only inside double quotes. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') (q = c), (has = true);
    else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Split on && || ; | & and newlines outside quotes; $(…) and `…` come out as their own segments. */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === "$" && cmd[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < cmd.length && depth; j++) depth += cmd[j] === "(" ? 1 : cmd[j] === ")" ? -1 : 0;
      out.push(...segments(cmd.slice(i + 2, j - 1)));
      cur += "SUBST";
      i = j - 1;
    } else if (c === "`") {
      const j = cmd.indexOf("`", i + 1);
      out.push(...segments(cmd.slice(i + 1, j < 0 ? undefined : j)));
      cur += "SUBST";
      i = j < 0 ? cmd.length : j;
    } else if (c === "\n" || c === ";" || c === "|" || (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Ctx {
  root: string;
  cwd: string; // absolute
}

// ponytail: only HOME and TMPDIR are known; any other $VAR counts as outside the project.
const expand = (p: string) =>
  p === "~" || p.startsWith("~/")
    ? homedir() + p.slice(1)
    : p.replace(/^\$\{?([A-Za-z_]\w*)\}?/, (_m, v: string) => (v === "HOME" ? homedir() : v === "TMPDIR" ? tmpdir().replace(/\/$/, "") : `/$unknown-${v}`));
const inside = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return !rel.startsWith("..") && !isAbsolute(rel);
};
const pathLike = (w: string) => /^(\/|~|\.\.(\/|$)|\$\{?(HOME|TMPDIR)\}?$|\$\{?\w+\}?\/)/.test(w) && !/^\/\//.test(w);
const safe = (abs: string) => SAFE_DIRS.some((d) => abs === d || abs.startsWith(`${d}/`));
/** Any path in a word (--flag=x, KEY=x, docker's type=bind,source=x and host:container) outside the project. */
function outsidePath(ctx: Ctx, w: string): boolean {
  return w.replace(/^--?[\w-]+=/, "").split(",").some((part) => {
    const v = part.replace(/^[\w.-]+=/, "").replace(/(.):\/.*$/, "$1");
    if (!pathLike(v)) return false;
    const abs = resolve(ctx.cwd, expand(v));
    return !inside(ctx.root, abs) && !safe(abs);
  });
}
const CLAUDE_DIR = /(^|\/)\.claude(\/|$)/;
// Inside the project only the part under it counts: a project in a Claude Code worktree (.claude/worktrees/x) may run its own files.
const inClaude = (root: string, abs: string) => CLAUDE_DIR.test(inside(root, abs) ? relative(root, abs) : abs);

function hostsOf(seg: string): string[] {
  return [...seg.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[^\]]+\]|[^\s/:'"?#]+)/gi)].map((m) => m[1]!);
}

const SHELL_WORDS = new Set(["do", "done", "then", "else", "elif", "fi", "if", "while", "until", "!", "{", "}"]);
const WRAPPERS: Record<string, number> = { time: 1, nohup: 1, exec: 1, command: 1, caffeinate: 1 };

/** Strip env assignments and wrappers like `uv run`, `npx`, `nix develop -c`; returns the words of the real command. */
function unwrap(ws: string[]): string[] {
  let w = ws;
  for (let guard = 0; guard < 8; guard++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w = w.slice(1);
    const [a, b] = w;
    if (!a) return w;
    if (SHELL_WORDS.has(a)) w = w.slice(1); // `for … ; do X; done`: judge X
    else if (a in WRAPPERS) w = w.slice(WRAPPERS[a]!);
    else if (a === "env") {
      let i = 1; // env [-i] [-u NAME] [-C dir] [NAME=value]... <cmd>
      while (w[i]?.startsWith("-")) i += /^(-u|--unset|-C|--chdir|-S|--split-string)$/.test(w[i]!) ? 2 : 1;
      w = w.slice(i);
    }
    else if ((a === "uv" || a === "poetry" || a === "pipenv" || a === "pdm" || a === "hatch" || a === "rye") && b === "run") w = w.slice(2).filter((x, i) => i > 0 || !x.startsWith("-"));
    else if (a === "npx" || a === "bunx" || a === "pnpx") w = w.slice(1).filter((x, i, all) => !(x.startsWith("-") && all.slice(0, i).every((y) => y.startsWith("-"))));
    else if ((a === "pnpm" || a === "yarn") && (b === "exec" || b === "dlx")) w = w.slice(2);
    else if (a === "bun" && b === "x") w = w.slice(2);
    else if (a === "nix" && b === "develop") {
      const i = w.findIndex((x) => x === "-c" || x === "--command");
      if (i < 0) return w;
      w = w.slice(i + 1);
    } else if (a === "direnv" && b === "exec") w = w.slice(3);
    else if (a === "dotenv" || a === "dotenvx") {
      const i = w.indexOf("--"); // dotenv -e .env.local -- <cmd>: the env file is read, <cmd> is what runs
      if (i < 0) return w;
      w = w.slice(i + 1);
    }
    else if (a === "xargs") w = w.slice(1).filter((x, i, all) => !(x.startsWith("-") && all.slice(0, i).every((y) => y.startsWith("-"))));
    else return w;
  }
  return w;
}

const gitFlagsWithValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const pkgFlagsWithValue = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--cwd", "--workspace", "-w"]);
function positional(ws: string[], withValue = pkgFlagsWithValue): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (withValue.has(w)) i++;
    else if (!w.startsWith("-")) out.push(w);
  }
  return out;
}

/** A script or recipe judged by its name. ponytail: names only; reading the script body is the upgrade. */
export function byName(name: string): Judgement {
  const n = name.toLowerCase();
  if (/\b(reset|nuke|wipe|purge|destroy|drop)\b|(^|[:_-])(reset|nuke|wipe|purge|destroy|drop)/.test(n)) return never(`"${name}" sounds like it deletes data, so Shrike won't run it. Run it yourself if you mean it.`, "clean");
  if (/clean/.test(n)) return ask("clean");
  if (/migrat|seed|db:push|db:setup|schema:push|fixtures/.test(n)) return ask("migrate");
  if (/build|compile|codegen|generate|gen\b|prepare|bundle|typecheck|tsc|lint|format|test|check|validate/.test(n)) return allow("build");
  if (/health|smoke|ping|status|doctor|verify/.test(n)) return allow("health");
  if (/^(install|setup|bootstrap|deps|init)$|install/.test(n)) return allow("install");
  if (/dev|start|serve|server|watch|preview|services|up\b|run|web|api|backend|frontend|infra|docker|compose/.test(n)) return allow("service");
  return ask("other", `Run "${name}", which Shrike doesn't recognise`);
}

const READ_ONLY = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "rg", "ag", "which", "type", "whereis", "echo", "printf", "pwd", "wc", "sort", "uniq", "jq", "yq", "stat", "file", "test", "[", "true", "false", "uname", "sw_vers", "whoami", "id", "date", "printenv", "lsof", "ps", "pgrep", "df", "du", "tree", "realpath", "dirname", "basename", "diff", "cmp", "less", "more", "column", "cut", "tr", "sleep", "export", "source", ".", "set", "unset", "hash", "ulimit", "nproc", "sysctl", "arch", "readlink", "md5", "shasum", "sha256sum", "cd"]);
const SERVICES = new Set(["vite", "next", "nuxt", "remix", "astro", "nodemon", "ts-node-dev", "tsx", "ts-node", "nest", "react-scripts", "ng", "expo", "webpack-dev-server", "webpack", "parcel", "uvicorn", "gunicorn", "hypercorn", "daphne", "flask", "fastapi", "celery", "rails", "puma", "foreman", "overmind", "honcho", "hivemind", "process-compose", "turbo", "nx", "firebase", "supabase", "wrangler", "hugo", "jekyll", "air", "deno", "storybook", "concurrently", "run-p", "npm-run-all"]);
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/|^\/opt\/homebrew\/s?bin\/|^\/opt\/local\/s?bin\/|^\/usr\/libexec\//;
const INTERPRETERS = new Set(["node", "python", "python3", "ruby", "php", "bun", "deno", "tsx", "ts-node", "perl"]);
const DELETES = /rmtree|\brm\s+-\w*[rf]|\bunlink|os\.remove|\brmSync|fs\.rm\b|\brimraf|\bFileUtils\.rm|\bdrop\s+(table|database)|\btruncate\b/i;
const BUILDERS = new Set(["tsc", "esbuild", "rollup", "swc", "babel", "cmake", "ninja", "gradle", "./gradlew", "gradlew", "mvn", "./mvnw", "mvnw", "msbuild", "dotnet", "mkdir"]);

function judgeWords(ws: string[], ctx: Ctx, depth: number): Judgement {
  let w = unwrap(ws);
  if (/[$`]|SUBST/.test(w[0] ?? "")) return never("Shrike can't tell which program that runs (its name comes from a variable). Write the command out in full.");
  // /bin/rm is rm; a program elsewhere outside the project asks.
  if (w[0] && isAbsolute(expand(w[0])) && !inside(ctx.root, resolve(ctx.cwd, expand(w[0])))) {
    if (!SYSTEM_BIN.test(w[0])) return worst([ask("outside", `Run ${w[0]}, a program outside the project`), judgeWords([w[0].split("/").pop()!, ...w.slice(1)], ctx, depth + 1)]);
    w = [w[0].split("/").pop()!, ...w.slice(1)];
  }
  const [a = "", b = "", c = ""] = w;
  const rest = w.slice(1);
  const has = (...f: string[]) => rest.some((x) => f.includes(x) || f.some((g) => g.startsWith("--") && x.startsWith(`${g}=`)));
  const flagChars = rest.filter((x) => /^-[a-zA-Z]+$/.test(x)).join("");
  const envFile = (x: string) => /(^|\/)\.env($|\.)/.test(x) && !/\.(example|sample|template|defaults?)$/.test(x);

  if (!a || a === "for") return allow("inspect"); // a loop header only names values; the body is judged on its own
  if (a === "sudo" || a === "doas" || a === "su") return never("Shrike never runs commands as the administrator (sudo).");
  if (a === "eval") return depth < 4 ? judge(rest.join(" "), ctx, depth + 1) : ask("other");
  if (["sh", "bash", "zsh", "dash", "ksh", "fish"].includes(a)) {
    const i = w.findIndex((x, k) => k > 0 && (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x) || x === "--command"));
    const inner = i >= 0 ? w.slice(i + 1).find((x) => !x.startsWith("-")) : undefined;
    if (inner) return depth < 4 ? judge(inner, ctx, depth + 1) : ask("other");
    if (rest.length) return ask("other", `Run the script ${rest.find((x) => !x.startsWith("-")) ?? ""}`.trim());
    return ask("other");
  }
  if (a === "nix-shell") {
    const i = w.indexOf("--run");
    if (i >= 0 && w[i + 1] && depth < 4) return judge(w[i + 1]!, ctx, depth + 1);
    return allow("service");
  }
  if (["ssh", "scp", "sftp", "ftp", "telnet", "rsync", "mosh"].includes(a)) return never("Shrike only works with this computer, not other machines.");
  if (["mkfs", "dd", "diskutil", "fdisk", "chown", "launchctl", "systemctl", "shutdown", "reboot", "halt", "crontab", "defaults", "csrutil", "spctl", "nvram", "passwd"].includes(a)) return never(`Shrike never runs ${a}: it changes your computer, not your project.`);
  if (a === "rm" || a === "rmdir" || a === "unlink" || a === "trash") {
    const targets = rest.filter((x) => !x.startsWith("-"));
    const recursive = /[rRf]/.test(flagChars) || has("--recursive", "--force");
    const allBuild = targets.length > 0 && targets.every((t) => BUILD_DIRS.test(t.replace(/\/+$/, "").split("/").pop() ?? "") && !outsidePath(ctx, t) && !/[*?]/.test(t.replace(/\.tsbuildinfo$/, "")));
    if (allBuild) return ask("clean", `Delete build output (${targets.join(", ")}) so it's rebuilt`);
    if (recursive || a === "rmdir") return never("Shrike never deletes folders of your data. Do it yourself if you mean it.", "clean");
    return ask("write", `Delete ${targets.join(", ") || "a file"}`);
  }
  if (a === "git") {
    const sub = positional(rest, gitFlagsWithValue)[0] ?? "";
    if (sub === "push") return never("Shrike never pushes your code from here.");
    if (rest.some((x, i) => (rest[i - 1] === "-c" || rest[i - 1] === "--config-env") && /^alias\./i.test(x))) return never("Shrike doesn't run git with a made-up alias. Write the git command out.");
    if ((sub === "clean" && /f/.test(flagChars)) || (sub === "reset" && has("--hard")) || (sub === "checkout" && rest.includes("--")) || (sub === "restore" && !has("--staged"))) return never("That would throw away changes in your files.");
    if (["status", "log", "diff", "show", "rev-parse", "ls-files", "describe", "remote", "config", "blame", "shortlog", "fetch", "branch", "tag", "worktree"].includes(sub) && !(sub === "branch" && /[dDmM]/.test(flagChars)) && !(sub === "config" && !has("--get", "--list", "-l"))) return allow("inspect");
    if (sub === "submodule" || sub === "lfs") return allow("install");
    return ask("write", `Change your git checkout (git ${sub})`);
  }
  if (["kill", "pkill", "killall", "fuser"].includes(a)) return ask("free-port");
  if (["curl", "wget", "http", "https", "xh", "nc", "ncat", "pg_isready", "redis-cli", "mysqladmin", "mongosh", "grpcurl"].includes(a)) {
    if (a === "nc" && !/z/.test(flagChars)) return ask("other");
    if ((a === "curl" && (has("-X", "--request", "-d", "--data", "--data-raw", "-F", "--form", "-T", "--upload-file") || /[dFT]/.test(flagChars.replace(/^-/, "")))) || (a === "wget" && has("--post-data", "--method"))) return ask("other", "Send data to a local service");
    const outs = rest.flatMap((x, i) => (x === "--output" || /^-[a-zA-Z]*o$/.test(x) ? [rest[i + 1] ?? ""] : x.startsWith("--output=") ? [x.slice(9)] : []));
    const discards = outs.length > 0 && outs.every((o) => o === "/dev/null" || o === "-") && !has("-O", "--remote-name") && !/O/.test(flagChars);
    if (a === "curl" && !discards && (has("-o", "--output", "-O", "--remote-name") || /[oO]/.test(flagChars))) return ask("write", "Download into a file");
    if (a === "redis-cli" && !/^(ping|info|dbsize)$/i.test(positional(rest).at(-1) ?? "ping")) return ask("migrate", "Change data in Redis");
    if (a === "mongosh" && !has("--eval")) return ask("migrate");
    return allow("health");
  }
  if (["psql", "mysql", "sqlite3"].includes(a)) return /\b(select|\\dt|\\l|show)\b/i.test(rest.join(" ")) && !/\b(insert|update|delete|drop|alter|create|truncate)\b/i.test(rest.join(" ")) ? allow("inspect") : ask("migrate");
  if (a === "find") return rest.some((x) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(x)) ? ask("write", "Find and change files") : allow("inspect");
  if (a === "sed") return has("-i", "--in-place") || /i/.test(flagChars) ? ask("write") : allow("inspect");
  if (a === "awk" || a === "gawk") return /system\(|print\s*>/.test(rest.join(" ")) ? ask("write") : allow("inspect");
  if (["cp", "mv", "ln", "touch", "tee", "install", "chmod", "truncate", "patch"].includes(a)) {
    const files = positional(rest);
    if (files.some(envFile) && a !== "chmod") return ask("env", `Write ${files.find(envFile)}`);
    if (a === "chmod" && files.slice(1).every((f) => !outsidePath(ctx, f)) && /\+x/.test(files[0] ?? "")) return ask("write", `Make ${files.slice(1).join(", ")} runnable`);
    return ask("write", `${a === "cp" ? "Copy" : a === "mv" ? "Move" : "Change"} ${files.join(" ")}`.trim());
  }
  if (a === "open" || a === "xdg-open") return ask("other", "Open something in another app");
  if (READ_ONLY.has(a)) {
    if (["cat", "head", "tail", "grep", "rg", "less", "more", "source", "."].includes(a) && rest.some(envFile)) return ask("env", "Read your env file (it may hold secrets)");
    return allow("inspect");
  }
  if (rest.length === 1 && /^(-v|-V|--version|version|-version|--help|-h|help)$/.test(b)) return allow("inspect");

  // package managers
  if (a === "npm" || a === "pnpm" || a === "yarn" || a === "bun" || a === "corepack") {
    const [sub = a === "yarn" ? "install" : "", ...args] = positional(rest);
    if (a === "corepack") return ask("outside", "Set up a package manager for your whole computer (corepack)");
    if (has("-g", "--global") || (a === "yarn" && sub === "global")) return ask("outside", "Install a tool for your whole computer");
    if (["install", "i", "ci", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link"].includes(sub)) {
      if (["install", "i", "ci"].includes(sub) && !args.length) return allow("install");
      if (sub === "add" || args.length) return ask("write", `Change your project's packages (${a} ${sub} ${args.join(" ")})`.trim());
      if (sub === "link") return ask("outside");
      return ask("write", `Update your project's packages (${a} ${sub})`);
    }
    if (["ls", "list", "why", "outdated", "view", "info", "config", "root", "bin", "audit", "doctor", "explain", "-v", "--version", "env", "store"].includes(sub)) return sub === "store" && args[0] === "prune" ? ask("clean") : allow("inspect");
    if (sub === "rebuild") return allow("build");
    if (sub === "run" || sub === "run-script") return args[0] ? byName(args[0]) : allow("inspect");
    if (sub === "exec" || sub === "dlx" || sub === "x") return args.length && depth < 4 ? judgeWords(args, ctx, depth + 1) : ask("other");
    if (sub === "create" || sub === "init") return ask("write");
    if (sub === "publish" || sub === "deploy" || sub === "login" || sub === "adduser") return never(`Shrike never runs ${a} ${sub}: it reaches outside this computer.`);
    if (sub === "test" || sub === "build") return allow("build");
    if (sub === "start" || sub === "dev") return allow("service");
    if (a === "bun" && /\.(m?[jt]sx?)$/.test(sub)) return byPath(sub);
    return sub ? byName(sub) : allow("install");
  }
  if (a === "pip" || a === "pip3" || ((a === "python" || a === "python3") && b === "-m" && (c === "pip" || c === "venv" || c === "ensurepip"))) {
    const sub = a.startsWith("pip") ? b : c === "pip" ? (w[3] ?? "") : "install";
    if (sub === "install" || c === "venv" || c === "ensurepip" || sub === "download" || sub === "wheel") return has("--user") ? ask("outside") : allow("install");
    if (["list", "show", "freeze", "check", "--version", "-V"].includes(sub)) return allow("inspect");
    if (sub === "uninstall") return ask("write");
    return ask("other");
  }
  if (a === "uv") {
    if (["sync", "venv", "lock", "pip", "python", "tool"].includes(b)) return b === "tool" && c === "install" ? ask("outside") : b === "pip" && !["install", "sync", "list", "show", "freeze"].includes(c) ? ask("write") : allow("install");
    if (b === "add" || b === "remove") return ask("write", `Change your project's packages (uv ${b})`);
    return byName(b || "uv");
  }
  if (a === "poetry" || a === "pipenv" || a === "pdm" || a === "rye" || a === "hatch") {
    if (["install", "sync", "lock", "env", "shell", "update"].includes(b)) return b === "update" ? ask("write") : allow("install");
    if (b === "add" || b === "remove") return ask("write");
    if (["show", "check", "--version", "config"].includes(b)) return allow("inspect");
    return byName(b || a);
  }
  if (["bundle", "go", "cargo", "mix", "composer", "gem", "swift", "flutter", "dart"].includes(a)) {
    if (a === "go" && ["build", "vet", "generate", "test"].includes(b)) return allow("build");
    if (a === "go" && b === "run") return allow("service");
    if (a === "go" && b === "install") return ask("outside");
    if (a === "cargo" && ["build", "check", "test", "clippy"].includes(b)) return allow("build");
    if (a === "cargo" && b === "run") return allow("service");
    if (a === "cargo" && b === "install") return ask("outside");
    if (a === "gem" && b === "install") return ask("outside");
    if (["install", "get", "fetch", "download", "deps.get", "restore", "pub", "mod"].includes(b) || (a === "go" && b === "mod")) return allow("install");
    if (a === "bundle" && b === "exec" && depth < 4) return judgeWords(w.slice(2), ctx, depth + 1);
    if (/^(phx\.server|run|serve|server|start)$/.test(b)) return allow("service");
    if (/migrat|seed|ecto\.(setup|reset|migrate)/.test(b)) return /reset|drop/.test(b) ? never("That deletes database data.", "migrate") : ask("migrate");
    return byName(b || a);
  }
  if (INTERPRETERS.has(a)) {
    if (b === "-m" && c) return SERVICES.has(c) ? allow("service") : byName(c);
    if (b === "-e" || b === "-c" || b === "--eval" || b === "-p" || b === "-E") return DELETES.test(rest.join(" ")) ? never("That snippet deletes files or data, so Shrike won't run it.", "clean") : ask("other", "Run a snippet of code");
    if ((a === "python" || a === "python3") && /manage\.py$/.test(b)) return c === "runserver" ? allow("service") : /migrat|loaddata|flush|createsuperuser/.test(c) ? (c === "flush" ? never("That deletes database data.", "migrate") : ask("migrate")) : ["check", "showmigrations", "collectstatic", "compilemessages"].includes(c) ? allow("build") : byName(c || "manage");
    if (a === "php" && b === "artisan") return c === "serve" ? allow("service") : /migrate:(fresh|reset|rollback)|db:wipe/.test(c) ? never("That deletes database data.", "migrate") : /migrat|seed/.test(c) ? ask("migrate") : byName(c);
    if (a === "deno" && b === "task") return byName(c);
    if (a === "deno" && b === "run") return allow("service");
    return b ? byPath(b) : ask("other");
  }
  if (a === "alembic" || a === "flyway" || a === "liquibase" || a === "knex" || a === "sequelize" || a === "typeorm" || a === "prisma" || a === "drizzle-kit" || a === "dbmate" || a === "goose" || a === "atlas") {
    if (/reset|drop|downgrade|down|rollback|wipe|fresh/.test(rest.join(" "))) return never("That deletes or rolls back database data.", "migrate");
    if (a === "prisma" && b === "generate") return allow("build");
    if (a === "prisma" && b === "studio") return allow("service");
    if ((a === "prisma" || a === "drizzle-kit") && /^(validate|format|version|-v|check)$/.test(b)) return allow("inspect");
    if (a === "prisma" && b === "migrate" && (c === "diff" || c === "status")) return allow("inspect"); // read-only compares
    return ask("migrate");
  }
  if (a === "docker" || a === "docker-compose" || a === "podman") {
    const isCompose = a === "docker-compose" || b === "compose";
    const sub = positional(isCompose && a !== "docker-compose" ? w.slice(2) : w.slice(1)).filter((x) => !/\.(ya?ml)$/.test(x))[0] ?? "";
    const files = w.flatMap((x, i) => (x === "-f" || x === "--file" ? [w[i + 1] ?? ""] : []));
    if (files.some((f) => outsidePath(ctx, f))) return ask("outside", "Use a compose file outside the project");
    if (isCompose) {
      if (["up", "start", "create", "run", "restart"].includes(sub)) return sub === "run" ? ask("other") : allow("service");
      if (["ps", "logs", "config", "images", "ls", "top", "port", "version", "events"].includes(sub)) return allow("inspect");
      if (["build", "pull"].includes(sub)) return allow("build");
      if (sub === "down" || sub === "rm") return has("-v", "--volumes") || /v/.test(flagChars) ? never("That deletes the containers' data (volumes).", "clean") : ask("free-port", "Stop the project's containers");
      if (sub === "stop" || sub === "kill" || sub === "pause") return ask("free-port", "Stop the project's containers");
      if (sub === "exec") return ask("other", "Run a command inside a container");
      return ask("other");
    }
    if (["ps", "images", "info", "version", "logs", "inspect", "port", "stats", "context", "top"].includes(sub)) return allow("inspect");
    if (sub === "run" || sub === "start") return allow("service");
    if (sub === "build" || sub === "pull") return allow("build");
    if (sub === "stop" || sub === "kill" || sub === "restart") return ask("free-port", "Stop a container");
    if (["rm", "rmi", "prune", "volume", "system", "network", "image", "container"].includes(sub)) {
      if (["volume", "system", "image", "container", "network"].includes(sub) && ["ls", "inspect", "list"].includes(positional(w.slice(2))[0] ?? "")) return allow("inspect");
      return never("That deletes containers, images or their data.", "clean");
    }
    if (sub === "exec") return ask("other", "Run a command inside a container");
    if (sub === "login" || sub === "push") return never("Shrike never sends anything to a registry from here.");
    return ask("other");
  }
  if (a === "nix") {
    if (b === "run" || b === "shell") return allow("service");
    if (b === "build" || b === "flake" && ["check", "show", "metadata", "info"].includes(c)) return b === "build" ? allow("build") : allow("inspect");
    if (b === "develop") return allow("service");
    if (["--version", "eval", "path-info", "search", "log", "why-depends"].includes(b)) return allow("inspect");
    if (b === "profile" || b === "upgrade-nix" || b === "store") return ask("outside");
    return ask("other");
  }
  if (a === "nix-collect-garbage") return ask("outside");
  if (a === "just" || a === "make" || a === "task" || a === "mage" || a === "invoke" || a === "rake") {
    const recipe = positional(rest).find((x) => !/=/.test(x));
    if (has("--list", "-l", "--summary", "--show", "--dump", "--evaluate", "--variables", "-n", "--dry-run", "--help", "--version") || (a === "make" && /n/.test(flagChars))) return allow("inspect");
    if (!recipe) return a === "make" ? allow("build") : allow("service");
    if (a === "make" && /^(all|install)$/.test(recipe)) return recipe === "install" ? allow("install") : allow("build");
    return byName(recipe);
  }
  if (a === "process-compose") return ["down", "stop"].includes(b) ? ask("free-port") : ["list", "info", "version", "process"].includes(b) ? allow("inspect") : allow("service");
  if (a === "brew") return ["list", "info", "--prefix", "search", "doctor", "config", "--version", "deps", "outdated"].includes(b) ? allow("inspect") : b === "services" && ["list", "info"].includes(c) ? allow("inspect") : ask("outside", `Change your computer with Homebrew (brew ${b})`);
  if (["nvm", "fnm", "asdf", "mise", "rtx", "pyenv", "rbenv", "volta", "sdk", "rustup", "devbox"].includes(a)) {
    if (["list", "ls", "current", "which", "version", "--version", "doctor", "env", "where", "exec", "run", "use", "local", "shell"].includes(b)) return a === "devbox" && ["run", "shell", "services"].includes(b) ? allow("service") : allow("inspect");
    return ask("outside", `Install a tool version for your whole computer (${a} ${b})`);
  }
  if (a === "direnv") return b === "allow" ? ask("outside", "Trust this folder's .envrc (direnv allow)") : allow("inspect");
  if (a === "npx" || a === "playwright") return /install/.test(rest.join(" ")) ? allow("install") : ask("other");
  if (SERVICES.has(a)) {
    if (a === "turbo" || a === "nx") return byName(positional(rest).find((x) => x !== "run") ?? "run");
    if (a === "firebase" || a === "supabase" || a === "wrangler") return /deploy|login|publish|db reset|link/.test(rest.join(" ")) ? never(`Shrike never runs ${a} commands that reach your live project.`) : /start|serve|dev|emulators/.test(rest.join(" ")) ? allow("service") : allow("inspect");
    if (a === "rails") return ["s", "server"].includes(b) ? allow("service") : /db:(drop|reset|purge)/.test(b) ? never("That deletes database data.", "migrate") : /db:/.test(b) ? ask("migrate") : byName(b);
    if (a === "celery" || a === "flask" || a === "fastapi") return allow("service");
    if (["vite", "next", "nuxt", "astro", "remix", "ng", "webpack", "parcel", "storybook"].includes(a) && /^(build|export|generate)$/.test(b)) return allow("build");
    return allow("service");
  }
  if (BUILDERS.has(a)) return allow("build");
  if (/^\.?venv\/(bin|Scripts)\/[^/]+$/.test(a) && depth < 4) return judgeWords([a.split("/").pop()!, ...rest], ctx, depth + 1); // the project's virtualenv: .venv/bin/pip is pip
  if (/^\.{0,2}\//.test(a) || a.includes("/")) return byPath(a);
  return ask("other", `Run ${a}, which Shrike doesn't recognise`);
}

/** A script file judged by its path (node scripts/seed.ts, ./bin/dev). */
function byPath(p: string): Judgement {
  const name = p.split("/").pop() ?? p;
  const j = byName(name.replace(/\.[\w]+$/, ""));
  return j.category === "other" ? ask("other", `Run the script ${p}`) : j;
}

const worst = (js: Judgement[]): Judgement =>
  js.reduce((acc, j) => (RANK[j.verdict] > RANK[acc.verdict] || (RANK[j.verdict] === RANK[acc.verdict] && (WEIGHT[j.category] ?? 0) > (WEIGHT[acc.category] ?? 0)) ? j : acc));

/** R6: is this command allowed to run without asking? `cwd` is absolute and inside `root`. */
export function judge(command: string, ctx: Ctx, depth = 0): Judgement {
  const cmd = command.trim();
  if (!cmd) return never("That command is empty.");
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(cmd)) return never("Shrike never pipes a download straight into a shell.");
  if (/:\(\)\s*\{|\bfork\s*bomb/.test(cmd)) return never("That isn't a safe command.");
  const out: Judgement[] = [];
  let cwd = ctx.cwd;
  for (const seg of segments(cmd)) {
    // A > inside quotes (awk 'NR>1', a JSON body) is text, not a redirect: hide quoted text while looking for redirects.
    const quoted: string[] = [];
    const masked = seg.replace(/"[^"]*"|'[^']*'/g, (q) => `\u0000${quoted.push(q) - 1}\u0000`);
    const unmask = (t: string) => t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => quoted[Number(i)]!);
    const redirects = [...masked.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*(?!&)([^\s;|&]+)/g)].map((m) => unmask(m[1]!).replace(/^["']|["']$/g, ""));
    const plain = unmask(masked.replace(/(?:\d|&)?>>?\s*(&\d|[^\s;|&]+)/g, " ").replace(/<\s*[^\s;|&]+/g, " "));
    const ws = words(plain);
    const here: Ctx = { root: ctx.root, cwd };
    for (const r of redirects) {
      const abs = resolve(cwd, expand(r));
      if (!inside(ctx.root, abs) && safe(abs)) continue; // a project under /tmp still counts as the project
      if (inClaude(ctx.root, abs)) out.push(never("Shrike never writes into a .claude folder. Its own skills live in .shrike/skills.", "write"));
      else if (/(^|\/)\.env($|\.)/.test(r) && !/\.(example|sample|template)$/.test(r)) out.push(ask("env", `Write ${r}`));
      else if (!inside(ctx.root, abs)) out.push(ask("outside", `Write ${r}, outside the project`));
      else out.push(ask("write", `Write ${r}`));
    }
    const real = unwrap(ws);
    if (real[0] === "cd") {
      const to = resolve(cwd, expand(real[1] ?? "~"));
      if (!inside(ctx.root, to)) out.push(ask("outside", `Work in ${real[1] ?? "your home folder"}, outside the project`));
      cwd = to;
      continue;
    }
    let j = judgeWords(ws, here, depth);
    const far = hostsOf(seg).filter((h) => !LOCAL_HOST.test(h.replace(/^\[|\]$/g, "")));
    if (far.length && j.verdict !== "never") j = j.category === "install" ? ask("other", `Install from ${far[0]}, not your usual package registry`) : never(`Shrike only talks to this computer, not ${far[0]}.`, j.category);
    if (j.verdict !== "never" && !["inspect", "health"].includes(j.category) && ws.slice(1).some((x) => inClaude(ctx.root, resolve(cwd, expand(x))))) j = never("Shrike never writes into a .claude folder. Its own skills live in .shrike/skills.", "write");
    // sed/awk/grep's first argument is a script or a pattern (/SERVICE/,$p), not a file
    const script = /^(sed|awk|gawk|grep|egrep|rg|jq|yq)$/.test(real[0] ?? "") && !real.slice(1).some((x) => x === "-e" || x === "-f" || x === "--file") ? ws.indexOf(real.slice(1).find((x) => !x.startsWith("-")) ?? "\0") : -1;
    const away = j.verdict !== "never" && ws.slice(1).find((x, i) => i + 1 !== script && outsidePath(here, x));
    if (away) out.push(ask("outside", `Use ${away}, outside the project`));
    out.push(j);
  }
  if (!out.length) return allow("inspect");
  const asks = [...new Set(out.flatMap((j) => (j.verdict === "ask" ? (j.asks ?? [j.category]) : [])))];
  const w = worst(out);
  const whys = [...new Set(out.filter((j) => j.verdict === "ask").map((j) => j.why))];
  return { ...w, ...(w.verdict === "ask" && whys.length > 1 ? { why: whys.join("; ") } : {}), ...(asks.length ? { asks } : {}) };
}

/** Categories "Always allow" may remember for this judgement. */
export const rememberable = (j: Judgement): StartCategory[] => (j.asks ?? [j.category]).filter((c) => !ASK_EVERY_TIME.includes(c));

/** "Always allow for this project" never covers never, unknown commands or leaving the project, and must cover every part. */
export function decide(j: Judgement, always: ReadonlySet<StartCategory>): "run" | "ask" | "refuse" {
  if (j.verdict === "never") return "refuse";
  if (j.verdict === "allow") return "run";
  const cats = j.asks ?? [j.category];
  return cats.every((c) => always.has(c) && !ASK_EVERY_TIME.includes(c)) ? "run" : "ask";
}

/** A project file run as a long-lived service (node server.mjs, ./bin/dev, python app.py): one plain command, nothing hidden. */
export function projectScript(command: string, ctx: Ctx): boolean {
  if (segments(command).length !== 1 || /[$`<>]/.test(command)) return false;
  const w = unwrap(words(command));
  const file = INTERPRETERS.has(w[0] ?? "") ? (w[1] && !w[1].startsWith("-") ? w[1] : undefined) : w[0]?.includes("/") ? w[0] : undefined;
  return !!file && inside(ctx.root, resolve(ctx.cwd, expand(file))) && !CLAUDE_DIR.test(file);
}
