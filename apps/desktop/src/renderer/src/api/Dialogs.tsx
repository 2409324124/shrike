import { useEffect, useState, type ReactNode } from "react";
import { Copy, Eye, EyeOff, FolderOpen, Plus, Upload, X } from "lucide-react";
import type { ApiCodeLang, ApiImportKind } from "@shrike/schema";
import { CodeBlock, cx, IconButton, Spinner } from "../components/ui.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { toast } from "../stores/ui.ts";
import { blankReq, looksLikeCurl, row, tryJson, type Row } from "./model.ts";
import { KvTable } from "./parts.tsx";
import { appAddress, colFor, scopeFor, useApi } from "./store.ts";
import { keys } from "../lib/platform.ts";

// AP-env editor, AP12 import and AP13 code: centred solid glass cards over the client.

function Card({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return (
    <div className="ap-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-label={title} className={cx("ap-card glass solid rise", wide && "wide")}>
        <header>
          <span className="lbl text-ink">{title}</span>
          <div className="flex-1" />
          <IconButton label={`Close ${title}`} onClick={onClose}>
            <X size={13} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

const close = () => useApi.setState({ dialog: null });

export function EnvDialog() {
  const col = useApi((s) => colFor(s));
  const inUse = useApi((s) => (col ? (s.envByCol[col.id] ?? null) : null));
  const [sel, setSel] = useState<string | null>(inUse ?? col?.environments[0] ?? null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // a new env's name, not saved yet
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (fresh !== null && fresh === sel) return;
    setRows(null);
    if (!col || !sel) return;
    let live = true;
    void api()
      .apiReadEnvironment(col.id, sel)
      .then((e) => live && setRows(e.vars.map((v) => ({ ...row(v.name, v.value, v.enabled), ...(v.secret ? { secret: true } : {}) }))))
      .catch((e: unknown) => live && (toast(`Couldn't read ${sel}: ${errorMessage(e)}`, "error"), setRows([])));
    return () => {
      live = false;
    };
  }, [col?.id, sel]);

  if (!col)
    return (
      <Card title="Environments" onClose={close}>
        <p className="ap-hint">Environments live in a collection. Save a request first ({keys("⌘S")}) and Shrike makes one in .shrike/api/.</p>
      </Card>
    );
  const names = [...col.environments, ...(fresh && !col.environments.includes(fresh) ? [fresh] : [])];
  const add = () => {
    let name = names.length ? "Staging" : "Local";
    for (let i = 2; names.includes(name); i++) name = `Environment ${i}`;
    setFresh(name);
    setSel(name);
    setRows([row("baseUrl", appAddress() ?? "http://localhost:3000")]);
  };
  const save = async () => {
    if (!sel || !rows) return;
    setBusy(true);
    try {
      const c = await api().apiSaveEnvironment(col.id, { name: sel, vars: rows.filter((r) => r.name).map((r) => ({ name: r.name, value: r.value, enabled: r.on, ...(r.secret ? { secret: true } : {}) })) });
      useApi.setState((s) => ({ collections: s.collections.map((x) => (x.id === c.id ? c : x)) }));
      setFresh(null);
      if (inUse === sel || !inUse) await useApi.getState().setEnv(col.id, sel);
      toast(`Saved ${sel}`, "ok");
    } catch (e) {
      toast(`Couldn't save ${sel}: ${errorMessage(e)}`, "error");
    }
    setBusy(false);
  };
  return (
    <Card title={`Environments · ${col.name}`} onClose={close} wide>
      <div className="ap-env">
        <aside>
          {names.map((n) => (
            <button key={n} type="button" className={cx("ap-env-item", sel === n && "on")} onClick={() => setSel(n)}>
              {n}
              {inUse === n && <small className="text-ok">in use</small>}
              {fresh === n && <small>not saved yet</small>}
            </button>
          ))}
          <button type="button" className="ap-kv-add" onClick={add}>
            <Plus size={11} /> New environment
          </button>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {!sel ? (
            <p className="ap-hint">No environments yet. Make one for your local app, another for staging, and switch with the picker at the top right.</p>
          ) : !rows ? (
            <Spinner size={14} />
          ) : (
            <>
              <div className="flex items-center gap-2">
                {fresh === sel ? (
                  <input className="field flex-1" value={sel} aria-label="Environment name" onChange={(e) => (setFresh(e.target.value), setSel(e.target.value))} />
                ) : (
                  <span className="flex-1 text-[13px] text-ink">{sel}</span>
                )}
                <button type="button" className="hud-btn" disabled={inUse === sel || fresh === sel} onClick={() => void useApi.getState().setEnv(col.id, sel)}>
                  {inUse === sel ? "In use" : "Use this one"}
                </button>
                <button type="button" className="hud-btn solid" disabled={busy || !sel.trim()} onClick={() => void save()}>
                  Save
                </button>
              </div>
              <KvTable
                rows={rows}
                onChange={setRows}
                scope={scopeFor(blankReq(), col.id)}
                label="Vars"
                namePlaceholder="baseUrl"
                valueCell={(r, set) => (
                  <input className="ap-cell flex-1 font-mono" type={r.secret && !reveal.has(r.id) ? "password" : "text"} value={r.value} aria-label={`Value of ${r.name || "var"}`} spellCheck={false} onChange={(e) => set({ value: e.target.value })} />
                )}
                extra={(r) => (
                  <>
                    {r.secret && (
                      <button type="button" className="ap-eye" aria-label={reveal.has(r.id) ? `Hide ${r.name}` : `Show ${r.name}`} aria-pressed={reveal.has(r.id)} onClick={() => setReveal((s) => (s.has(r.id) ? new Set([...s].filter((x) => x !== r.id)) : new Set([...s, r.id])))}>
                        {reveal.has(r.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    )}
                    <label className="ap-secret-toggle" title="Secret values go to your keychain, never into a file">
                      <input type="checkbox" checked={!!r.secret} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, secret: e.target.checked } : x)))} />
                      Secret
                    </label>
                  </>
                )}
              />
              <p className="ap-hint">Secret values go to your keychain; the file only says the var is secret, the way Bruno does. Use a var anywhere as {"{{name}}"}. Relative URLs like /api/todos always go to your running app.</p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

const LANGS: { id: ApiCodeLang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "fetch", label: "fetch" },
  { id: "axios", label: "axios" },
  { id: "python", label: "Python" },
  { id: "httpie", label: "HTTPie" },
];

export function CodeDialog() {
  const tabId = useApi((s) => s.active);
  const draft = useApi((s) => s.tabs.find((t) => t.id === s.active)?.draft);
  const [lang, setLang] = useState<ApiCodeLang>("curl");
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!tabId) return;
    let live = true;
    setText(null);
    void useApi.getState().code(tabId, lang).then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [tabId, lang, draft]);
  if (!tabId) return null;
  return (
    <Card title="Show as code" onClose={close} wide>
      <div className="flex items-center gap-1">
        {LANGS.map((l) => (
          <button key={l.id} type="button" className="hud-btn" aria-pressed={lang === l.id} onClick={() => setLang(l.id)}>
            {l.label}
          </button>
        ))}
        <div className="flex-1" />
        <button type="button" className="hud-btn solid" disabled={!text} onClick={() => text && void navigator.clipboard.writeText(text).then(() => toast("Copied", "ok"), () => toast("Couldn't copy to the clipboard", "error"))}>
          <Copy size={11} /> Copy
        </button>
      </div>
      {text === null ? <Spinner size={14} /> : <CodeBlock className="max-h-[50vh]">{text}</CodeBlock>}
      <p className="ap-hint">Vars are filled in, so this can hold your real values. Check it before you paste it anywhere public.</p>
    </Card>
  );
}

