import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = path.dirname(fileURLToPath(import.meta.url));
let roots = [];

export function setRoot(root) {
  roots = [root];
  try {
    const real = realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {}
}

export const projectRoot = () => roots[0];

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/;

// Generated clients (Prisma's generated/prisma) and minified bundles are not the user's own source.
// ponytail: a "generated"/"do not edit" header in the first lines, or any line over 2000 characters.
export const generatedCode = (code) => /@generated|code generated|do not edit/i.test(code.slice(0, 1000)) || /[^\n]{2000}/.test(code);
const generatedFiles = new Map();
// True for a generated file; null when it can't be read (a source map naming a library's own sources).
export function generatedFile(file) {
  if (!generatedFiles.has(file)) {
    let g = null;
    try {
      g = generatedCode(readFileSync(file, "utf8"));
    } catch {}
    generatedFiles.set(file, g);
  }
  return generatedFiles.get(file);
}

// Repo-relative path for a user project file, else undefined.
export function relFile(file) {
  // Turbopack's source maps name sources turbopack:///[project]/src/...
  if (file.startsWith("turbopack:///[project]/") && roots[0]) file = path.join(roots[0], file.slice(23));
  if (file.startsWith("file:")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(file) || file.startsWith(agentDir + path.sep)) return undefined;
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    if (parts.includes("node_modules") || generatedFile(file) !== false) return undefined;
    return parts.join("/");
  }
  return undefined;
}

// Stack string of the current call, with frames above `fn` omitted. Read lazily, with Node's own formatting:
// frameworks (Next) replace Error.prepareStackTrace, which skips Node's source maps.
export function captureStack(fn) {
  const limit = Error.stackTraceLimit;
  const raw = {};
  try {
    Error.stackTraceLimit = 40;
    Error.captureStackTrace(raw, fn);
  } finally {
    Error.stackTraceLimit = limit;
  }
  return {
    get stack() {
      const prepare = Error.prepareStackTrace;
      try {
        Error.prepareStackTrace = undefined;
        return raw.stack;
      } finally {
        Error.prepareStackTrace = prepare;
      }
    },
  };
}

// First user-project frame after skipping `skip` frames.
export function userFrame(stack, skip = 0) {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n");
  let seen = 0;
  for (const line of lines) {
    const m = FRAME.exec(line);
    if (!m) continue;
    if (seen++ < skip) continue;
    const file = relFile(m[1]);
    if (file) return { file, line: Number(m[2]), column: Number(m[3]), precision: "exact" };
  }
  return undefined;
}
