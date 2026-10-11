import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useActions } from "../stores/actions.ts";
import { toast, useUi } from "../stores/ui.ts";
import { CODE_FG, highlight, type Token } from "../lib/highlight.ts";
import { inlineChips, stationEvents } from "../thread/logic.ts";
import { openInEditor } from "./commands.ts";
import { VARS } from "../thread/Thread.tsx";
import { IMAGE_EXT, isMarkdown } from "./logic.ts";
import { Markdown } from "../components/Markdown.tsx";
import { useMemoryFor } from "../stores/agent.ts";
import { keys } from "../lib/platform.ts";

// The in-app file view: the whole file with the step's line lit and the trip's values inline. Edit + ⌘S saves.
// Markdown renders as formatted text and images as images (O13); Edit shows Markdown's source.

export function FileView() {
  const file = useUi((s) => s.file);
  const close = useUi((s) => s.closeFile);
  const view = useActions((s) => (file?.actionId ? s.byId[file.actionId] : undefined));
  const [text, setText] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Token[][] | undefined>();
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null); // non-null while editing
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const path = file?.path;
  const notes = useMemoryFor(path); // A5: pinned notes in the gutter
  const kind = !path ? "code" : IMAGE_EXT.test(path) ? "image" : isMarkdown(path) ? "md" : "code";

  useEffect(() => {
    if (!path) return;
    let live = true;
    setText(null); setTokens(undefined); setFailed(false); setDraft(null); setConfirm(false); setImage(null);
    if (IMAGE_EXT.test(path)) {
      window.shrike.readFileDataUrl(path).then((u) => live && setImage(u)).catch(() => live && setFailed(true));
      return () => { live = false; };
    }
    window.shrike
      .readFile(path)
      .then((t) => {
        if (!live) return;
        const clean = t.replace(/\r\n?/g, "\n");
        setText(clean);
        return highlight(path, clean).then((tk) => live && setTokens(tk));
      })
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [path]);

  const lines = useMemo(() => (text ?? "").replace(/\t/g, "  ").split("\n"), [text]);
  const chips = useMemo(() => {
    if (!file || !view || file.stepIndex === undefined || text === null) return null;
    const { event, events } = stationEvents(view, file.stepIndex);
    return event ? inlineChips(events, event, file.path, 1, lines.length) : null;
  }, [file, view, text, lines.length]);

  // Land on the step's line, a third of the way down.
  useLayoutEffect(() => {
    if (draft !== null || text === null || !file) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-ln="${file.line}"]`);
    if (el && body.current) body.current.scrollTop = el.offsetTop - body.current.clientHeight / 3;
  }, [text, file, draft]);

  const dirty = draft !== null && draft !== text;

  const save = async () => {
    if (!file || draft === null || saving) return;
    setSaving(true);
    try {
      await window.shrike.writeFile(file.path, draft);
      setText(draft);
      setTokens(await highlight(file.path, draft).catch(() => undefined));
      setDraft(null);
      setConfirm(false);
      toast(`Saved ${file.path}. Your app reloads on its own.`, "ok");
    } catch (e) {
      toast(`Couldn't save ${file.path}: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = () => {
    if (text === null) return;
    const top = body.current?.scrollTop ?? 0;
    setDraft(text);
    requestAnimationFrame(() => {
      const a = area.current;
      if (!a || !file) return;
      a.focus();
      const at = lines.slice(0, file.line - 1).reduce((n, l) => n + l.length + 1, 0);
      a.setSelectionRange(at, at);
      a.scrollTop = top;
    });
  };

  const leave = () => {
    if (dirty) return setConfirm(true);
    if (draft !== null) return setDraft(null);
    close();
  };

  // Own the keys while open, so Esc/E/⌘S never reach the Thread underneath.
  const leaveRef = useRef(leave);
  const saveRef = useRef(save);
  const editRef = useRef(startEdit);
  leaveRef.current = leave; saveRef.current = save; editRef.current = startEdit;
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (useUi.getState().quickOpen) return; // ⌘P over the file view owns its own keys
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopImmediatePropagation(); void saveRef.current(); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); leaveRef.current(); return; }
      const typing = e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName);
      if (typing) return;
      if (e.key === "e" && !e.metaKey && !e.ctrlKey && !IMAGE_EXT.test(path)) { e.preventDefault(); e.stopImmediatePropagation(); editRef.current(); return; }
      if (!(e.metaKey || e.ctrlKey)) e.stopImmediatePropagation(); // ponytail: Thread keys pause while a file is open
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [path]);

  if (!file) return null;
  const editing = draft !== null;

  return (
    <div className="fv" style={VARS} role="dialog" aria-label={`File ${file.path}`}>
      <div className="fv-head">
        <i className="dot" /><i className="dot" /><i className="dot" />
        <span
          className="f cursor-grab"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-shrike-file", JSON.stringify({ path: file.path, line: kind === "code" ? file.line : undefined }));
            e.dataTransfer.setData("text/plain", file.path);
            e.dataTransfer.effectAllowed = "copy";
          }}
          title={`${file.path}. Drag onto Ask to give this file to the agent`}
        >
          {file.path}
        </span>
        {kind === "code" && <span className="lbl">:{file.line}</span>}
        {dirty && <span className="lbl fv-dirty">Unsaved</span>}
        <span className="flex-1" />
        {editing ? (
          <>
            <button type="button" className="fv-btn on" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "Saving…" : keys("Save ⌘S")}</button>
            <button type="button" className="fv-btn" onClick={leave}>Done</button>
          </>
        ) : kind !== "image" && (
          <button type="button" className="fv-btn" onClick={startEdit} disabled={text === null}>{kind === "md" ? "Edit source" : "Edit"} <kbd>E</kbd></button>
        )}
        <button type="button" className="fv-link" onClick={() => void openInEditor(file.path, file.line)} title="Open this file in your own editor">Open in your editor ↗</button>
        <button type="button" className="fv-btn" onClick={leave}>Esc back</button>
      </div>

      {confirm && (
        <div className="fv-confirm" role="alert">
          <span>You have unsaved changes.</span>
          <button type="button" className="fv-btn on" onClick={() => void save().then(() => close())}>Save and close</button>
          <button type="button" className="fv-btn" onClick={() => { setDraft(null); setConfirm(false); close(); }}>Discard</button>
          <button type="button" className="fv-btn" onClick={() => setConfirm(false)}>Keep editing</button>
        </div>
      )}

      {failed ? (
        <div className="fv-none">Couldn't read {file.path}.</div>
      ) : kind === "image" ? (
        image ? (
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-8" style={{ backgroundImage: "repeating-conic-gradient(rgba(255,255,255,.035) 0 25%, transparent 0 50%)", backgroundSize: "16px 16px" }}>
            <img src={image} alt={file.path} className="max-h-full max-w-full rounded-[6px] shadow-[0_20px_60px_-20px_var(--void)]" />
          </div>
        ) : (
          <div className="fv-none">Opening {file.path}…</div>
        )
      ) : text === null ? (
        <div className="fv-none">Opening {file.path}…</div>
      ) : editing ? (
        <textarea
          ref={area}
          className="fv-edit"
          value={draft}
          spellCheck={false}
          aria-label={`Edit ${file.path}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const a = e.currentTarget;
              const { selectionStart: s, selectionEnd: en } = a;
              setDraft(a.value.slice(0, s) + "  " + a.value.slice(en));
              requestAnimationFrame(() => a.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
      ) : kind === "md" ? (
        <div ref={body} className="fv-body"><Markdown text={text} path={file.path} /></div>
      ) : (
        <div ref={body} className="fv-body" onDoubleClick={startEdit}>
          <pre>
            {lines.map((ln, i) => {
              const n = i + 1;
              const live = n === file.line;
              const toks = tokens?.[i];
              const c = chips?.get(n);
              const pinned = notes.filter((x) => x.line === n);
              return (
                <div key={n} data-ln={n} className={`th-ln${live ? " live" : ""}${live && file.error ? " error" : ""}`}>
                  <i>{n}</i>
                  <span>{toks ? toks.map((t, k) => <span key={k} style={{ color: t.color }}>{t.content}</span>) : <span style={{ color: CODE_FG }}>{ln}</span>}</span>
                  {c && (
                    <span className="inl">
                      {c.map((x) => <span key={x.text} className={`th-chip${x.error ? " error" : ""}`}>{x.text}</span>)}
                    </span>
                  )}
                  {live && file.note && (
                    <span className="inl">
                      <span className="th-chip fv-note" title={file.note}>{file.note.length > 120 ? `${file.note.slice(0, 119)}…` : file.note}</span>
                    </span>
                  )}
                  {pinned.length > 0 && (
                    <span className="inl">
                      {pinned.map((x) => <span key={x.id} className="th-chip fv-note" title={`Note by ${x.by}`}>{x.text}</span>)}
                    </span>
                  )}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
