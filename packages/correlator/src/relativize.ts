import { posix } from "node:path";
import { fileURLToPath } from "node:url";

export function relativize(file: string, projectRoot: string): string {
  let f = file.trim().replace(/^turbopack:\/\/\/\[project\]\//, "").replace(/^webpack:\/\/[^/]*\/(\.\/)?/, "");
  if (/^file:\/\//i.test(f)) {
    try {
      f = fileURLToPath(f.replace(/[?#].*$/, ""));
    } catch {
      f = f.slice(7);
    }
  } else if (/^https?:\/\//i.test(f)) {
    try {
      f = new URL(f).pathname;
    } catch {
      /* keep as is */
    }
  }
  f = f.replace(/[?#].*$/, "").replace(/\\/g, "/");
  try {
    f = decodeURIComponent(f);
  } catch {
    /* keep encoded */
  }
  if (f.startsWith("/@fs/")) f = f.slice(4);

  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root) {
    const roots = [root];
    if (root.startsWith("/private/")) roots.push(root.slice(8));
    else if (/^\/(tmp|var|etc)(\/|$)/.test(root)) roots.push("/private" + root);
    for (const r of roots) {
      if (f === r) return "";
      if (f.startsWith(r + "/")) {
        f = f.slice(r.length + 1);
        break;
      }
    }
  }
  if (f.includes("/.")) f = posix.normalize(f);
  return f.replace(/^(\.\/|\/)+/, "");
}
