// AP: the API client service. Electron-free; main passes in the keychain, dialogs and the store.
import { readFile } from "node:fs/promises";
import type { ActionView, ApiCodeLang, ApiCollection, ApiHistoryEntry, ApiHost, ApiImportKind, ApiRequest, ApiSendOptions, ApiSendResult, DebugEvent, Route, TimelineNode } from "@shrike/schema";
import type { Store } from "../store.ts";
import { toCode } from "./codegen.ts";
import { blankRequest, createCollections, type Keychain } from "./collections.ts";
import { CookieJar, execute, isLoopback, prepare, type SendContext } from "./exec.ts";
import { createHistory } from "./history.ts";
import { importOpenApi, importPostman, importRoutes, parseCurl, pathParamsOf, splitQuery, type ImportDraft } from "./import.ts";
import type { Scope } from "./vars.ts";

export interface ApiDeps {
  stateDir: () => string;
  projectRoot: () => string | undefined;
  keychain: Keychain;
  store: Store;
  baseUrl: () => string | undefined;
  routes: () => Route[];
  getAction: (id: string) => ActionView | undefined;
  pickFolder?: (title: string) => Promise<string | undefined>;
  pickFile?: (title: string, exts?: string[]) => Promise<string | undefined>;
}

export function createApi(d: ApiDeps) {
  const cols = createCollections(d);
  const history = createHistory(d);
  const jars = new Map<string, CookieJar>();
  const runtime = new Map<string, Scope>(); // vars set by post-response vars and scripts, per collection, until restart
  const inflight = new Map<string, AbortController>();

  async function context(opts: ApiSendOptions | undefined, req: ApiRequest, trigger: "explorer" | "agent"): Promise<SendContext> {
    const key = opts?.collectionId ?? "";
    const jar = jars.get(key) ?? new CookieJar();
    jars.set(key, jar);
    const ctx: SendContext = { baseUrl: d.baseUrl(), jar, store: d.store, trigger, runtime: trigger === "agent" ? {} : (runtime.get(key) ?? {}), runScripts: trigger === "explorer", ...(opts?.resendOf ? { resendOf: opts.resendOf } : {}) };
    if (opts?.collectionId) {
      const layers = cols.layers(opts.collectionId, req.path || "x");
      ctx.root = cols.ref(opts.collectionId).root;
      ctx.collection = layers.collection;
      ctx.folders = layers.folders;
      ctx.env = await cols.envScope(opts.collectionId, opts.environment);
    }
    return ctx;
  }

  async function send(req: ApiRequest, opts?: ApiSendOptions, trigger: "explorer" | "agent" = "explorer"): Promise<ApiSendResult> {
    const ac = new AbortController();
    if (opts?.sendId) inflight.set(opts.sendId, ac);
    try {
      const ctx = { ...(await context(opts, req, trigger)), signal: ac.signal };
      let result: ApiSendResult;
      try {
        result = await execute(req, ctx);
      } catch (err) {
        result = { sent: { method: req.method, url: req.url, headers: {} }, error: (err as Error).message, assertions: [], setVars: {}, logs: [] };
      }
      const key = opts?.collectionId ?? "";
      if (Object.keys(result.setVars).length) runtime.set(key, { ...(runtime.get(key) ?? {}), ...result.setVars });
      void history.add({
        id: Math.random().toString(16).slice(2, 14),
        at: Date.now(),
        method: result.sent.method,
        url: result.sent.url,
        ...(result.response ? { status: result.response.status, durationMs: Math.round(result.response.timings.totalMs) } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
        ...(opts?.collectionId ? { collectionId: opts.collectionId } : {}),
        request: req,
      });
      return result;
    } finally {
      if (opts?.sendId) inflight.delete(opts.sendId);
    }
  }

  function firstRequest(nodes: TimelineNode[]): DebugEvent | undefined {
    for (const n of nodes) {
      if (n.event.kind === "http_request" && n.event.http) return n.event;
      const deeper = firstRequest(n.children);
      if (deeper) return deeper;
    }
    return undefined;
  }

  async function importAny(kind: ApiImportKind, text: string | undefined, name: string | undefined): Promise<ApiCollection | ApiRequest> {
    if (kind === "curl") return parseCurl(text ?? "");
    if (kind === "bruno") {
      const dir = text ?? (await d.pickFolder?.("Pick a Bruno collection folder"));
      if (!dir) throw new Error("No folder picked.");
      return cols.copyIn(dir);
    }
    let draft: ImportDraft;
    if (kind === "routes") draft = importRoutes(d.routes(), d.baseUrl(), name ?? "Routes");
    else {
      let src = text;
      if (src === undefined) {
        const f = await d.pickFile?.(kind === "postman" ? "Pick a Postman collection" : "Pick an OpenAPI file", kind === "postman" ? ["json"] : ["json", "yaml", "yml"]);
        if (!f) throw new Error("No file picked.");
        src = await readFile(f, "utf8");
      }
      draft = kind === "postman" ? importPostman(src) : importOpenApi(src);
    }
    if (name) draft.name = name;
    return cols.writeDraft(draft);
  }

  const host: ApiHost = {
    async send(spec, assertions) {
      const url = spec.url;
      const headers = Object.entries(spec.headers ?? {}).map(([name, value]) => ({ name, value, enabled: true }));
      const body = spec.body === undefined ? ({ type: "none" } as const) : /^\s*[[{]/.test(spec.body) ? ({ type: "json", data: spec.body } as const) : ({ type: "text", data: spec.body } as const);
      const r = await send(blankRequest({ name: `${spec.method} ${url}`, method: spec.method, url, headers, body, assertions: assertions ?? [] }), undefined, "agent");
      if (!r.response) throw new Error(r.error ?? "The request didn't go through.");
      const res = r.response;
      return { response: { status: res.status, statusText: res.statusText, headers: res.headers, body: res.bodyEncoding === "base64" ? `[binary ${res.contentType ?? ""}, ${res.size} bytes]` : res.body, durationMs: res.timings.totalMs }, ...(r.actionId ? { actionId: r.actionId } : {}), ...(assertions?.length ? { assertions: r.assertions } : {}) };
    },
    async save(partial, folder) {
      const owned = cols.list().find((c) => c.owned) ?? (await cols.create("Shrike"));
      const { params } = splitQuery(partial.url);
      const req = blankRequest({ params, pathParams: pathParamsOf(partial.url), ...partial, path: "" });
      return (await cols.saveRequest(owned.id, req, folder)).path;
    },
    async list() {
      const out: { collection: string; path: string; method: string; name: string }[] = [];
      for (const c of cols.list()) {
        const walk = (nodes: ApiCollection["tree"]) => nodes.forEach((n) => (n.type === "folder" ? walk(n.children) : out.push({ collection: c.name, path: n.path, method: n.method, name: n.name })));
        walk(c.tree);
      }
      return out;
    },
  };

  return {
    collections: async () => cols.list(),
    createCollection: (name: string) => cols.create(name),
    async linkCollection(dir?: string): Promise<ApiCollection | null> {
      const picked = dir ?? (await d.pickFolder?.("Open a Bruno collection"));
      return picked ? cols.link(picked) : null;
    },
    unlinkCollection: (id: string) => cols.unlink(id),
    readRequest: (id: string, path: string) => cols.readRequest(id, path),
    saveRequest: (id: string, req: ApiRequest, folder?: string) => cols.saveRequest(id, req, folder),
    deleteItem: (id: string, path: string) => cols.deleteItem(id, path),
    createFolder: (id: string, path: string) => cols.createFolder(id, path),
    renameItem: (id: string, path: string, name: string) => cols.renameItem(id, path, name),
    readEnvironment: (id: string, name: string) => cols.readEnvironment(id, name),
    saveEnvironment: (id: string, env: Parameters<typeof cols.saveEnvironment>[1]) => cols.saveEnvironment(id, env),
    send,
    async cancel(sendId: string) {
      inflight.get(sendId)?.abort();
    },
    history: (): Promise<ApiHistoryEntry[]> => history.list(),
    clearHistory: () => history.clear(),
    import: importAny,
    async code(req: ApiRequest, lang: ApiCodeLang, opts?: ApiSendOptions): Promise<string> {
      const ctx = await context(opts, req, "explorer");
      return toCode(await prepare(req, ctx), lang);
    },
    async fromTrip(actionId: string): Promise<ApiRequest> {
      const view = d.getAction(actionId);
      if (!view) throw new Error("That trip isn't in this session anymore.");
      const ev = firstRequest(view.tree) ?? (view.root.http ? view.root : undefined);
      if (!ev?.http) throw new Error("That trip has no HTTP request to resend.");
      const h = ev.http;
      const headers = Object.entries(h.reqHeaders ?? {})
        .filter(([k]) => !/^(traceparent|tracestate|content-length|host|connection|accept-encoding)$/i.test(k))
        .map(([name, value]) => ({ name, value, enabled: true }));
      const raw = h.reqBody;
      const json = raw !== undefined && /^\s*[[{]/.test(raw);
      const { params } = splitQuery(h.url);
      return blankRequest({
        name: `${h.method} ${h.url.split("?")[0]}`.slice(0, 200),
        method: h.method.toUpperCase(),
        url: h.url,
        params,
        headers,
        body: raw === undefined || raw === "" ? { type: "none" } : json ? { type: "json", data: raw } : { type: "text", data: raw },
      });
    },
    host,
    isLoopback,
  };
}
export type Api = ReturnType<typeof createApi>;
