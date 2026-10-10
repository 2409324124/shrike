import { useMemo, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { parseInline } from "../hud/logic.ts";
import { api } from "../lib/api.ts";
import { prMarkdown, safeHref, type PrBlock } from "./markdown.ts";

// PR5: a GitHub comment as formatted text. React elements only (never innerHTML); links open in the system browser;
// images are never fetched, they show as a chip that opens them in the browser.

const open = (href: string) => void api().openLink(href).catch(() => {});

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span className="text-dim">{children}</span>;
  return (
    <button type="button" className="inline cursor-pointer text-left text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal" title={`Opens in your browser: ${safe}`} onClick={() => open(safe)}>
      {children}
    </button>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((n, i) => {
        if (n.t === "code") return <code key={i} className="rounded-[4px] bg-glass px-1 py-px font-mono text-[0.9em] text-ink">{n.text}</code>;
        if (n.t === "b") return <strong key={i} className="font-semibold text-ink">{n.text}</strong>;
        if (n.t === "i") return <em key={i}>{n.text}</em>;
        if (n.t === "a") return <Link key={i} href={n.href}>{n.text}</Link>;
        if (n.t === "img")
          return (
            <span key={i} className="mx-0.5 inline-flex items-center gap-1 rounded-[5px] border border-hair px-1.5 py-px align-middle text-[11px] text-dim">
              <ImageIcon size={10} aria-hidden />
              {safeHref(n.src) ? <Link href={n.src}>{n.text || "image"}</Link> : n.text || "image"}
            </span>
          );
        return <span key={i}>{n.text}</span>;
      })}
    </>
  );
}

const H = ["text-[14.5px]", "text-[13.5px]", "text-[13px]", "text-[12.5px]"];

function Block({ b }: { b: PrBlock }): ReactNode {
  switch (b.t) {
    case "h":
      return <p role="heading" aria-level={b.level} className={`mt-2.5 mb-1 font-display font-semibold text-ink ${H[Math.min(b.level, 4) - 1]}`}><Inline text={b.text} /></p>;
    case "p":
      return <p className="my-1.5"><Inline text={b.text} /></p>;
    case "quote":
      return <blockquote className="my-1.5 border-l-2 border-hair-strong pl-2.5 text-dim"><Inline text={b.text} /></blockquote>;
    case "ul":
    case "ol": {
      const L = b.t;
      return <L className={`my-1.5 space-y-0.5 pl-4.5 ${L === "ul" ? "list-disc" : "list-decimal"} marker:text-faint`}>{b.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}</L>;
    }
    case "code":
      return (
        <div className="my-2">
          {b.lang === "suggestion" && <span className="micro mb-1 block text-[9px] text-ok">Suggested change</span>}
          <pre className={`selectable max-h-[220px] overflow-auto rounded-[7px] border bg-void/50 p-2 font-mono text-[11px] leading-[17px] whitespace-pre text-ink ${b.lang === "suggestion" ? "border-ok/40" : "border-hair"}`}>{b.text}</pre>
        </div>
      );
    case "hr":
      return <hr className="my-2.5 border-hair" />;
    case "table":
      return (
        <div className="my-2 max-w-full overflow-x-auto rounded-[7px] border border-hair">
          <table className="w-full border-collapse font-mono text-[10.5px]">
            <thead>
              <tr>{b.head.map((h, i) => <th key={i} className="border-b border-hair px-2 py-1 text-left font-medium text-dim"><Inline text={h} /></th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-b border-hair/60 last:border-0">{b.head.map((_h, k) => <td key={k} className="px-2 py-1 align-top text-ink/90"><Inline text={r[k] ?? ""} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function CommentBody({ text }: { text: string }) {
  const blocks = useMemo(() => prMarkdown(text), [text]);
  if (!blocks.length) return <p className="my-1 text-[12px] text-faint italic">No message.</p>;
  return <div className="selectable min-w-0 text-[12.5px] leading-[1.55] break-words text-ink/85">{blocks.map((b, i) => <Block key={i} b={b} />)}</div>;
}
