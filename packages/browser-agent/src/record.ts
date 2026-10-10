import type { FlowStep } from "@shrike/schema";
import { send } from "./emit.ts";
import { accessibleName } from "./names.ts";
import { pointing } from "./point.ts";

// B1: while Shrike records a flow, report the user's clicks and typing as replayable steps.
// Navigation is noticed by main (each page load says hello), so it isn't reported here.

let on = false;
let lastClick = 0;
let resolveTarget: (el: EventTarget | null) => Element | null = () => null;

const NOT_TYPED = ["checkbox", "radio", "submit", "button", "reset", "image", "file", "hidden"];

export function setRecording(next: boolean): void {
  on = next === true;
}

function step(s: FlowStep): void {
  send({ type: "flow_step", step: s });
}

function textField(el: unknown): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (el instanceof HTMLInputElement) return !NOT_TYPED.includes(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function secret(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.type === "password" || /password|one-time-code|cc-/i.test(el.autocomplete) || /pass|secret|token|cvv|cvc|card.?num/i.test(`${el.name} ${el.id}`);
}

function typed(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, submit: boolean): void {
  const name = accessibleName(el);
  if (!name) return;
  step({ type: "type", name, text: el.value, ...(submit ? { submit: true } : {}), ...(secret(el) ? { secret: true } : {}) });
}

function onClick(ev: MouseEvent): void {
  try {
    if (!on || pointing()) return;
    const el = resolveTarget(ev.target);
    if (!el || textField(el)) return;
    if (el instanceof HTMLLabelElement && el.control && el.control !== ev.target) return;
    const name = accessibleName(el);
    if (!name) return; // a nameless click can't be found again on replay
    lastClick = Date.now();
    step({ type: "click", name });
  } catch {}
}

function onChange(ev: Event): void {
  try {
    if (on && textField(ev.target)) typed(ev.target, false);
  } catch {}
}

// Enter in a form with no submit button: no click is reported, so the field carries the submit.
function onSubmit(): void {
  try {
    if (!on || Date.now() - lastClick < 50) return;
    const el = document.activeElement;
    if (textField(el)) typed(el, true);
  } catch {}
}

export function installRecord(resolve: (el: EventTarget | null) => Element | null): void {
  resolveTarget = resolve;
  window.addEventListener("click", onClick, true);
  window.addEventListener("change", onChange, true);
  window.addEventListener("submit", onSubmit, true);
}
