import { useEffect, useMemo, useState, type ReactNode } from "react";
import { parseInline, parseMarkdown, type MdBlock } from "../hud/logic.ts";
import { call } from "../lib/api.ts";

// O13: Markdown in the file view as formatted text. Built from React elements, never innerHTML.

/** Images next to the file load from the project; remote ones stay as their alt text (nothing leaves this machine). */
function LocalImage({ src, alt, base }: { src: string; alt: string; base: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const local = !/^[a-z]+:/i.test(src) && !src.startsWith("//");
  useEffect(() => {
    if (!local) return;
    const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
    const parts: string[] = [];
    for (const p of (src.startsWith("/") ? src.slice(1) : dir + src).split("/")) p === ".." ? parts.pop() : p && p !== "." && parts.push(p);
    let live = true;
    void call((a) => a.readFileDataUrl(parts.join("/")), "Couldn't load an image").then((u) => live && u && setUrl(u));
    return () => {
      live = false;
    };
  }, [src, base, local]);
  if (!url) return <em className="text-dim">[{alt || "image"}]</em>;
  return <img src={url} alt={alt} className="my-2 inline-block max-h-[320px] max-w-full rounded-[6px]" />;
}

function Inline({ text, base }: { text: string; base: string }) {
  return (
    <>
      {parseInline(text).map((n, i) => {
        if (n.t === "code") return <code key={i} className="rounded-[4px] bg-white/[0.06] px-1 py-px font-mono text-[0.88em] text-ink">{n.text}</code>;
        if (n.t === "b") return <strong key={i} className="font-semibold text-ink">{n.text}</strong>;
        if (n.t === "i") return <em key={i}>{n.text}</em>;
        if (n.t === "a") return <span key={i} className="text-signal underline decoration-signal/40 underline-offset-2" title={n.href}>{n.text}</span>;
        if (n.t === "img") return <LocalImage key={i} src={n.src} alt={n.text} base={base} />;
        return <span key={i}>{n.text}</span>;
      })}
    </>
  );
}

const H = ["text-[24px] mt-2 mb-4", "text-[19px] mt-6 mb-3", "text-[16px] mt-5 mb-2", "text-[14px] mt-4 mb-2"];

function Block({ b, base }: { b: MdBlock; base: string }): ReactNode {
  switch (b.t) {
    case "h":
      return <p className={`font-display font-semibold text-ink ${H[Math.min(b.level, 4) - 1]}`} role="heading" aria-level={b.level}><Inline text={b.text} base={base} /></p>;
    case "p":
      return <p className="my-3"><Inline text={b.text} base={base} /></p>;
    case "quote":
      return <blockquote className="my-3 border-l-2 border-hair-strong pl-3 text-dim"><Inline text={b.text} base={base} /></blockquote>;
    case "ul":
    case "ol": {
      const L = b.t === "ul" ? "ul" : "ol";
      return (
        <L className={`my-3 space-y-1 pl-5 ${b.t === "ul" ? "list-disc" : "list-decimal"} marker:text-faint`}>
          {b.items.map((it, i) => <li key={i}><Inline text={it} base={base} /></li>)}
        </L>
      );
    }
    case "code":
      return <div className="selectable my-3 overflow-auto rounded-[8px] border border-hair bg-black/30 p-3 font-mono text-[12px] leading-[19px] whitespace-pre text-ink">{b.text}</div>;
    case "hr":
      return <hr className="my-5 border-hair" />;
  }
}

export function Markdown({ text, path }: { text: string; path: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <article className="selectable mx-auto max-w-[720px] px-8 py-6 font-display text-[14px] leading-[1.65] text-ink/85">
      {blocks.map((b, i) => <Block key={i} b={b} base={path} />)}
    </article>
  );
}
