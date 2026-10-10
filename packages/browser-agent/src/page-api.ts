import type { AppElement, AppSnapshot } from "@shrike/schema";
import { lastOpenedId } from "./actions.ts";
import { accessibleName, clean } from "./names.ts";

const INTERACTIVE =
  'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"]';
const REF = "data-shrike-ref";
let counter = 0;

function visible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none";
}

export function role(el: Element): string {
  const r = el.getAttribute("role");
  if (r) return r;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (el instanceof HTMLInputElement) {
    if (["button", "submit", "reset", "image"].includes(el.type)) return "button";
    if (el.type === "checkbox" || el.type === "radio") return el.type;
    if (el.type === "range") return "slider";
    if (el.type === "search") return "searchbox";
    return "textbox";
  }
  return tag;
}

function value(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
    if (el.type === "password") return el.value ? "[hidden]" : "";
    if (["button", "submit", "reset", "image"].includes(el.type)) return undefined;
    return el.value.slice(0, 200);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value.slice(0, 200);
  return undefined;
}

function find(ref: string): HTMLElement | null {
  const el = document.querySelector(`[${REF}="${CSS.escape(ref)}"]`);
  return el instanceof HTMLElement ? el : null;
}

export function snapshot(): AppSnapshot {
  const elements: AppElement[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (!visible(el)) continue;
    let ref = el.getAttribute(REF);
    if (!ref) {
      ref = `e${++counter}`;
      el.setAttribute(REF, ref);
    }
    const item: AppElement = { ref, role: role(el), name: accessibleName(el) };
    const v = value(el);
    if (v !== undefined) item.value = v;
    elements.push(item);
  }
  const text = (document.body?.innerText ?? "").slice(0, 4096);
  return { url: location.href, title: clean(document.title), elements, text };
}

function opened(before: string | null): string | null {
  const now = lastOpenedId();
  return now !== before ? now : null;
}

export function click(ref: string): string | null {
  const el = find(ref);
  if (!el) return null;
  const before = lastOpenedId();
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return opened(before);
}

const NATIVE_SETTERS: [typeof HTMLElement, PropertyDescriptor | undefined][] = [
  [HTMLInputElement, Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")],
  [HTMLTextAreaElement, Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")],
  [HTMLSelectElement, Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")],
];

export function type(ref: string, text: string, submit?: boolean): string | null {
  const el = find(ref);
  if (!el) return null;
  const setter = NATIVE_SETTERS.find(([C]) => el instanceof C)?.[1]?.set;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  if (setter) setter.call(el, text);
  else if (el.isContentEditable) el.textContent = text;
  else return null;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (!submit) return null;
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  if (!form) return null;
  const before = lastOpenedId();
  form.requestSubmit();
  return opened(before);
}
