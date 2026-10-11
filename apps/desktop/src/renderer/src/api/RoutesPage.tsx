import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Play, RefreshCw, Search, Sparkles } from "lucide-react";
import type { RouteDoc, RouteGuess, RouteParam } from "@shrike/schema";
import { MethodTag, Spinner, cx } from "../components/ui.tsx";
import { useActions } from "../stores/actions.ts";
import { useRun } from "../stores/run.ts";
import { useUi } from "../stores/ui.ts";
import { appAddress, capturedCalls, tryRoute, useApi } from "./store.ts";
import { groupRoutes, schemaRows, seenIn, testFromDoc, type SchemaRow } from "./routes.ts";

// AP20 to AP22: the Routes page. A Swagger-like reference built from the OpenAPI spec when there is one, the code scan
// otherwise, and guesses the user accepted. Try it opens the request editor; nothing here ever sends.

const keyOf = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
const tone = (status: string) => (/^2/.test(status) ? "ok" : /^[45]/.test(status) ? (/^5/.test(status) ? "fail" : "slow") : "");

function Chips({ doc, seen }: { doc: RouteDoc; seen: boolean }) {
  return (
    <div className="ap-srcs">
      {doc.sources.includes("spec") && <span className="ap-src spec">OpenAPI</span>}
      {doc.sources.includes("code") && <span className="ap-src code">In your code</span>}
      {seen && <span className="ap-src calls">Seen in calls</span>}
      {doc.sources.includes("guess") && <span className="ap-src guess">Guessed from code</span>}
    </div>
  );
}

function Rows({ rows }: { rows: SchemaRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="ap-schema" role="list">
      {rows.map((r, i) => (
        <div key={`${r.depth}-${r.name}-${i}`} role="listitem" className={cx("ap-schema-row", r.depth > 0 && "nested")} style={{ marginLeft: r.depth * 14 }}>
          <div className="ap-schema-line">
            <span className="ap-schema-name">{r.name}</span>
            {r.type && <span className="ap-schema-type">{r.type}</span>}
            {r.required && <span className="ap-req-mark">required</span>}
            {r.enum && <span className="ap-schema-enum">one of {r.enum.join(", ")}</span>}
          </div>
          {r.description && <p className="ap-schema-desc">{r.description}</p>}
        </div>
      ))}
    </div>
  );
}

const paramRows = (ps: RouteParam[]): (SchemaRow & { where: string })[] => ps.map((p) => ({ name: p.name, depth: 0, required: p.required, where: p.in, ...(p.type ? { type: p.type } : {}), ...(p.enum ? { enum: p.enum } : {}), ...(p.description ? { description: p.description } : {}) }));

function Params({ params }: { params: RouteParam[] }) {
  return (
    <div className="ap-schema" role="list">
      {paramRows(params).map((r) => (
        <div key={`${r.where}-${r.name}`} role="listitem" className="ap-schema-row">
          <div className="ap-schema-line">
            <span className="ap-schema-name">{r.name}</span>
            <span className="ap-schema-in">{r.where}</span>
            {r.type && <span className="ap-schema-type">{r.type}</span>}
            {r.required && <span className="ap-req-mark">required</span>}
            {r.enum && <span className="ap-schema-enum">one of {r.enum.join(", ")}</span>}
          </div>
          {r.description && <p className="ap-schema-desc">{r.description}</p>}
        </div>
      ))}
    </div>
  );
}

function Example({ text, label }: { text: string; label: string }) {
  return (
    <pre className="ap-example selectable" aria-label={label}>
      {text}
    </pre>
  );
}

/** The parts every route shows: params, body, responses. A guess card reuses them. */
function Reference({ doc }: { doc: Pick<RouteDoc, "params" | "body" | "responses" | "method"> }) {
  return (
    <>
      <section aria-label="Parameters">
        <h3 className="micro ap-rh">Parameters</h3>
        {doc.params.length ? <Params params={doc.params} /> : <p className="ap-rnone">None.</p>}
      </section>
      {(doc.body || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(doc.method)) && (
        <section aria-label="Request body">
          <h3 className="micro ap-rh">
            Request body{doc.body ? <span className="ap-rh-note">{doc.body.contentType}{doc.body.required ? " · required" : ""}</span> : null}
          </h3>
          {doc.body ? (
            <>
              <Rows rows={schemaRows(doc.body.schema)} />
              {doc.body.example !== undefined && <Example text={doc.body.example} label="Example body" />}
            </>
          ) : (
            <p className="ap-rnone">Not described yet.</p>
          )}
        </section>
      )}
      <section aria-label="Responses">
        <h3 className="micro ap-rh">Responses</h3>
        {doc.responses.length ? (
          doc.responses.map((r) => (
            <div key={r.status} className="ap-resp">
              <div className="ap-schema-line">
                <span className={cx("ap-pill", tone(r.status))}>{r.status}</span>
                {r.description && <span className="text-[12px] text-ink">{r.description}</span>}
              </div>
              <Rows rows={schemaRows(r.schema)} />
              {r.example !== undefined && <Example text={r.example} label={`Example ${r.status} response`} />}
            </div>
          ))
        ) : (
          <p className="ap-rnone">Not described yet.</p>
        )}
      </section>
    </>
  );
}

