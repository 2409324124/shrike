// Collections on disk: Bruno folders (bruno.json + *.bru, or OpenCollection YAML). The project's own live in
// <project>/.shrike/api/<name>/; any other Bruno folder can be linked in place. Secret env values go to the keychain.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApiAuth, ApiCollection, ApiEnvironment, ApiKv, ApiRequest, ApiTreeNode } from "@shrike/schema";
import { bruToDefaults, bruToEnv, bruToRequest, defaultsToBru, envToBru, parseBru, requestToBru, type BruDefaults } from "./bru.ts";
import type { Layer } from "./exec.ts";
import { defaultsToOc, ocToDefaults, ocToRequest, requestToOc, setOcEnvironment } from "./oc.ts";
import type { Scope } from "./vars.ts";

export interface Keychain {
  encrypt(s: string): string;
  decrypt(s: string): string;
}
interface Opts {
  stateDir: () => string;
  projectRoot: () => string | undefined;
  keychain: Keychain;
}
type Ref = { id: string; root: string; format: "bru" | "yaml"; owned: boolean };

export const collectionId = (root: string) => createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12);
export const blankRequest = (over: Partial<ApiRequest> = {}): ApiRequest => ({ path: "", name: "Untitled", method: "GET", url: "", params: [], pathParams: [], headers: [], body: { type: "none" }, auth: { type: "inherit" }, vars: { pre: [], post: [] }, assertions: [], scripts: {}, settings: {}, ...over });

export function detectFormat(dir: string): "bru" | "yaml" | undefined {
  if (existsSync(join(dir, "opencollection.yml")) || existsSync(join(dir, "opencollection.yaml"))) return "yaml";
  if (existsSync(join(dir, "bruno.json"))) return "bru";
  return undefined;
}
const ocFile = (root: string) => (existsSync(join(root, "opencollection.yaml")) ? join(root, "opencollection.yaml") : join(root, "opencollection.yml"));

