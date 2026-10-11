import { useEffect, useMemo, useState } from "react";
import { Code2, Save, Send, TriangleAlert, X } from "lucide-react";
import { cx, Spinner } from "../components/ui.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { toast } from "../stores/ui.ts";
import { api, errorMessage } from "../lib/api.ts";
import { BUILTINS, METHODS, OPERATORS, UNARY, fromApi, hasBody, isRedacted, looksLikeCurl, paramsFromUrl, pathParams, redactedVar, uid, urlWithParams, type Auth, type BodyMode, type Req, type Row, type Scope } from "./model.ts";
import { CodeArea, KvTable, SecretInput, VarInput } from "./parts.tsx";
import { appAddress, colFor, isDirty, scopeFor, useApi, type Tab } from "./store.ts";
import { checkBody, docFor } from "./routes.ts";
import { keys } from "../lib/platform.ts";

// AP-url and AP3: the URL bar and the request's tabs.

const NONE: Scope = {};

type ReqTab = "params" | "body" | "headers" | "auth" | "vars" | "script" | "assert" | "docs";

const HEADER_NAMES = ["Accept", "Accept-Language", "Authorization", "Cache-Control", "Content-Type", "Cookie", "If-None-Match", "Origin", "Referer", "User-Agent", "X-Api-Key", "X-Requested-With", "X-Request-Id"];
const BODY_MODES: { id: BodyMode; label: string }[] = [
  { id: "none", label: "No body" },
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "xml", label: "XML" },
  { id: "form", label: "Form (urlencoded)" },
  { id: "multipart", label: "Multipart form" },
  { id: "graphql", label: "GraphQL" },
];
const AUTH_LABEL: Record<Auth["type"], string> = { inherit: "Inherit from the collection", none: "No auth", bearer: "Bearer token", basic: "Basic (username and password)", apikey: "API key" };

const methodClass = (m: string) => ({ GET: "text-ok", POST: "text-signal", PUT: "text-slow", PATCH: "text-slow", DELETE: "text-fail" })[m] ?? "text-dim";

