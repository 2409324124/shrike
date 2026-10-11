import type { SourceLocation } from "@shrike/schema";

interface Fiber {
  return: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
  _debugStack?: { stack?: unknown } | null; // React 19 dev: an Error made where the element's JSX ran
}

function reactKey(el: Element, prefix: string): unknown {
  const k = Object.keys(el).find((key) => key.startsWith(prefix));
  return k === undefined ? undefined : (el as unknown as Record<string, unknown>)[k];
}

export function hasReactOnClick(el: Element): boolean {
  const props = reactKey(el, "__reactProps$") as { onClick?: unknown } | undefined;
  return typeof props?.onClick === "function";
}

/** Where the element's JSX is, in dev: React <= 18's _debugSource, else React 19's _debugStack as a raw stack for main to map. */
export function reactSource(el: Element): SourceLocation | string | undefined {
  let node: Element | null = el;
  let fiber: Fiber | undefined;
  while (node && !fiber) {
    fiber = reactKey(node, "__reactFiber$") as Fiber | undefined;
    node = node.parentElement;
  }
  for (let f: Fiber | null | undefined = fiber, i = 0; f && i < 200; f = f.return, i++) {
    const s = f._debugSource;
    if (s?.fileName && typeof s.lineNumber === "number") {
      const loc: SourceLocation = { file: s.fileName, line: s.lineNumber, precision: "exact" };
      if (typeof s.columnNumber === "number") loc.column = s.columnNumber;
      return loc;
    }
  }
  const stack = fiber?._debugStack?.stack;
  return typeof stack === "string" ? stack : undefined;
}
