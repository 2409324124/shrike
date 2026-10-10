import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { code } from "@shrike/design";

// Syntax colours for code panes in the 3D space: per-line token arrays, cached per file.
export interface Token {
  content: string;
  color: string;
}

// Colours are CSS variables (--code-*, set per theme by cssVariables), so a theme switch needs no re-highlight.
const v = (k: keyof typeof code) => `var(--code-${k})`;
export const CODE_FG = v("fg");

const theme: ThemeRegistrationRaw = {
  name: "shrike-void",
  type: "dark",
  settings: [
    { settings: { foreground: CODE_FG, background: v("bg") } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: v("comment") } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.control"], settings: { foreground: v("keyword") } },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: v("punct") } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: v("string") } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant"], settings: { foreground: v("number") } },
    { scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"], settings: { foreground: v("fn") } },
    { scope: ["entity.name.type", "support.type", "entity.name.class", "support.class", "entity.other.inherited-class"], settings: { foreground: v("type") } },
    { scope: ["variable.parameter"], settings: { foreground: v("param") } },
    { scope: ["variable.other.property", "meta.object-literal.key", "support.type.property-name"], settings: { foreground: v("prop") } },
    { scope: ["entity.name.tag", "support.class.component"], settings: { foreground: v("tag") } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: v("attr") } },
    { scope: ["variable.language"], settings: { foreground: v("self") } },
  ],
};

/** A token colour as a plain hex for canvas (REC clips keep the Abyss look). */
export function solidColor(c: string): string {
  const k = /^var\(--code-(\w+)\)$/.exec(c)?.[1];
  return k && k in code ? code[k as keyof typeof code] : c.startsWith("#") ? c : code.fg;
}

const LANGS: Record<string, string> = { ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", json: "json", css: "css", html: "html" };

let hl: Promise<HighlighterCore> | undefined;
const highlighter = () =>
  (hl ??= createHighlighterCore({
    themes: [theme],
    langs: [import("shiki/langs/typescript.mjs"), import("shiki/langs/tsx.mjs"), import("shiki/langs/javascript.mjs"), import("shiki/langs/jsx.mjs"), import("shiki/langs/json.mjs"), import("shiki/langs/css.mjs"), import("shiki/langs/html.mjs")],
    engine: createJavaScriptRegexEngine(),
  }));

const cache = new Map<string, { text: string; lines: Promise<Token[][]> }>();

const plain = (text: string): Token[][] => text.split("\n").map((l) => (l ? [{ content: l, color: CODE_FG }] : []));

/** Token lines for a file (1 array per line). Unknown languages and failures fall back to plain text. */
export function highlight(file: string, text: string): Promise<Token[][]> {
  const hit = cache.get(file);
  if (hit && hit.text === text) return hit.lines;
  const src = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const lang = LANGS[file.split(".").pop()?.toLowerCase() ?? ""];
  const lines = !lang
    ? Promise.resolve(plain(src))
    : highlighter()
        .then((h) => h.codeToTokensBase(src, { lang, theme: "shrike-void" }).map((l) => l.map((t) => ({ content: t.content, color: t.color ?? CODE_FG }))))
        .catch(() => plain(src));
  cache.set(file, { text, lines });
  return lines;
}
