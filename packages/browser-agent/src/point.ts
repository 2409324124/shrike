import type { PointPick } from "@shrike/schema";
import { send } from "./emit.ts";
import { accessibleName, clean } from "./names.ts";
import { role } from "./page-api.ts";
import { reactSource } from "./react.ts";

// O1 point mode: outline what's under the mouse, take the next click for Shrike instead of the page.

const CYAN = "#3FE7FF";
const SWALLOW = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend"];

let on = false;
let box: HTMLDivElement | null = null;
let tag: HTMLDivElement | null = null;
let hovered: Element | null = null;
let resolveTarget: (el: Element) => Element = (el) => el;

export const pointing = (): boolean => on;

function overlay(): void {
  const base = "all:initial;position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;";
  box = document.createElement("div");
  box.setAttribute("data-shrike-point", "box");
  box.style.cssText = `${base}border:1px solid ${CYAN};border-radius:3px;box-shadow:0 0 0 1px rgba(63,231,255,.18),0 0 14px rgba(63,231,255,.35);display:none;`;
  tag = document.createElement("div");
  tag.setAttribute("data-shrike-point", "tag");
  tag.style.cssText = `${base}font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.04em;color:${CYAN};background:rgba(2,4,10,.92);border:1px solid rgba(63,231,255,.45);border-radius:4px;padding:2px 6px;white-space:nowrap;display:none;`;
  document.documentElement.append(box, tag);
}

function describe(el: Element): { role: string; text: string } {
  return { role: role(el), text: accessibleName(el) || clean(el.textContent) };
}

function show(el: Element | null): void {
  hovered = el;
  if (!box || !tag) return;
  if (!el) {
    box.style.display = tag.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  const d = describe(el);
  tag.textContent = d.text ? `${d.role} · ${d.text}` : d.role;
  tag.style.display = "block";
  const above = r.top - 24;
  const left = Math.min(r.left - 2, innerWidth - tag.offsetWidth - 2);
  Object.assign(tag.style, { left: `${Math.max(2, left)}px`, top: `${above >= 2 ? above : r.bottom + 6}px` });
}

export function selectorFor(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el, i = 0; n && n !== document.documentElement && i < 5; n = n.parentElement, i++) {
    if (n.id) {
      parts.unshift(`#${CSS.escape(n.id)}`);
      break;
    }
    const test = n.getAttribute("data-testid");
    if (test) {
      parts.unshift(`[data-testid="${CSS.escape(test)}"]`);
      break;
    }
    const tagName = n.tagName.toLowerCase();
    const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tagName}:nth-of-type(${same.indexOf(n) + 1})` : tagName);
  }
  return parts.join(" > ");
}

function pick(el: Element): PointPick {
  const r = el.getBoundingClientRect();
  const d = describe(el);
  const p: PointPick = {
    selector: selectorFor(el),
    text: d.text,
    role: d.role,
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), viewportWidth: innerWidth, viewportHeight: innerHeight },
  };
  const src = reactSource(el);
  if (src) p.source = src;
  return p;
}

function target(t: EventTarget | null): Element | null {
  return t instanceof Element && !t.hasAttribute("data-shrike-point") ? resolveTarget(t) : null;
}

function onMove(ev: Event): void {
  if (on) show(target(ev.target));
}

function onSwallow(ev: Event): void {
  if (!on) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (ev.type !== "click") return;
  const el = target(ev.target) ?? hovered;
  setPoint(false);
  if (el) send({ type: "point", pick: pick(el) });
  else send({ type: "point", cancelled: true });
}

function onKey(ev: KeyboardEvent): void {
  if (!on || ev.key !== "Escape") return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  setPoint(false);
  send({ type: "point", cancelled: true });
}

export function setPoint(next: boolean): void {
  on = next;
  if (on && !box) overlay();
  if (!on) show(null);
  document.documentElement.style.cursor = on ? "crosshair" : "";
}

// Registered before the click recorder so a picked click never opens an action.
export function installPoint(resolve: (el: Element) => Element): void {
  resolveTarget = resolve;
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerover", onMove, true);
  for (const t of SWALLOW) window.addEventListener(t, onSwallow, true);
  window.addEventListener("keydown", onKey, true);
}