function RouteView({ doc, seen }: { doc: RouteDoc; seen: boolean }) {
  const calls = () => capturedCalls(useActions.getState().byId, useActions.getState().order);
  return (
    <article className="ap-rdoc" aria-label={`${doc.method} ${doc.path}`}>
      <header className="ap-rdoc-head">
        <div className="flex min-w-0 items-baseline gap-2">
          <MethodTag method={doc.method} className="w-auto! text-[12px]!" />
          <h2 className="ap-rpath selectable">{doc.path}</h2>
          {doc.deprecated && <span className="ap-src">Deprecated</span>}
        </div>
        {doc.summary && <p className="text-[13px] text-ink">{doc.summary}</p>}
        {doc.description && <p className="text-[12px] leading-relaxed text-dim">{doc.description}</p>}
        <Chips doc={doc} seen={seen} />
        <div className="ap-ractions">
          <button type="button" className="btn go ap-send" onClick={() => tryRoute(doc)}>
            <Play size={11} aria-hidden /> Try it
          </button>
          <button type="button" className="hud-btn" onClick={() => void useApi.getState().saveTest(testFromDoc(doc, calls()), doc.tag)}>
            Save as test
          </button>
          {doc.handler && (
            <button type="button" className="ap-link font-mono" title="Open the handler" onClick={() => useUi.getState().openFile({ path: doc.handler!.file, line: doc.handler!.line })}>
              {doc.handler.file}:{doc.handler.line}
            </button>
          )}
        </div>
      </header>
      <Reference doc={doc} />
    </article>
  );
}

function GuessCard({ g }: { g: RouteGuess }) {
  const doc = { method: g.method, params: g.params, responses: g.responses, ...(g.body ? { body: { contentType: "application/json", required: true, schema: g.body.schema, example: g.body.example } } : {}) };
  return (
    <article className="ap-guess glass" aria-label={`Guess for ${g.method} ${g.path}`}>
      <header className="flex flex-wrap items-center gap-2">
        <MethodTag method={g.method} className="w-auto!" />
        <span className="ap-rpath small">{g.path}</span>
        <span className="ap-src guess">Guessed from code</span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" className="hud-btn" onClick={() => useApi.getState().skipGuess(g)}>
            Skip
          </button>
          <button type="button" className="btn go ap-send" onClick={() => void useApi.getState().acceptGuess(g)}>
            Accept
          </button>
        </span>
      </header>
      {g.summary && <p className="text-[12.5px] text-ink">{g.summary}</p>}
      <Reference doc={doc} />
    </article>
  );
}