export function UrlBar({ tab }: { tab: Tab }) {
  const sending = useApi((s) => !!s.sending[tab.id]);
  const dirty = isDirty(tab);
  const r = tab.draft;
  const scope = scopeFor(r);
  const edit = (fn: (r: Req) => Req) => useApi.getState().edit(tab.id, fn);
  return (
    <form
      className="ap-url"
      aria-label="Request"
      onSubmit={(e) => {
        e.preventDefault();
        void useApi.getState().send(tab.id);
      }}
    >
      <select value={r.method} onChange={(e) => edit((x) => ({ ...x, method: e.target.value, body: hasBody(e.target.value) && x.body.mode === "none" ? { ...x.body, mode: "json" } : x.body }))} aria-label="Method" className={cx("ap-method", methodClass(r.method))}>
        {METHODS.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
      <VarInput
        value={r.url}
        scope={scope}
        here={appAddress()}
        aria-label="URL"
        autoFocus={!r.url}
        placeholder="/api/todos, a full URL, or paste a curl command"
        className="flex-1"
        onChange={(url) => edit((x) => ({ ...x, url, params: paramsFromUrl(url, x.params) }))}
        onPaste={(text) => {
          if (!looksLikeCurl(text)) return false;
          void api()
            .apiImport("curl", text)
            .then((a) => {
              if (!("method" in a)) return;
              const c = fromApi(a);
              edit((x) => ({ ...c, id: x.id, path: x.path, name: x.name === "New request" ? c.name : x.name }));
              toast("Made a request from the curl command", "ok");
            })
            .catch((e: unknown) => toast(`That curl command didn't read: ${errorMessage(e)}`, "error"));
          return true;
        }}
      />
      <button type="button" className="ap-icon" aria-label="Show as code" title="Show as code: cURL, fetch, Python" onClick={() => useApi.setState({ dialog: "code" })}>
        <Code2 size={14} />
      </button>
      <button type="button" className="ap-icon" aria-label={keys("Save (⌘S)")} title={keys("Save (⌘S)")} disabled={!dirty && !!tab.draft.path} onClick={() => useApi.getState().save(tab.id)}>
        <Save size={13} />
      </button>
      {sending ? (
        <button type="button" className="btn ap-send" onClick={() => useApi.getState().cancel(tab.id)}>
          <Spinner size={11} />
          Cancel
        </button>
      ) : (
        <button type="submit" className="btn go ap-send" disabled={!r.url.trim()} title={keys("Send (⌘↵)")}>
          <Send size={11} />
          Send
        </button>
      )}
    </form>
  );
}

function AuthFields({ auth, onChange, scope, allowInherit }: { auth: Auth; onChange(a: Auth): void; scope: Scope; allowInherit: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <select className="field w-[260px]" value={auth.type} aria-label="Auth type" onChange={(e) => onChange({ ...auth, type: e.target.value as Auth["type"] })}>
        {(Object.keys(AUTH_LABEL) as Auth["type"][]).filter((t) => allowInherit || t !== "inherit").map((t) => (
          <option key={t} value={t}>
            {AUTH_LABEL[t]}
          </option>
        ))}
      </select>
      {auth.type === "bearer" && (
        <label className="ap-field">
          <span>Token</span>
          <SecretInput value={auth.token ?? ""} onChange={(token) => onChange({ ...auth, token })} scope={scope} label="Token" placeholder="{{token}}" />
        </label>
      )}
      {auth.type === "basic" && (
        <>
          <label className="ap-field">
            <span>Username</span>
            <VarInput value={auth.username ?? ""} onChange={(username) => onChange({ ...auth, username })} scope={scope} aria-label="Username" className="flex-1" />
          </label>
          <label className="ap-field">
            <span>Password</span>
            <SecretInput value={auth.password ?? ""} onChange={(password) => onChange({ ...auth, password })} scope={scope} label="Password" />
          </label>
        </>
      )}
      {auth.type === "apikey" && (
        <>
          <label className="ap-field">
            <span>Key</span>
            <VarInput value={auth.key ?? ""} onChange={(key) => onChange({ ...auth, key })} scope={scope} aria-label="Key name" placeholder="X-Api-Key" className="flex-1" />
          </label>
          <label className="ap-field">
            <span>Value</span>
            <SecretInput value={auth.value ?? ""} onChange={(value) => onChange({ ...auth, value })} scope={scope} label="Key value" />
          </label>
          <label className="ap-field">
            <span>Send in</span>
            <select className="field" value={auth.placement ?? "header"} aria-label="Send the key in" onChange={(e) => onChange({ ...auth, placement: e.target.value as "header" | "query" })}>
              <option value="header">a header</option>
              <option value="query">the query string</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/** AP23: what the JSON body gets wrong against the route's schema, in plain words. Never blocks Send. */
function useBodyCheck(r: Req): string[] {
  const schema = useApi((s) => (hasBody(r.method) && r.body.mode === "json" ? docFor(s.routes?.routes, r.method, r.url)?.body?.schema : undefined));
  return useMemo(() => {
    if (!schema || !r.body.text.trim()) return [];
    try {
      return checkBody(schema, JSON.parse(r.body.text.replace(/\{\{[^{}]+\}\}/g, "0")));
    } catch {
      return [];
    }
  }, [schema, r.body.text]);
}

function BodyPanel({ r, edit, scope }: { r: Req; edit(fn: (r: Req) => Req): void; scope: Scope }) {
  const b = r.body;
  const warnings = useBodyCheck(r);
  const setBody = (patch: Partial<Req["body"]>) => edit((x) => ({ ...x, body: { ...x.body, ...patch } }));
  const jsonError = useMemo(() => {
    if (b.mode !== "json" || !b.text.trim()) return null;
    try {
      JSON.parse(b.text.replace(/\{\{[^{}]+\}\}/g, "0"));
      return null;
    } catch (e) {
      return (e as Error).message.replace(/^JSON\.parse: /, "");
    }
  }, [b.mode, b.text]);
  if (!hasBody(r.method)) return <p className="ap-hint">{r.method} requests don't send a body.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <select className="field" value={b.mode} aria-label="Body type" onChange={(e) => setBody({ mode: e.target.value as BodyMode })}>
          {BODY_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {b.mode === "json" && (
          <>
            <button
              type="button"
              className="hud-btn"
              disabled={!!jsonError || !b.text.trim()}
              onClick={() => {
                try {
                  setBody({ text: JSON.stringify(JSON.parse(b.text), null, 2) });
                } catch {
                  toast("Format works once {{vars}} are inside quotes", "info");
                }
              }}
            >
              Format
            </button>
            <span className={cx("ml-auto truncate text-[11px]", jsonError ? "text-fail" : "text-faint")} role="status">
              {b.text.trim() ? (jsonError ? `Not valid JSON: ${jsonError}` : "Valid JSON") : ""}
            </span>
          </>
        )}
      </div>
      {(b.mode === "json" || b.mode === "text" || b.mode === "xml") && (
        <CodeArea value={b.text} onChange={(text) => setBody({ text })} lang={b.mode === "json" ? "json" : "text"} label="Body" placeholder={b.mode === "json" ? '{ "title": "buy milk" }' : ""} className="min-h-[120px] flex-1" />
      )}
      {warnings.length > 0 && (
        <ul className="ap-check" aria-label="Doesn't match the API's schema">
          {warnings.slice(0, 4).map((w) => (
            <li key={w}>
              <TriangleAlert size={11} aria-hidden />
              {w}
            </li>
          ))}
          {warnings.length > 4 && <li className="more">and {warnings.length - 4} more</li>}
        </ul>
      )}
      {b.mode === "form" && <KvTable rows={b.form} onChange={(form) => setBody({ form })} scope={scope} label="Form fields" />}
      {b.mode === "multipart" && (
        <KvTable
          rows={b.form}
          onChange={(form) => setBody({ form })}
          scope={scope}
          label="Form fields"
          valueCell={(row, set) =>
            row.file !== undefined ? (
              <span className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11.5px] text-ink">
                <span className="truncate" title={row.file}>{row.file ? row.file.split(/[\\/]/).pop() : "No file picked"}</span>
                <button type="button" className="ap-link" onClick={() => set({ file: undefined })}>
                  Use text
                </button>
              </span>
            ) : (
              <VarInput value={row.value} onChange={(value) => set({ value })} scope={scope} aria-label={`Value of ${row.name || "field"}`} placeholder="Value" className="flex-1" />
            )
          }
          extra={(row) => (
            <button
              type="button"
              className="ap-link"
              title="Send a file in this field"
              onClick={() =>
                void api()
                  .apiPickFile()
                  .then((f) => f && setBody({ form: b.form.map((x) => (x.id === row.id ? { ...x, file: f, value: "" } : x)) }))
              }
            >
              File
            </button>
          )}
        />
      )}
      {b.mode === "graphql" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex min-h-[120px] min-w-0 flex-[3] flex-col gap-1">
            <span className="text-[11px] font-medium text-faint">Query</span>
            <CodeArea value={b.text} onChange={(text) => setBody({ text })} label="GraphQL query" placeholder="query { todos { id title } }" className="flex-1" />
          </div>
          <div className="flex min-h-[90px] min-w-0 flex-[2] flex-col gap-1">
            <span className="text-[11px] font-medium text-faint">Variables (JSON)</span>
            <CodeArea value={b.gqlVars} onChange={(gqlVars) => setBody({ gqlVars })} lang="json" label="GraphQL variables" placeholder='{ "id": 1 }' className="flex-1" />
          </div>
        </div>
      )}
      {b.mode === "none" && <p className="ap-hint">This request sends no body. Pick JSON, a form or GraphQL above to add one.</p>}
    </div>
  );
}

/** "[redacted:token]" in a captured header: one click puts {{token}} there instead. */
function RedactedFill({ r, edit }: { r: Req; edit(fn: (r: Req) => Req): void }) {
  const hidden: { label: string; v: string; fix(): void }[] = [
    ...r.headers.filter((h) => isRedacted(h.value)).map((h) => ({ label: h.name, v: redactedVar(h.value), fix: () => edit((x) => ({ ...x, headers: x.headers.map((y) => (y.id === h.id ? { ...y, value: y.value.replace(/\[redacted(:[\w-]+)?\]/g, `{{${redactedVar(y.value)}}}`) } : y)) })) })),
    ...(isRedacted(r.auth.token) ? [{ label: "Bearer token", v: redactedVar(r.auth.token!), fix: () => edit((x) => ({ ...x, auth: { ...x.auth, token: `{{${redactedVar(x.auth.token!)}}}` } })) }] : []),
  ];
  if (!hidden.length) return null;
  return (
    <div className="ap-note" role="note">
      Shrike hid {hidden.map((h) => h.label).join(", ")}, so the real value isn't stored. Type it, or:
      {hidden.map((h) => (
        <button key={h.label} type="button" className="ap-link" onClick={h.fix}>
          Use {`{{${h.v}}}`}
        </button>
      ))}
    </div>
  );
}

export function RequestTabs({ tab }: { tab: Tab }) {
  const [which, setWhich] = useState<ReqTab>(() => (hasBody(tab.draft.method) && tab.draft.body.mode !== "none" ? "body" : "params"));
  const result = useApi((s) => s.results[tab.id]);
  const runtime = useApi((s) => s.runtime[colFor(s, tab.id)?.id ?? ""] ?? NONE);
  const inherited = useApi((s) => colFor(s, tab.id));
  const r = tab.draft;
  const scope = scopeFor(r);
  const edit = (fn: (r: Req) => Req) => useApi.getState().edit(tab.id, fn);
  const paths = pathParams(r.url);
  const on = (rows: Row[]) => rows.filter((x) => x.on && x.name).length;
  const tabs: { id: ReqTab; label: string; n?: number; dot?: boolean }[] = [
    { id: "params", label: "Params", n: on(r.params) + paths.length },
    { id: "body", label: "Body", dot: hasBody(r.method) && r.body.mode !== "none" },
    { id: "headers", label: "Headers", n: on(r.headers) },
    { id: "auth", label: "Auth", dot: r.auth.type !== "inherit" && r.auth.type !== "none" },
    { id: "vars", label: "Vars", n: on(r.vars) + r.post.filter((p) => p.on).length },
    { id: "script", label: "Script", dot: !!(r.scripts.pre || r.scripts.post || r.scripts.tests) },
    { id: "assert", label: "Assert", n: r.asserts.filter((a) => a.on).length },
    { id: "docs", label: "Docs", dot: !!r.docs.trim() },
  ];
  const [docEdit, setDocEdit] = useState(!r.docs);
  const wantsBody = hasBody(r.method);
  useEffect(() => {
    if (wantsBody && which === "params" && !r.params.length) setWhich("body"); // switching to POST: the body is what you'll edit next
  }, [wantsBody]);
  const failed = result?.assertions.filter((a) => !a.ok).length ?? 0;
  const bodyOff = useBodyCheck(r).length > 0;

  return (
    <div className="ap-req">
      <div className="ap-subtabs">
        <div role="tablist" aria-label="Request parts" className="contents">
        {tabs.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={which === t.id} className={cx("ap-subtab", which === t.id && "on")} onClick={() => setWhich(t.id)}>
            {t.label}
            {!!t.n && <sup className={cx(t.id === "assert" && result?.assertions.length ? (failed ? "text-fail" : "text-ok") : undefined)}>{t.n}</sup>}
            {!t.n && t.dot && <i className={cx("ap-dot", t.id === "body" && bodyOff && "warn")} aria-hidden />}
          </button>
        ))}
        </div>
      </div>
      <div role="tabpanel" className="ap-panel">
        <RedactedFill r={r} edit={edit} />
        {which === "params" && (
          <>
            <KvTable rows={r.params} scope={scope} label="Query" onChange={(params) => edit((x) => ({ ...x, params, url: urlWithParams(x.url, params) }))} />
            {paths.length > 0 && (
              <section className="ap-kv" aria-label="Path">
                <header>
                  <span className="text-[11px] font-medium text-faint">Path</span>
                </header>
                {paths.map((k) => (
                  <div key={k} className="ap-kv-row">
                    <span className="ap-cell name font-mono text-dim">:{k}</span>
                    <VarInput value={r.pathVals[k] ?? ""} onChange={(v) => edit((x) => ({ ...x, pathVals: { ...x.pathVals, [k]: v } }))} scope={scope} aria-label={`Value of ${k}`} placeholder="value" className="flex-1" />
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {which === "body" && <BodyPanel r={r} edit={edit} scope={scope} />}
        {which === "headers" && <KvTable rows={r.headers} scope={scope} label="Headers" suggest={HEADER_NAMES} onChange={(headers) => edit((x) => ({ ...x, headers }))} />}
        {which === "auth" && (
          <div className="flex flex-col gap-3">
            <AuthFields auth={r.auth} onChange={(auth) => edit((x) => ({ ...x, auth }))} scope={scope} allowInherit />
            {r.auth.type === "inherit" && (
              <p className="ap-box text-[12px] text-dim">
                {inherited ? (
                  <>
                    Uses {inherited.name}'s auth: <span className="text-ink">{AUTH_LABEL[inherited.defaults.auth.type]}</span>
                    {inherited.defaults.auth.type === "bearer" && <code className="ml-1 font-mono text-violet">{inherited.defaults.auth.token.includes("{{") ? inherited.defaults.auth.token : "(a token)"}</code>}. Folders can set their own in Bruno.
                  </>
                ) : (
                  "Not saved in a collection yet, so nothing to inherit: this request sends no auth."
                )}
              </p>
            )}
          </div>
        )}
        {which === "vars" && (
          <>
            <KvTable rows={r.vars} scope={scope} label="Before the request" onChange={(vars) => edit((x) => ({ ...x, vars }))} />
            <section className="ap-kv" aria-label="From the response">
              <header>
                <span className="text-[11px] font-medium text-faint">Saved from the response</span>
              </header>
              {r.post.map((p) => (
                <div key={p.id} className={cx("ap-kv-row", !p.on && "off")}>
                  <input type="checkbox" checked={p.on} aria-label={`Use ${p.name || "this row"}`} onChange={(e) => edit((x) => ({ ...x, post: x.post.map((y) => (y.id === p.id ? { ...y, on: e.target.checked } : y)) }))} />
                  <input className="ap-cell name" value={p.name} placeholder="token" aria-label="Var name" spellCheck={false} onChange={(e) => edit((x) => ({ ...x, post: x.post.map((y) => (y.id === p.id ? { ...y, name: e.target.value } : y)) }))} />
                  <input className="ap-cell flex-1 font-mono" value={p.selector} placeholder="res.body.token" aria-label="Where in the response" spellCheck={false} onChange={(e) => edit((x) => ({ ...x, post: x.post.map((y) => (y.id === p.id ? { ...y, selector: e.target.value } : y)) }))} />
                  {result && p.name in result.setVars && <span className="ap-chip pass">Saved</span>}
                  <button type="button" className="ap-x" aria-label={`Remove ${p.name || "row"}`} onClick={() => edit((x) => ({ ...x, post: x.post.filter((y) => y.id !== p.id) }))}>
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button type="button" className="ap-kv-add" onClick={() => edit((x) => ({ ...x, post: [...x.post, { id: uid(), name: "", selector: "res.body.", on: true }] }))}>
                + Add
              </button>
            </section>
            {Object.keys(runtime).length > 0 && (
              <section className="ap-kv" aria-label="Saved this session">
                <header>
                  <span className="text-[11px] font-medium text-faint">Saved from responses, until Shrike restarts</span>
                </header>
                {Object.entries(runtime).map(([k, v]) => (
                  <div key={k} className="ap-kv-row font-mono text-[11.5px]">
                    <span className="ap-cell name text-ink">{k}</span>
                    <span className="truncate text-dim" title={v}>
                      {v}
                    </span>
                  </div>
                ))}
              </section>
            )}
            <p className="ap-hint">
              Use them anywhere as <code>{"{{name}}"}</code>. Built in: {BUILTINS.map((b) => `{{${b}}}`).join(", ")}.
            </p>
          </>
        )}
        {which === "script" && (
          <>
            <span className="ap-chip kept">Runs in a locked sandbox: no files, no network, 2 seconds. Vars and Assert cover most needs without code.</span>
            {(["pre", "post", "tests"] as const).map((k) => (
              <div key={k} className="flex min-h-[96px] flex-col gap-1">
                <span className="text-[11px] font-medium text-faint">{k === "pre" ? "Before the request" : k === "post" ? "After the response" : "Tests"}</span>
                <CodeArea value={r.scripts[k] ?? ""} onChange={(v) => edit((x) => ({ ...x, scripts: { ...x.scripts, [k]: v || undefined } }))} label={`Script ${k}`} placeholder={k === "pre" ? "req.setHeader('x-id', bru.getVar('id'))" : k === "post" ? "bru.setVar('token', res.body.token)" : "test('is ok', () => expect(res.status).to.equal(200))"} className="flex-1" />
              </div>
            ))}
            {result && (result.logs.length > 0 || result.scriptError) && (
              <CodeArea value={[...result.logs, ...(result.scriptError ? [`Error: ${result.scriptError}`] : [])].join("\n")} readOnly label="Script output" className="min-h-[60px]" />
            )}
          </>
        )}
        {which === "assert" && (
          <section className="ap-kv" aria-label="Checks">
            <header>
              <span className="text-[11px] font-medium text-faint">Checks after each send</span>
            </header>
            {r.asserts.map((a) => {
              const res = a.on ? result?.assertions.find((x) => x.expr === a.expr && x.op === a.op && x.value === a.value) : undefined;
              const set = (p: Partial<typeof a>) => edit((x) => ({ ...x, asserts: x.asserts.map((y) => (y.id === a.id ? { ...y, ...p } : y)) }));
              return (
                <div key={a.id} className={cx("ap-kv-row", !a.on && "off")}>
                  <input type="checkbox" checked={a.on} aria-label={`Use the check on ${a.expr}`} onChange={(e) => set({ on: e.target.checked })} />
                  <input className="ap-cell name font-mono" value={a.expr} placeholder="res.status" aria-label="What to check" spellCheck={false} onChange={(e) => set({ expr: e.target.value })} />
                  <select className="ap-op" value={a.op} aria-label="Operator" onChange={(e) => set({ op: e.target.value })}>
                    {OPERATORS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  <input className="ap-cell flex-1 font-mono" value={a.value} disabled={UNARY.has(a.op)} placeholder={UNARY.has(a.op) ? "" : "200"} aria-label="Expected" spellCheck={false} onChange={(e) => set({ value: e.target.value })} />
                  {res && (
                    <span className={cx("ap-chip", res.ok ? "pass" : "fail")} title={res.error ?? `Got ${res.actual ?? "nothing"}`}>
                      {res.ok ? "PASS" : "FAIL"}
                    </span>
                  )}
                  <button type="button" className="ap-x" aria-label={`Remove the check on ${a.expr}`} onClick={() => edit((x) => ({ ...x, asserts: x.asserts.filter((y) => y.id !== a.id) }))}>
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <button type="button" className="ap-kv-add" onClick={() => edit((x) => ({ ...x, asserts: [...x.asserts, { id: uid(), expr: x.asserts.length ? "res.body." : "res.status", op: "eq", value: x.asserts.length ? "" : "200", on: true }] }))}>
              + Add a check
            </button>
          </section>
        )}
        {which === "docs" && (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-1">
              <button type="button" className="hud-btn" aria-pressed={docEdit} onClick={() => setDocEdit(true)}>
                Write
              </button>
              <button type="button" className="hud-btn" aria-pressed={!docEdit} onClick={() => setDocEdit(false)}>
                Preview
              </button>
            </div>
            {docEdit ? (
              <textarea className="ap-bulk min-h-[140px] flex-1" value={r.docs} aria-label="Docs" placeholder="Notes for this request, in Markdown" onChange={(e) => edit((x) => ({ ...x, docs: e.target.value }))} />
            ) : r.docs.trim() ? (
              <div className="ap-docs">
                <Markdown text={r.docs} path="request-docs.md" />
              </div>
            ) : (
              <p className="ap-hint">No notes yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