/** What a pasted or dropped text is: curl, a Postman collection or an OpenAPI file. */
export function importKind(text: string): ApiImportKind | null {
  if (looksLikeCurl(text)) return "curl";
  const o = tryJson(text) as Record<string, unknown> | undefined;
  if (o && (Array.isArray(o.item) || String((o.info as Record<string, unknown> | undefined)?.schema ?? "").includes("collection"))) return "postman";
  if ((o && (o.openapi || o.swagger)) || /^\s*(openapi|swagger)\s*:/m.test(text)) return "openapi";
  return null;
}

export function ImportDialog() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const routes = useApi((s) => s.root) !== null;
  const kind = text.trim() ? importKind(text) : null;
  const run = async (k: ApiImportKind, t?: string, name?: string) => {
    setBusy(true);
    const ok = await useApi.getState().importAny(k, t, name);
    setBusy(false);
    if (ok) close();
  };
  const KIND = { curl: "a curl command", postman: "a Postman collection", openapi: "an OpenAPI file", bruno: "a Bruno folder", routes: "your routes" } as const;

  return (
    <Card title="Import requests" onClose={close} wide>
      <div
        className={cx("ap-drop", over && "over")}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (!f) return;
          void f.text().then((t) => {
            const k = importKind(t);
            if (k) void run(k, t, f.name.replace(/\.(json|ya?ml)$/i, ""));
            else toast(`Shrike couldn't tell what ${f.name} is. Drop a Postman collection or an OpenAPI file, or pick a Bruno folder.`, "error");
          });
        }}
      >
        <Upload size={16} className="text-faint" aria-hidden />
        <p className="text-[12.5px] text-ink">Drop a Postman collection or an OpenAPI file here.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="hud-btn solid" disabled={busy} onClick={() => void run("postman")}>
            <Upload size={11} /> Postman file
          </button>
          <button type="button" className="hud-btn solid" disabled={busy} onClick={() => void run("openapi")}>
            <Upload size={11} /> OpenAPI file
          </button>
          <button type="button" className="hud-btn solid" disabled={busy} onClick={() => void run("bruno")} title="Copy a Bruno collection into .shrike/api/">
            <FolderOpen size={11} /> Copy a Bruno folder
          </button>
          <button type="button" className="hud-btn solid" disabled={busy} onClick={() => (close(), void useApi.getState().link())} title="Work on a Bruno collection where it is: saves go to its files">
            <FolderOpen size={11} /> Open a Bruno folder in place
          </button>
          {routes && (
            <button type="button" className="hud-btn solid" disabled={busy} onClick={() => void run("routes", undefined, "Routes")}>
              Every route in your code
            </button>
          )}
        </div>
      </div>
      <textarea
        className="ap-bulk h-[110px]"
        value={text}
        spellCheck={false}
        aria-label="Paste a curl command or a collection"
        placeholder="Or paste a curl command (Copy as cURL from your browser), a Postman collection or an OpenAPI file"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex min-h-[28px] items-center gap-3">
        <p className={cx("min-w-0 flex-1 text-[12px]", text.trim() && !kind ? "text-slow" : "text-dim")} role="status">
          {kind ? `Looks like ${KIND[kind]}.` : text.trim() ? "Shrike can't read that. Try a curl command, Postman v2.1 or OpenAPI 3." : "Nothing leaves this Mac. Tokens found in files are flagged so you can move them to a secret."}
        </p>
        <button type="button" className="btn go" disabled={!kind || busy} onClick={() => kind && void run(kind, text)}>
          {busy && <Spinner size={11} />}
          Import
        </button>
      </div>
    </Card>
  );
}
