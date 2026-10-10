import { execFile } from "node:child_process";
import { existsSync, realpathSync, watch } from "node:fs";
import { readdir, readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { FileNode } from "@shrike/schema";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vite", "out", "coverage"]);
const MAX_ENTRIES = 5000;
const MAX_SEARCH_HITS = 200;
const MAX_SEARCH_FILE = 1024 * 1024;

export function isIgnored(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".shrike");
}

const toPosix = (p: string) => p.split(sep).join("/");

// Absolute path for a repo-relative path, guaranteed (after symlinks) to be inside root.
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || isAbsolute(rel)) throw new Error(`Not a project path: ${rel}`);
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, rel);
  if (!within(realRoot, abs)) throw new Error(`That path is outside the project: ${rel}`);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  if (!within(realRoot, realpathSync(probe))) throw new Error(`That path is outside the project: ${rel}`);
  return abs;
}

function within(root: string, abs: string): boolean {
  const r = relative(root, abs);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

export async function fileTree(root: string): Promise<FileNode[]> {
  let count = 0;
  const walk = async (dir: string): Promise<FileNode[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const out: FileNode[] = [];
    for (const ent of entries) {
      if (count >= MAX_ENTRIES) break;
      if (isIgnored(ent.name) || (!ent.isDirectory() && !ent.isFile())) continue;
      const abs = resolve(dir, ent.name);
      if (ent.name === "worktrees" && relative(root, dir) === ".shrike") continue; // W1: other worktrees' copies of the code
      count++;
      const node: FileNode = { name: ent.name, path: toPosix(relative(root, abs)), dir: ent.isDirectory() };
      if (node.dir) node.children = await walk(abs);
      out.push(node);
    }
    return out;
  };
  return walk(root);
}

// ---- Files view (FV): the project as the editor shows it, sliced to what one trip touched ----

const git = (root: string, args: string[]): Promise<string[]> =>
  new Promise((done, fail) =>
    execFile("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024, timeout: 15_000 }, (err, out) => (err ? fail(err) : done(out.split("\0").filter(Boolean)))),
  );

const hidden = (p: string) => p === ".git" || p.startsWith(".git/") || p.startsWith(".shrike/worktrees/") || p === ".shrike/worktrees";

/** Every file the editor would list (dotfiles too) and each ignored folder as one entry. Git's own rules when it can; else a walk. */
export async function listing(root: string): Promise<{ files: string[]; ignored: string[] }> {
  try {
    const [all, deleted, ign] = await Promise.all([
      git(root, ["ls-files", "-co", "--exclude-standard", "-z"]),
      git(root, ["ls-files", "-d", "-z"]),
      git(root, ["ls-files", "-oi", "--exclude-standard", "--directory", "-z"]),
    ]);
    const gone = new Set(deleted);
    return { files: all.filter((f) => !gone.has(f) && !hidden(f)), ignored: ign.filter((f) => f.endsWith("/")).map((f) => f.slice(0, -1)).filter((f) => !hidden(f)) };
  } catch {
    const files: string[] = [];
    const ignored: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        const rel = toPosix(relative(root, resolve(dir, ent.name)));
        if (hidden(rel)) continue;
        if (ent.isDirectory()) SKIP_DIRS.has(ent.name) ? ignored.push(rel) : await walk(resolve(dir, ent.name));
        else if (ent.isFile()) files.push(rel);
      }
    };
    await walk(root);
    return { files, ignored };
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const WIDE = 40; // an open folder with more files than this keeps only the rows around each touched file
const AROUND = 3;

/**
 * The tree slice for one trip: folders on its route open, every other folder one collapsed row with its file count,
 * ignored folders dimmed, wide folders windowed round the touched files with "+ N more" fold rows. No cap: what is big folds.
 * ponytail: VS Code's compact folders and .vscode/settings.json sort orders are not applied; the upgrade path is spec §3.
 */
export function sliceTree(files: readonly string[], ignored: readonly string[], touched: readonly string[]): { total: number; nodes: FileNode[] } {
  type Dir = { files: string[]; dirs: Set<string>; count: number; ignored?: boolean };
  const dirs = new Map<string, Dir>([["", { files: [], dirs: new Set(), count: 0 }]]);
  const dirOf = (p: string): Dir => {
    let d = dirs.get(p);
    if (d) return d;
    d = { files: [], dirs: new Set(), count: 0 };
    dirs.set(p, d);
    const i = p.lastIndexOf("/");
    dirOf(i < 0 ? "" : p.slice(0, i)).dirs.add(p);
    return d;
  };
  const parent = (p: string) => (p.lastIndexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/")));
  const want = new Set(touched.filter((t) => t && !t.includes("\0")));
  const all = new Set(files);
  for (const t of want) if (!all.has(t)) all.add(t); // a stop is never hidden, even if git has no row for it
  for (const f of all) {
    dirOf(parent(f)).files.push(f);
    for (let p = parent(f); ; p = parent(p)) {
      dirOf(p).count++;
      if (!p) break;
    }
  }
  for (const g of ignored) dirOf(g).ignored = true;
  const route = new Set<string>([""]);
  for (const t of want) for (let p = parent(t); p; p = parent(p)) route.add(p);
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const isIgnored = (p: string): boolean => {
    for (let q = p; q; q = parent(q)) if (dirs.get(q)?.ignored) return true;
    return false;
  };

  const build = (p: string): FileNode[] => {
    const d = dirs.get(p)!;
    const sub = [...d.dirs].sort((a, b) => collator.compare(name(a), name(b))).map((q): FileNode => {
      const node: FileNode = { name: name(q), path: q, dir: true, count: dirs.get(q)!.count };
      if (isIgnored(q)) node.ignored = true;
      if (route.has(q)) node.children = build(q);
      return node;
    });
    const fs = [...d.files].sort((a, b) => collator.compare(name(a), name(b)));
    const out: FileNode[] = [];
    let gap: string[] = [];
    const keep = new Set<number>();
    if (fs.length > WIDE) fs.forEach((f, i) => want.has(f) && Array.from({ length: AROUND * 2 + 1 }, (_, k) => keep.add(i - AROUND + k)));
    const flush = () => {
      if (gap.length >= AROUND) out.push({ name: `+ ${gap.length} more`, path: `${p}/#fold${out.length}`, dir: false, fold: gap.length });
      else for (const f of gap) out.push({ name: name(f), path: f, dir: false });
      gap = [];
    };
    fs.forEach((f, i) => {
      if (fs.length <= WIDE || keep.has(i)) {
        flush();
        out.push({ name: name(f), path: f, dir: false, ...(isIgnored(f) ? { ignored: true } : {}) });
      } else gap.push(f);
    });
    flush();
    return [...sub, ...out];
  };
  return { total: files.length, nodes: build("") };
}

export async function mapTree(root: string, touched: readonly string[]): Promise<{ total: number; nodes: FileNode[] }> {
  const { files, ignored } = await listing(root);
  return sliceTree(files, ignored, touched);
}

// ponytail: skips the fixed ignore list rather than parsing .gitignore.
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const flatten = (nodes: FileNode[]) => {
    for (const n of nodes) n.dir ? flatten(n.children ?? []) : out.push(n.path);
  };
  flatten(await fileTree(root));
  return out;
}

export async function readFile(root: string, rel: string): Promise<string> {
  return fsReadFile(resolveInside(root, rel), "utf8");
}

export async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const abs = resolveInside(root, rel);
  if (!existsSync(dirname(abs))) throw new Error(`Folder doesn't exist: ${toPosix(dirname(rel))}`);
  await fsWriteFile(abs, content, "utf8");
}

export async function searchCode(root: string, query: string, glob?: string): Promise<{ file: string; line: number; text: string }[]> {
  const q = query.toLowerCase();
  const hits: { file: string; line: number; text: string }[] = [];
  if (!q) return hits;
  for (const file of await listFiles(root)) {
    if (glob && !matchesGlob(file, glob) && !matchesGlob(file.split("/").pop()!, glob)) continue;
    const abs = resolve(root, file);
    try {
      if ((await stat(abs)).size > MAX_SEARCH_FILE) continue;
      const text = await fsReadFile(abs, "utf8");
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.toLowerCase().includes(q)) continue;
        hits.push({ file, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
        if (hits.length >= MAX_SEARCH_HITS) return hits;
      }
    } catch {}
  }
  return hits;
}

export function watchFiles(root: string, onChange: (path: string) => void): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let w: ReturnType<typeof watch> | undefined;
  try {
    w = watch(root, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const path = toPosix(name.toString());
      if (path.split("/").some(isIgnored) || path.startsWith(".shrike/worktrees/")) return;
      clearTimeout(timers.get(path));
      timers.set(path, setTimeout(() => (timers.delete(path), onChange(path)), 100));
    });
    w.on("error", () => {});
  } catch (err) {
    console.error("[shrike] file watch failed", err);
  }
  return () => {
    w?.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