export function RoutesPage() {
  const view = useApi((s) => s.routes);
  const guessing = useApi((s) => s.guessing);
  const guesses = useApi((s) => s.guesses);
  const byId = useActions((s) => s.byId);
  const order = useActions((s) => s.order);
  const address = appAddress();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [picking, setPicking] = useState<Set<string> | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const running = useRun((s) => s.status.state === "running");
  const specless = !view?.spec;
  useEffect(() => void useApi.getState().loadRoutes(), [address, running]); // the app just came up: its spec URL may answer now
  useEffect(() => {
    if (!running || !specless) return;
    const t = setInterval(() => void useApi.getState().loadRoutes(), 10_000); // ponytail: polls while open; upgrade: ask once the process prints its first line
    return () => clearInterval(t);
  }, [running, specless]);
  const calls = useMemo(() => capturedCalls(byId, order), [byId, order]);
  const routes = view?.routes ?? [];
  const groups = groupRoutes(routes, q);
  const flat = groups.flatMap((g) => g.routes);
  const current = flat.find((r) => keyOf(r) === sel) ?? flat[0];
  const unspecced = routes.filter((r) => !r.sources.includes("spec"));

  const move = (to: RouteDoc | undefined) => {
    if (!to) return;
    setSel(keyOf(to));
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(to))}"]`)?.focus());
  };
  const onListKey = (e: KeyboardEvent) => {
    const i = current ? flat.indexOf(current) : -1;
    if (e.key === "ArrowDown") (e.preventDefault(), move(flat[Math.min(i + 1, flat.length - 1)]));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(flat[Math.max(i - 1, 0)]));
    else if (e.key === "Home") (e.preventDefault(), move(flat[0]));
    else if (e.key === "End") (e.preventDefault(), move(flat.at(-1)));
    else if (e.key === "Enter" && current && !picking) (e.preventDefault(), tryRoute(current));
    else if (e.key === " " && current && picking && !current.sources.includes("spec")) (e.preventDefault(), toggle(current));
  };
  const onPageKey = (e: KeyboardEvent) => {
    if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) (e.preventDefault(), search.current?.focus());
  };
  const toggle = (r: RouteDoc) =>
    setPicking((p) => {
      const n = new Set(p);
      if (n.has(keyOf(r))) n.delete(keyOf(r));
      else n.add(keyOf(r));
      return n;
    });
  const startPicking = () => setPicking(new Set(unspecced.filter((r) => !r.sources.includes("guess")).map(keyOf)));
  const runGuess = () => {
    const chosen = unspecced.filter((r) => picking?.has(keyOf(r)));
    setPicking(null);
    void useApi.getState().guess(chosen);
  };

  return (
    <div className="ap-routes" onKeyDown={onPageKey}>
      <nav className="ap-rlist" aria-label="Routes">
        <div className="ap-tree-head">
          <div className="ap-search">
            <Search size={11} aria-hidden />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.key === "Escape" && q ? (e.stopPropagation(), setQ("")) : e.key === "ArrowDown" ? (e.preventDefault(), move(flat[0])) : undefined)} placeholder="Search routes" aria-label="Search routes" spellCheck={false} />
          </div>
          <button type="button" className="ap-icon" aria-label="Look for routes again" title="Look for routes and a spec again" onClick={() => void useApi.getState().loadRoutes(true)}>
            <RefreshCw size={12} />
          </button>
        </div>
        <p className="ap-rfrom" title={view?.notes.join("\n")}>
          {view?.spec ? (
            <>
              From <b>{view.spec.title ?? "OpenAPI"}</b>
              {view.spec.version ? ` ${view.spec.version}` : ""} at <code>{view.spec.from.replace(/^https?:\/\//, "")}</code>
            </>
          ) : view?.notes[0] ? (
            view.notes[0]
          ) : (
            "No OpenAPI spec found, so routes come from your code."
          )}
        </p>
        {unspecced.length > 0 && (
          <div className="ap-rguess">
            {guessing ? (
              <span className="flex items-center gap-1.5 text-[11.5px] text-dim" role="status">
                <Spinner size={11} /> Your agent is reading the handlers
              </span>
            ) : picking ? (
              <>
                <button type="button" className="btn go ap-send" disabled={!picking.size} onClick={runGuess}>
                  Guess {picking.size} {picking.size === 1 ? "route" : "routes"}
                </button>
                <button type="button" className="hud-btn" onClick={() => setPicking(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="hud-btn" title="Your agent reads the handler code and suggests params, a body and responses. You check each one before it's saved." onClick={startPicking}>
                <Sparkles size={11} aria-hidden /> Fill in examples
              </button>
            )}
          </div>
        )}
        <div ref={list} className="ap-tree-body" role="listbox" aria-label="Routes by group" aria-multiselectable={!!picking} onKeyDown={onListKey}>
          {groups.map((g) => (
            <div key={g.tag} role="group" aria-label={g.tag}>
              <div className="ap-sec">
                <span className="micro">{g.tag}</span>
                <span className="ml-auto font-mono text-[10px] text-faint">{g.routes.length}</span>
              </div>
              {g.routes.map((r) => {
                const on = r === current;
                const pickable = picking && !r.sources.includes("spec");
                return (
                  <div
                    key={keyOf(r)}
                    data-key={keyOf(r)}
                    role="option"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    className={cx("ap-row ap-row-main ap-rrow", on && "on")}
                    title={r.summary ?? keyOf(r)}
                    onClick={() => (pickable ? toggle(r) : setSel(keyOf(r)))}
                    onDoubleClick={() => !picking && tryRoute(r)}
                  >
                    {pickable && <input type="checkbox" tabIndex={-1} aria-label={`Guess ${keyOf(r)}`} checked={picking.has(keyOf(r))} onChange={() => toggle(r)} onClick={(e) => e.stopPropagation()} />}
                    <MethodTag method={r.method} className="w-[38px]! text-[9.5px]!" />
                    <span className="truncate font-mono text-[11.5px]">{r.path}</span>
                    {r.sources.includes("guess") && !r.sources.includes("spec") && <i className="ap-rguess-dot" aria-label="guessed" />}
                  </div>
                );
              })}
            </div>
          ))}
          {!groups.length && <p className="ap-hint">{routes.length ? "No route matches." : view ? "No routes found yet. Shrike finds them in your code and in an OpenAPI spec." : "Looking for routes"}</p>}
        </div>
      </nav>
      <div className="ap-rmain">
        {guesses.length > 0 ? (
          <div className="ap-rdoc" aria-label="Guesses to review">
            <p className="text-[12px] text-dim">Your agent read the handlers and guessed these. Check each one: Accept saves it to the project's collection, Skip drops it.</p>
            {guesses.map((g) => (
              <GuessCard key={keyOf(g)} g={g} />
            ))}
          </div>
        ) : current ? (
          <RouteView key={keyOf(current)} doc={current} seen={seenIn(current, calls)} />
        ) : (
          <div className="ap-empty">
            <p>Routes show up here with their params, body and responses.</p>
          </div>
        )}
      </div>
    </div>
  );
}