/** No symlinks anywhere from the collection root down, no .claude, nothing outside the root. */
export function safeJoin(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === ".." || s === ".claude" || s === ".git" || s === "node_modules")) throw new Error(`That path isn't allowed: ${rel}`);
  const abs = resolve(root, rel);
  if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) throw new Error(`That path isn't allowed: ${rel}`);
  let cur = resolve(root);
  for (const seg of ["", ...relative(cur, abs).split(sep).filter(Boolean)]) {
    cur = seg ? join(cur, seg) : cur;
    try {
      if (lstatSync(cur).isSymbolicLink()) throw new Error(`${seg || cur} is a link to somewhere else, so Shrike won't write through it.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
  }
  return abs;
}

export async function atomicWrite(abs: string, text: string): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, abs);
}

export const fileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^\.+/, "").trim().slice(0, 120) || "Untitled";
const literalSecret = (v: string) => !!v.trim() && !/\{\{[^}]+\}\}/.test(v);
const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;

export function secretWarning(r: ApiRequest): string | undefined {
  const a = r.auth;
  const hit =
    (a.type === "bearer" && literalSecret(a.token)) ||
    (a.type === "basic" && literalSecret(a.password)) ||
    (a.type === "apikey" && literalSecret(a.value)) ||
    r.headers.some((h) => SECRET_HEADER.test(h.name) && literalSecret(h.value));
  return hit ? `${r.name} has a token saved in the file.` : undefined;
}

export function createCollections(o: Opts) {
  const linksFile = () => join(o.stateDir(), "api-links.json");
  const secretsFile = () => join(o.stateDir(), "api-secrets.json");
  const readJson = <T>(f: string, d: T): T => {
    try {
      return JSON.parse(readFileSync(f, "utf8")) as T;
    } catch {
      return d;
    }
  };
  const ownedDir = () => {
    const root = o.projectRoot();
    if (!root) throw new Error("Open a project first.");
    return join(root, ".shrike", "api");
  };

  function refs(): Ref[] {
    const out: Ref[] = [];
    const root = o.projectRoot();
    if (root) {
      const dir = join(root, ".shrike", "api");
      let names: string[] = [];
      try {
        if (!lstatSync(join(root, ".shrike")).isSymbolicLink()) names = readdirSync(dir);
      } catch {}
      for (const n of names.sort()) {
        const d = join(dir, n);
        const format = detectFormat(d);
        if (format && !lstatSync(d).isSymbolicLink()) out.push({ id: collectionId(d), root: d, format, owned: true });
      }
      for (const d of readJson<Record<string, string[]>>(linksFile(), {})[root] ?? []) {
        const format = detectFormat(d);
        if (format && !out.some((r) => r.root === d)) out.push({ id: collectionId(d), root: d, format, owned: false });
      }
    }
    return out;
  }
  const ref = (id: string): Ref => {
    const r = refs().find((x) => x.id === id);
    if (!r) throw new Error("That collection isn't open in this project anymore.");
    return r;
  };

  const isMeta = (r: Ref, n: string) => (r.format === "bru" ? n === "collection.bru" || n === "folder.bru" : /^(opencollection|folder)\.ya?ml$/.test(n));
  const isReq = (r: Ref, n: string) => (r.format === "bru" ? n.endsWith(".bru") : /\.ya?ml$/.test(n)) && !isMeta(r, n);
  const readReq = (r: Ref, rel: string, text: string) => (r.format === "bru" ? bruToRequest(parseBru(text), rel) : ocToRequest(text, rel));
  const folderFile = (r: Ref, dirRel: string) => join(r.root, dirRel, r.format === "bru" ? "folder.bru" : "folder.yml");
  const readDefaults = (r: Ref, dirRel: string): BruDefaults => {
    const f = dirRel ? folderFile(r, dirRel) : r.format === "bru" ? join(r.root, "collection.bru") : ocFile(r.root);
    try {
      const t = readFileSync(f, "utf8");
      return r.format === "bru" ? bruToDefaults(t) : ocToDefaults(t);
    } catch {
      return { headers: [], auth: { type: "inherit" }, vars: [] };
    }
  };

  function walk(r: Ref, dirRel: string, warnings: string[]): ApiTreeNode[] {
    const abs = join(r.root, dirRel);
    const nodes: ApiTreeNode[] = [];
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || ent.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || (!dirRel && ent.name === "environments")) continue;
        const d = readDefaults(r, rel);
        nodes.push({ type: "folder", name: d.name ?? ent.name, path: rel, ...(d.seq === undefined ? {} : { seq: d.seq }), children: walk(r, rel, warnings) });
      } else if (ent.isFile() && isReq(r, ent.name)) {
        try {
          const req = readReq(r, rel, readFileSync(join(abs, ent.name), "utf8"));
          const w = secretWarning(req);
          if (w) warnings.push(w);
          nodes.push({ type: "request", name: req.name, path: rel, method: req.method, ...(req.seq === undefined ? {} : { seq: req.seq }) });
        } catch {
          warnings.push(`${rel} couldn't be read, so it's skipped.`);
        }
      }
    }
    return nodes.sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9) || (a.type === b.type ? 0 : a.type === "folder" ? -1 : 1) || a.name.localeCompare(b.name));
  }

  function view(r: Ref): ApiCollection {
    const warnings: string[] = [];
    const tree = walk(r, "", warnings);
    const d = readDefaults(r, "");
    let name = r.root.split(sep).pop()!;
    let environments: string[] = [];
    if (r.format === "bru") {
      name = readJson<{ name?: string }>(join(r.root, "bruno.json"), {}).name ?? name;
      try {
        environments = readdirSync(join(r.root, "environments")).filter((f) => f.endsWith(".bru")).map((f) => f.slice(0, -4)).sort();
      } catch {}
    } else {
      try {
        const oc = ocToDefaults(readFileSync(ocFile(r.root), "utf8"));
        name = oc.name ?? name;
        environments = oc.environments.map((e) => e.name);
      } catch {
        warnings.push("opencollection.yml couldn't be read.");
      }
    }
    return { id: r.id, root: r.root, name, format: r.format, owned: r.owned, tree, environments, defaults: { headers: d.headers, auth: d.auth, vars: d.vars }, warnings };
  }

  const secrets = () => readJson<Record<string, Record<string, Record<string, string>>>>(secretsFile(), {});

  return {
    list: (): ApiCollection[] => refs().map(view),
    get: (id: string) => view(ref(id)),

    async create(name: string): Promise<ApiCollection> {
      const root = o.projectRoot();
      if (!root) throw new Error("Open a project first.");
      if (existsSync(join(root, ".shrike")) && lstatSync(join(root, ".shrike")).isSymbolicLink()) throw new Error("This project's .shrike folder is a link to somewhere else, so Shrike won't write into it.");
      const dir = safeJoin(ownedDir(), fileName(name));
      if (existsSync(dir)) throw new Error(`There's already a collection called ${name}.`);
      await atomicWrite(join(dir, "bruno.json"), `${JSON.stringify({ version: "1", name, type: "collection", ignore: ["node_modules", ".git"] }, null, 2)}\n`);
      return view(ref(collectionId(dir)));
    },

    async link(dir: string): Promise<ApiCollection> {
      const root = o.projectRoot();
      if (!root) throw new Error("Open a project first.");
      const abs = resolve(dir);
      if (lstatSync(abs).isSymbolicLink()) throw new Error("That folder is a link to somewhere else. Pick the real folder.");
      if (abs.split(sep).includes(".claude")) throw new Error("Shrike doesn't open collections inside .claude folders.");
      if (!detectFormat(abs)) throw new Error("That folder isn't a Bruno collection (no bruno.json or opencollection.yml).");
      const links = readJson<Record<string, string[]>>(linksFile(), {});
      links[root] = [...new Set([...(links[root] ?? []), abs])];
      await atomicWrite(linksFile(), JSON.stringify(links, null, 2));
      return view(ref(collectionId(abs)));
    },

    async unlink(id: string): Promise<void> {
      const root = o.projectRoot();
      if (!root) return;
      const links = readJson<Record<string, string[]>>(linksFile(), {});
      links[root] = (links[root] ?? []).filter((d) => collectionId(d) !== id);
      await atomicWrite(linksFile(), JSON.stringify(links, null, 2));
    },

    async readRequest(id: string, path: string): Promise<ApiRequest> {
      const r = ref(id);
      return readReq(r, path, await readFile(safeJoin(r.root, path), "utf8"));
    },

    async saveRequest(id: string, req: ApiRequest, folder = ""): Promise<{ path: string; collection: ApiCollection }> {
      const r = ref(id);
      const ext = r.format === "bru" ? ".bru" : ".yml";
      let path = req.path;
      let original: string | undefined;
      if (path) original = await readFile(safeJoin(r.root, path), "utf8").catch(() => undefined);
      else {
        const dir = folder ? safeJoin(r.root, folder) : r.root;
        let base = fileName(req.name);
        for (let n = 2; existsSync(join(dir, base + ext)) || isMeta(r, base + ext); n++) base = `${fileName(req.name)} ${n}`;
        path = folder ? `${folder}/${base}${ext}` : base + ext;
        if (req.seq === undefined) {
          const seqs = (walk(r, folder, []) as ApiTreeNode[]).map((n) => n.seq ?? 0);
          req = { ...req, seq: Math.max(0, ...seqs) + 1 };
        }
      }
      if (!isReq(r, path.split("/").pop()!)) throw new Error(`A request file must end in ${ext}.`);
      const saved = { ...req, path };
      const text = r.format === "bru" ? requestToBru(saved, original) : requestToOc(saved, original);
      if (text !== original) await atomicWrite(safeJoin(r.root, path), text);
      return { path, collection: view(r) };
    },

    async deleteItem(id: string, path: string): Promise<ApiCollection> {
      const r = ref(id);
      const abs = safeJoin(r.root, path);
      if (abs === resolve(r.root)) throw new Error("Pick a request or folder to delete.");
      await rm(abs, { recursive: true });
      return view(r);
    },

    async createFolder(id: string, path: string): Promise<ApiCollection> {
      const r = ref(id);
      const parts = path.split("/").map(fileName);
      const rel = parts.join("/");
      const abs = safeJoin(r.root, rel);
      if (existsSync(abs)) throw new Error(`There's already a folder called ${parts.at(-1)}.`);
      const name = path.split("/").pop()!;
      const parent = parts.slice(0, -1).join("/");
      const seq = Math.max(0, ...walk(r, parent, []).map((n) => n.seq ?? 0)) + 1;
      await mkdir(abs, { recursive: true });
      await atomicWrite(folderFile(r, rel), r.format === "bru" ? defaultsToBru({ name, seq, headers: [], auth: { type: "inherit" }, vars: [] }) : defaultsToOc({ name, seq, headers: [], auth: { type: "inherit" }, vars: [] }).replace(/^info:\n {2}name: .*\n/, (m) => `${m}  type: folder\n`));
      return view(r);
    },

    async renameItem(id: string, path: string, name: string): Promise<ApiCollection> {
      const r = ref(id);
      const abs = safeJoin(r.root, path);
      if (abs === resolve(r.root)) throw new Error("Pick a request or folder to rename.");
      const isDir = lstatSync(abs).isDirectory();
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (isDir) {
        const f = folderFile(r, path);
        const before = existsSync(f) ? readFileSync(f, "utf8") : "";
        const d = readDefaults(r, path);
        await atomicWrite(f, r.format === "bru" ? defaultsToBru({ ...d, name }, before) : defaultsToOc({ ...d, name }, before));
        const to = safeJoin(r.root, parent ? `${parent}/${fileName(name)}` : fileName(name));
        if (to !== abs) await rename(abs, to);
      } else {
        const req = await this.readRequest(id, path);
        const ext = r.format === "bru" ? ".bru" : ".yml";
        const toRel = parent ? `${parent}/${fileName(name)}${ext}` : `${fileName(name)}${ext}`;
        if (toRel !== path && existsSync(safeJoin(r.root, toRel))) throw new Error(`There's already a request called ${name} there.`);
        await this.saveRequest(id, { ...req, name });
        if (toRel !== path) await rename(abs, safeJoin(r.root, toRel));
      }
      return view(r);
    },

    async readEnvironment(id: string, name: string): Promise<ApiEnvironment> {
      const r = ref(id);
      let env: ApiEnvironment;
      if (r.format === "bru") env = bruToEnv(name, await readFile(safeJoin(r.root, `environments/${fileName(name)}.bru`), "utf8"));
      else {
        const found = ocToDefaults(readFileSync(ocFile(r.root), "utf8")).environments.find((e) => e.name === name);
        if (!found) throw new Error(`There's no environment called ${name}.`);
        env = found;
      }
      const stored = secrets()[id]?.[name] ?? {};
      return {
        name,
        vars: env.vars.map((v) => {
          if (!v.secret || !stored[v.name]) return v;
          try {
            return { ...v, value: o.keychain.decrypt(stored[v.name]!) };
          } catch {
            return v;
          }
        }),
      };
    },

    async saveEnvironment(id: string, env: ApiEnvironment): Promise<ApiCollection> {
      const r = ref(id);
      const all = secrets();
      const mine: Record<string, string> = {};
      for (const v of env.vars) if (v.secret && v.value) mine[v.name] = o.keychain.encrypt(v.value);
      all[id] = { ...(all[id] ?? {}), [env.name]: mine };
      await atomicWrite(secretsFile(), JSON.stringify(all));
      if (r.format === "bru") await atomicWrite(safeJoin(r.root, `environments/${fileName(env.name)}.bru`), envToBru(env));
      else await atomicWrite(ocFile(r.root), setOcEnvironment(readFileSync(ocFile(r.root), "utf8"), env));
      return view(r);
    },

    async saveDefaults(id: string, folder: string, d: { headers: ApiKv[]; auth: ApiAuth; vars: ApiKv[] }): Promise<ApiCollection> {
      const r = ref(id);
      const f = folder ? folderFile(r, folder) : r.format === "bru" ? join(r.root, "collection.bru") : ocFile(r.root);
      const before = existsSync(safeJoin(r.root, relative(r.root, f))) ? readFileSync(f, "utf8") : "";
      const cur = readDefaults(r, folder);
      const next = { ...cur, ...d };
      const text = r.format === "bru" ? defaultsToBru(next, before) : defaultsToOc(next, before);
      if (text !== before) await atomicWrite(f, text);
      return view(r);
    },

    /** Collection and folder layers for one request, outer to inner. */
    layers(id: string, path: string): { collection: Layer; folders: Layer[] } {
      const r = ref(id);
      const parts = path.split("/").slice(0, -1);
      const folders: Layer[] = [];
      for (let k = 1; k <= parts.length; k++) {
        const d = readDefaults(r, parts.slice(0, k).join("/"));
        folders.push({ headers: d.headers, auth: d.auth, vars: d.vars });
      }
      const c = readDefaults(r, "");
      return { collection: { headers: c.headers, auth: c.auth, vars: c.vars }, folders };
    },

    async envScope(id: string, name: string | undefined): Promise<Scope> {
      if (!name) return {};
      const env = await this.readEnvironment(id, name);
      return Object.fromEntries(env.vars.filter((v) => v.enabled).map((v) => [v.name, v.value]));
    },

    /** A parsed import becomes a new collection of the project's own, in Bruno format. */
    async writeDraft(d: { name: string; requests: { folder: string; req: ApiRequest }[]; folders: string[]; vars: ApiKv[]; auth: ApiAuth; headers: ApiKv[]; environments: ApiEnvironment[] }): Promise<ApiCollection> {
      let name = d.name;
      for (let n = 2; existsSync(join(ownedDir(), fileName(name))); n++) name = `${d.name} ${n}`;
      const col = await this.create(name);
      const r = ref(col.id);
      const dirs = new Map<string, string>([["", ""]]);
      for (const f of [...new Set([...d.folders, ...d.requests.map((x) => x.folder)])].filter(Boolean).sort()) {
        const parts = f.split("/");
        const rel = parts.map(fileName).join("/");
        dirs.set(f, rel);
        if (!existsSync(safeJoin(r.root, rel))) {
          await mkdir(safeJoin(r.root, rel), { recursive: true });
          await atomicWrite(folderFile(r, rel), defaultsToBru({ name: parts.at(-1)!, seq: d.folders.indexOf(f) + 1 || undefined, headers: [], auth: { type: "inherit" }, vars: [] }));
        }
      }
      if (d.headers.length || d.vars.length || d.auth.type !== "inherit") await atomicWrite(join(r.root, "collection.bru"), defaultsToBru({ headers: d.headers, auth: d.auth, vars: d.vars }));
      for (const { folder, req } of d.requests) await this.saveRequest(col.id, { ...req, path: "" }, dirs.get(folder) ?? "");
      for (const env of d.environments) await this.saveEnvironment(col.id, env);
      return view(r);
    },

    /** Copies a Bruno folder into the project (links, .git and node_modules are skipped). */
    async copyIn(dir: string): Promise<ApiCollection> {
      const src = resolve(dir);
      if (lstatSync(src).isSymbolicLink() || !detectFormat(src)) throw new Error("That folder isn't a Bruno collection (no bruno.json or opencollection.yml).");
      let name = src.split(sep).pop()!;
      for (let n = 2; existsSync(join(ownedDir(), fileName(name))); n++) name = `${src.split(sep).pop()} ${n}`;
      const dest = safeJoin(ownedDir(), fileName(name));
      await cp(src, dest, { recursive: true, verbatimSymlinks: true, filter: (p) => !lstatSync(p).isSymbolicLink() && !/[\\/](\.git|node_modules|\.env[^\\/]*)$/.test(p) });
      return view(ref(collectionId(dest)));
    },

    ownedDir,
    ref,
  };
}
export type Collections = ReturnType<typeof createCollections>;
