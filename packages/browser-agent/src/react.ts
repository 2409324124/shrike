import type { SourceLocation } from "@shrike/schema";

interface Fiber {
  return: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null;
}

function reactKey(el: Element, prefix: string): unknown {
  const k = Object.keys(el).find((key) => key.startsWith(prefix));
  return k === undefined ? undefined : (el as unknown as Record<string, unknown>)[k];
}

export function hasReactOnClick(el: Element): boolean {
  const props = reactKey(el, "__reactProps$") as { onClick?: unknown } | undefined;
  return typeof props?.onClick === "function";
}

// ponytail: React <= 18 dev only (_debugSource). React 19 dropped it; upgrade path is _debugStack + source maps.
export function reactSource(el: Element): SourceLocation | undefined {
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
  return undefined;
}
