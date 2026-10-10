// module.register hooks (hooks thread): Babel-transform the user's project ESM files. CommonJS goes through cjs.mjs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./babel-plugin.mjs";

const EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
let root;
let fileIndex = 0;

export function initialize(data) {
  root = data?.root;
}

function target(url) {
  if (!root || !url.startsWith("file:")) return undefined;
  const file = fileURLToPath(url);
  if (!EXTENSIONS.has(path.extname(file))) return undefined;
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules")) return undefined;
  return { file, rel: parts.join("/") };
}

const text = (source) => (typeof source === "string" ? source : Buffer.from(source).toString("utf8"));

export async function load(url, context, nextLoad) {
  let t;
  try {
    t = target(url);
  } catch {}
  if (!t) return nextLoad(url, context);

  let loaded;
  let loadError;
  try {
    loaded = await nextLoad(url, context);
  } catch (e) {
    loadError = e;
  }
  let source;
  if (loaded) {
    // No source: Node's CommonJS loader compiles it, through cjs.mjs (the entry file too).
    if (loaded.format === "commonjs") return { ...loaded, source: null };
    if (loaded.format !== "module" && loaded.format !== "module-typescript") return loaded;
    if (loaded.source == null) return loaded;
    source = text(loaded.source);
  } else {
    // Node without type stripping cannot load .ts itself; we can.
    if (!t.file.endsWith(".ts") && !t.file.endsWith(".mts")) throw loadError;
    try {
      source = await readFile(t.file, "utf8");
    } catch {
      throw loadError;
    }
  }
  try {
    return { format: "module", source: await transform(source, t.file, t.rel, fileIndex++, { root }), shortCircuit: true };
  } catch {
    if (loaded) return loaded;
    throw loadError;
  }
}
