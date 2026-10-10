// Stand-in for the user's app inside the App pane when running with the mock api (plain browser).
import { useRef, useState, useSyncExternalStore } from "react";
import { mockClick, mockFixed, mockPicked, mockPoint, mockTodos } from "./mock-api.ts";

const PICKABLE = "button, a, input, label, h1";
const SOURCE: Record<string, [string, number]> = { "Add Todo": ["src/TodoForm.tsx", 31], "New todo": ["src/TodoForm.tsx", 25], "My Todos": ["src/App.tsx", 18] };

function describe(el: Element): { role: string; text: string } {
  const tag = el.tagName.toLowerCase();
  const role = tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? ((el as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox") : tag === "label" ? "checkbox" : tag === "h1" ? "heading" : tag;
  const text = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
  return { role, text: text.slice(0, 80) };
}

/** O1 in the mock: the same outline and label the browser-agent draws inside a real page. */
function usePoint(root: React.RefObject<HTMLDivElement | null>) {
  const on = useSyncExternalStore(mockPoint.subscribe, mockPoint.get);
  const [hover, setHover] = useState<{ el: Element; rect: DOMRect } | null>(null);
  const target = (t: EventTarget | null) => (t instanceof Element ? (t.closest(PICKABLE) ?? t) : null);
  const box = root.current?.getBoundingClientRect();
  return {
    on,
    outline: on && hover && box ? { left: hover.rect.left - box.left - 2, top: hover.rect.top - box.top - 2, width: hover.rect.width + 4, height: hover.rect.height + 4, ...describe(hover.el) } : null,
    handlers: {
      onPointerMoveCapture: (e: React.PointerEvent) => {
        if (!on) return;
        const el = target(e.target);
        setHover(el && el !== root.current ? { el, rect: el.getBoundingClientRect() } : null);
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (!on) return;
        e.preventDefault();
        e.stopPropagation();
        const el = target(e.target);
        setHover(null);
        if (!el || !box) return mockPicked(null);
        const r = el.getBoundingClientRect();
        const d = describe(el);
        const src = SOURCE[d.text];
        mockPicked({
          selector: el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")}"]` : ""),
          ...d,
          rect: { x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height, viewportWidth: box.width, viewportHeight: box.height },
          ...(src ? { source: { file: src[0], line: src[1], precision: "exact" as const } } : {}),
        });
      },
    },
  };
}

export function MockApp() {
  const [title, setTitle] = useState("buy milk");
  const [list, setList] = useState(() => mockTodos.map((t) => ({ ...t })));
  const root = useRef<HTMLDivElement>(null);
  const point = usePoint(root);

  return (
    <div ref={root} className="absolute inset-0 overflow-auto bg-white p-8 font-sans text-[#14161c]" style={point.on ? { cursor: "crosshair" } : undefined} {...point.handlers}>
      <main className="mx-auto max-w-[380px]">
        <h1 className="mb-4 text-[22px] font-bold">My Todos</h1>
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mockClick("add", title);
            if (mockFixed()) setList((l) => [...l, { id: l.length + 10, title, done: false, user_id: 1 }]);
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="New todo"
            placeholder="What needs doing?"
            className="h-9 min-w-0 flex-1 rounded-md border border-[#cfd4dd] px-2 text-[14px] text-[#14161c] outline-none focus:border-[#4555e8]"
          />
          <button type="submit" className="h-9 rounded-md bg-[#14161c] px-3 text-[14px] font-medium text-white">
            Add Todo
          </button>
        </form>
        <ul className="flex flex-col gap-1.5">
          {list.map((t) => (
            <li key={t.id}>
              <label className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => {
                    mockClick("toggle", t.id);
                    setList((l) => l.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)));
                  }}
                />
                <span className={t.done ? "text-[#8a90a2] line-through" : ""}>{t.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </main>
      {point.outline && (
        <>
          <div className="pointer-events-none absolute rounded-[3px] border border-[#3FE7FF]" style={{ left: point.outline.left, top: point.outline.top, width: point.outline.width, height: point.outline.height, boxShadow: "0 0 0 1px rgba(63,231,255,.18), 0 0 14px rgba(63,231,255,.35)" }} />
          <div className="pointer-events-none absolute rounded-[4px] border border-[#3FE7FF]/45 bg-[#02040A]/90 px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-[#3FE7FF]" style={{ left: Math.max(2, Math.min(point.outline.left, (root.current?.clientWidth ?? 400) - 150)), top: point.outline.top >= 26 ? point.outline.top - 24 : point.outline.top + point.outline.height + 4 }}>
            {point.outline.text ? `${point.outline.role} · ${point.outline.text}` : point.outline.role}
          </div>
        </>
      )}
    </div>
  );
}
