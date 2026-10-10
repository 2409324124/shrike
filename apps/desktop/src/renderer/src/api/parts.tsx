import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import { CODE_FG, highlight, type Token } from "../lib/highlight.ts";
import { cx } from "../components/ui.tsx";
import { bulkParse, bulkText, isKnown, looksSecret, row, segments, varValue, type Row, type Scope } from "./model.ts";

// AP-url, AP-kv, AP-secret: the fields the client is built from.

const varTitle = (text: string, scope: Scope, here?: string) => {
  const names = [...new Set(segments(text).flatMap((s) => (s.name ? [s.name] : [])))];
  if (names.length) return names.map((n) => `{{${n}}} = ${varValue(n, scope) ?? "not set in this environment"}`).join("\n");
  return here && text.startsWith("/") ? `Goes to your app at ${here.replace(/^https?:\/\//, "")}` : undefined;
};

/** One-line field where {{vars}} light up (violet, unknown ones red) and hover shows their values. */
export function VarInput({ value, onChange, scope, here, className, mask, onPaste, ...inputProps }: {
  value: string;
  onChange(v: string): void;
  scope: Scope;
  here?: string;
  className?: string;
  mask?: boolean;
  onPaste?(text: string): boolean; // true: handled
  placeholder?: string;
  autoFocus?: boolean;
  "aria-label": string;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLInputElement>(null);
  const sync = () => {
    if (mirror.current && ref.current) mirror.current.scrollLeft = ref.current.scrollLeft;
  };
  useEffect(sync, [value]);
  const vars = !mask && value.includes("{{");
  return (
    <div className={cx("ap-var", className)} title={varTitle(value, scope, here)}>
      {vars && (
        <div ref={mirror} className="ap-var-mirror" aria-hidden>
          {segments(value).map((s, i) => (s.name ? <span key={i} className={isKnown(s.name, scope) ? "v" : "v miss"}>{s.text}</span> : <span key={i}>{s.text}</span>))}
        </div>
      )}
      <input
        ref={ref}
        {...inputProps}
        type={mask ? "password" : "text"}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className={cx("ap-var-input", vars && "see-through")}
        onChange={(e) => onChange(e.target.value)}
        onScroll={sync}
        onKeyUp={sync}
        onPaste={(e) => {
          if (onPaste?.(e.clipboardData.getData("text"))) e.preventDefault();
        }}
      />
    </div>
  );
}

/** AP-secret: masked until the eye is pressed. */
export function SecretInput(p: { value: string; onChange(v: string): void; scope: Scope; label: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-center">
      <VarInput value={p.value} onChange={p.onChange} scope={p.scope} mask={!show} aria-label={p.label} placeholder={p.placeholder} className="flex-1" />
      <button type="button" className="ap-eye" aria-label={show ? `Hide ${p.label}` : `Show ${p.label}`} title={show ? "Hide" : "Show"} aria-pressed={show} onClick={() => setShow(!show)}>
        {show ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
    </div>
  );
}

/** AP-kv: on/off, name, value, remove; a ghost row adds; Bulk Edit swaps in "name: value" lines. */
export function KvTable({ rows, onChange, scope, label, suggest, extra, valueCell, bulk = true, namePlaceholder = "Name", valuePlaceholder = "Value" }: {
  rows: Row[];
  onChange(rows: Row[]): void;
  scope: Scope;
  label: string;
  suggest?: string[];
  extra?(r: Row): ReactNode;
  valueCell?(r: Row, set: (patch: Partial<Row>) => void): ReactNode;
  bulk?: boolean;
  namePlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [bulkOn, setBulkOn] = useState(false);
  const [text, setText] = useState("");
  const listId = useRef(`ap-dl-${Math.random().toString(36).slice(2)}`).current;
  const set = (id: string, patch: Partial<Row>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <section className="ap-kv" aria-label={label}>
      <header>
        <span className="micro text-faint">{label}</span>
        {bulk && (
          <button
            type="button"
            className="ap-link"
            onClick={() => {
              if (bulkOn) onChange(bulkParse(text, rows));
              else setText(bulkText(rows));
              setBulkOn(!bulkOn);
            }}
          >
            {bulkOn ? "Key and value" : "Bulk edit"}
          </button>
        )}
      </header>
      {bulkOn ? (
        <textarea
          className="ap-bulk"
          value={text}
          spellCheck={false}
          aria-label={`${label}, one per line`}
          placeholder={"name: value\n// switched off: value"}
          onChange={(e) => {
            setText(e.target.value);
            onChange(bulkParse(e.target.value, rows));
          }}
        />
      ) : (
        <div role="table" aria-label={label}>
          {rows.map((r) => (
            <div key={r.id} role="row" className={cx("ap-kv-row", !r.on && "off")}>
              <input type="checkbox" checked={r.on} onChange={(e) => set(r.id, { on: e.target.checked })} aria-label={`Use ${r.name || "this row"}`} />
              <input className="ap-cell name" value={r.name} list={suggest ? listId : undefined} placeholder={namePlaceholder} spellCheck={false} aria-label="Name" onChange={(e) => set(r.id, { name: e.target.value })} />
              {valueCell ? valueCell(r, (p) => set(r.id, p)) : looksSecret(r.name) || r.secret ? (
                <SecretInput value={r.value} onChange={(value) => set(r.id, { value })} scope={scope} label={`Value of ${r.name}`} />
              ) : (
                <VarInput value={r.value} onChange={(value) => set(r.id, { value })} scope={scope} placeholder={valuePlaceholder} aria-label={`Value of ${r.name || "row"}`} className="flex-1" />
              )}
              {extra?.(r)}
              <button type="button" className="ap-x" aria-label={`Remove ${r.name || "row"}`} onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
                <X size={11} />
              </button>
            </div>
          ))}
          <button type="button" className="ap-kv-add" onClick={() => onChange([...rows, row()])}>
            + Add
          </button>
        </div>
      )}
      {suggest && (
        <datalist id={listId}>
          {suggest.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </section>
  );
}

/** Multi-line code field: a transparent textarea over shiki tokens (the repo's highlighter). */
export function CodeArea({ value, onChange, lang, label, placeholder, readOnly, className }: { value: string; onChange?(v: string): void; lang?: "json" | "text"; label: string; placeholder?: string; readOnly?: boolean; className?: string }) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (lang !== "json" || value.length > 200_000) return setTokens(null);
    let live = true;
    void highlight(`ap-body-${label}.json`, value).then((t) => live && setTokens(t));
    return () => {
      live = false;
    };
  }, [value, lang, label]);
  const sync = () => {
    if (pre.current && area.current) {
      pre.current.scrollTop = area.current.scrollTop;
      pre.current.scrollLeft = area.current.scrollLeft;
    }
  };
  return (
    <div className={cx("ap-code", className)}>
      {tokens && (
        <pre ref={pre} aria-hidden>
          {tokens.map((l, i) => (
            <div key={i}>{l.length ? l.map((t, k) => <span key={k} style={{ color: t.color }}>{t.content}</span>) : " "}</div>
          ))}
          {"\n"}
        </pre>
      )}
      <textarea
        ref={area}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        className={tokens ? "see-through" : undefined}
        style={tokens ? undefined : { color: CODE_FG }}
        onScroll={sync}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}
