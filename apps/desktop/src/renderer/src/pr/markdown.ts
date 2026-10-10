import { parseMarkdown, type MdBlock } from "../hud/logic.ts";

// PR5: GitHub comments as safe markdown. Blocks come from the file view's parser (O13) plus tables; raw HTML never renders:
// comments and scripts are dropped, <br> and <details> become text, every other tag is stripped to its text.

export type PrBlock = MdBlock | { t: "table"; head: string[]; rows: string[][] };

const FENCE = /^\s*(```|~~~)/;
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/** HTML outside code fences, reduced to plain text. Rendering is React text nodes either way; this keeps tags out of sight. */
export function stripHtml(src: string): string {
  return src
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?(<\/\1\s*>|$)/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] ?? "";
      const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "image";
      return src ? `![${alt.replace(/[[\]]/g, "")}](${src})` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi, (_m, t: string) => `\n**${t.replace(/<[^>]+>/g, "").trim()}**\n\n`)
    .replace(/<\/?(p|div|details|table|tr|h[1-6]|ul|ol|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?[a-z][\w-]*(\s[^<>]*)?\/?>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function prMarkdown(src: string): PrBlock[] {
  const out: PrBlock[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let text: string[] = [];
  let code: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (text.length) out.push(...parseMarkdown(stripHtml(text.join("\n"))));
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const f = FENCE.exec(l);
    if (fence) {
      const end = !!f && f[1] === fence;
      code.push(end ? "```" : l);
      if (end) {
        out.push(...parseMarkdown(code.join("\n")));
        code = [];
        fence = null;
      }
      continue;
    }
    if (f) {
      flush();
      fence = f[1]!;
      code = [l.replace("~~~", "```")];
      continue;
    }
    if (l.includes("|") && SEP.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(stripHtml(l));
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i++) rows.push(cells(stripHtml(lines[i]!)).slice(0, head.length));
      i--;
      out.push({ t: "table", head, rows });
      continue;
    }
    text.push(l);
  }
  if (fence) out.push(...parseMarkdown(code.join("\n"))); // an unclosed fence still reads as code
  flush();
  return out;
}

/** Only web and mail links open (in the system browser); javascript:, data:, file: and relative links stay text. */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  return /^(https?:\/\/|mailto:)[^\s]+$/i.test(h) ? h : undefined;
}
