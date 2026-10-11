import { beginWork, openAction } from "./actions.ts";
import { installConsole } from "./console.ts";
import { send } from "./emit.ts";
import { accessibleName } from "./names.ts";
import { installNetwork } from "./network.ts";
import { click, snapshot, type } from "./page-api.ts";
import { installPoint, pointing, setPoint } from "./point.ts";
import { installRecord, setRecording } from "./record.ts";
import { hasReactOnClick, reactSource } from "./react.ts";

const CLICKABLE =
  'button, a, input[type="submit"], input[type="checkbox"], input[type="radio"], [role="button"], label, select, summary, [onclick]';

function actionTarget(start: EventTarget | null): Element | null {
  let el = start instanceof Element ? start : null;
  for (let i = 0; el && i < 25; el = el.parentElement, i++) {
    if (el.matches(CLICKABLE) || hasReactOnClick(el)) return el;
  }
  return null;
}

function clickLabel(el: Element): string {
  const name = accessibleName(el);
  if (el instanceof HTMLInputElement && el.type === "checkbox") return `${el.checked ? "Ticked" : "Unticked"} "${name}"`;
  return name ? `Clicked "${name}"` : `Clicked ${el.tagName.toLowerCase()}`;
}

let clickInProgress = false;
const setT = window.setTimeout.bind(window);

function onClick(ev: MouseEvent): void {
  try {
    if (pointing()) return;
    const el = actionTarget(ev.target);
    if (!el) return;
    // A label click re-dispatches a click on its control; let that one open the action.
    if (el instanceof HTMLLabelElement && el.control && el.control !== ev.target) return;
    openAction("click", clickLabel(el), reactSource(el), Date.now(), el);
    clickInProgress = true;
    setT(() => (clickInProgress = false), 0);
  } catch {}
}

function onSubmit(ev: SubmitEvent): void {
  try {
    // Clicking a submit button fires click then submit in the same task: one action, not two.
    if (clickInProgress) return;
    const form = ev.target instanceof HTMLFormElement ? ev.target : null;
    const by = ev.submitter ?? form?.querySelector('button:not([type="button"]):not([type="reset"]), input[type="submit"]');
    const name = (form && form.getAttribute("aria-label")) || (by ? accessibleName(by) : "");
    openAction("submit", name ? `Submitted "${name}"` : "Submitted form", reactSource(by ?? form ?? document.body), Date.now(), by ?? form);
  } catch {}
}

function install(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__shrike || window.top !== window) return;
  Object.defineProperty(window, "__shrike", { value: { snapshot, click, type, point: setPoint, record: setRecording }, configurable: true });

  send({ type: "hello", source: "browser", url: location.href, at: Date.now() });
  // Open the page-load action at document start so requests made before DOMContentLoaded join it.
  openAction("navigation", `Opened ${location.pathname}`, undefined, Math.round(performance.timeOrigin));
  const hold = beginWork("");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => hold.settle(false), { once: true });
  else hold.settle(false);

  installNetwork();
  installConsole();
  installPoint((el) => actionTarget(el) ?? el);
  installRecord(actionTarget);
  window.addEventListener("click", onClick, true);
  window.addEventListener("submit", onSubmit, true);
  // A key press is a new task even before onClick's timer runs (Chromium runs input ahead of timers): Enter's submit is its own action.
  window.addEventListener("keydown", () => (clickInProgress = false), true);
}

try {
  install();
} catch {}
