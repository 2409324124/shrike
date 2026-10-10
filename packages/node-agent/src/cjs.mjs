// CommonJS (require, ts-node, nest's dist, Next's server chunks): transform the user's files as Node compiles them.
import Module from "node:module";
import path from "node:path";
import { transformSync } from "./babel-plugin.mjs";

const EXTENSIONS = new Set([".js", ".cjs", ".ts", ".cts"]);
// ESM files get ids from the loader thread counting up from 0; these count down from the top so they never collide.
let fileIndex = 80_000;

export function hookCommonJs(root) {
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename, format, ...rest) {
    if (typeof content === "string" && format !== "module" && format !== true && EXTENSIONS.has(path.extname(filename))) {
      const rel = path.relative(root, filename);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(path.sep).includes("node_modules")) {
        try {
          content = transformSync(content, filename, rel.split(path.sep).join("/"), fileIndex--, root);
        } catch {}
      }
    }
    return compile.call(this, content, filename, format, ...rest);
  };
}
