// Layout audit helpers (layout-audit.test.ts): resize the real window, swap themes, capture, and run in-page box checks.
// The screenshot is the evidence; these checks only point at the boxes behind what the screenshot shows.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { cssVariables, themes, type ThemeId } from "@shrike/design";
import { sleep } from "./helpers.ts";

export type Check = "overlap" | "covered" | "glass" | "occluded" | "clipped" | "truncated" | "offscreen" | "cutoff" | "zero" | "cramped" | "floating" | "hscroll";
export interface Box { x: number; y: number; w: number; h: number }
export interface Finding { check: Check; a: string; b?: string; ra: Box; rb?: Box; detail?: string }
export interface Allow { check?: Check | Check[]; a?: RegExp; b?: RegExp; why: string }
export interface Size { w: number; h: number }

export const SIZES: Size[] = [{ w: 1100, h: 700 }, { w: 1440, h: 900 }, { w: 1920, h: 1200 }];
/** Abyss and Daylight at every size, all six at 1440x900. LAYOUT_QUICK=1: Abyss and Daylight at 1440x900 only. */
export function matrix(): [Size, ThemeId][] {
  const all = Object.keys(themes) as ThemeId[];
  if (process.env.LAYOUT_QUICK === "1") return (["abyss", "daylight"] as ThemeId[]).map((t) => [SIZES[1]!, t]);
  return SIZES.flatMap((s) => (s.w === 1440 ? all : (["abyss", "daylight"] as ThemeId[])).map((t) => [s, t] as [Size, ThemeId]));
}

const THREAD = /^div\.th-(shot|dive|lanehead)\b|^div\.@container\.pointer-events-none!\.absolute\b/; // Thread cards, the dive card, the lane band, the caption
const BACKDROP = /scrim|^div\.(ch-dim|opt-scrim)\b|^div\.absolute\.inset-0\b/;
// Intentional layers: a finding that matches one of these is kept in the JSON as allowed, never reported.
export const ALLOW: Allow[] = [
  { check: ["covered", "glass", "occluded"], b: /aria-modal|xr-scrim|scrim/, why: "a modal dialog or scrim is meant to sit over everything behind it" },
  { check: ["covered", "glass", "occluded", "overlap"], a: /^webview/, why: "the user's app pane is audited by its own app, not Shrike" },
  { check: ["covered", "glass", "occluded"], a: /sr-only|th-acc/, why: "screen-reader-only mirrors are not painted" },
  { check: ["covered", "glass"], b: /^div\.th-lanehead/, why: "the sticky lane header slides over the scrolling feed by design" },
  { check: "cramped", a: /role=tab\b/, b: /role=tab\b/, why: "tabs in one tablist are a segmented control" },
  { check: "cramped", a: /role=radio\b/, b: /role=radio\b/, why: "radios in one group are a segmented control" },
  { check: "hscroll", a: /^(pre|code|table)|code|diff|th-dive|fv|ap-body|shiki|\(table or code\)$/, why: "code and tables scroll sideways on purpose" },
  { check: "hscroll", a: /role=tablist/, why: "a tab strip scrolls sideways when its tabs outgrow it" },
  { check: "floating", a: THREAD, why: "the Thread is the stage's canvas: cards, sheets, scrims and the composer sit over it by design (what peeks round their edges is read in the screenshot)" },
  { check: "floating", b: THREAD, why: "the Thread is the stage's canvas: cards, sheets, scrims and the composer sit over it by design (what peeks round their edges is read in the screenshot)" },
  { check: ["floating", "overlap"], a: BACKDROP, why: "a backdrop dims or catches clicks across the whole stage or dock under its card" },
  { check: ["floating", "overlap"], b: BACKDROP, why: "a backdrop dims or catches clicks across the whole stage or dock under its card" },
  { check: "floating", a: /\[Agent\]/, b: /ch-panel/, why: "P-chain6: the chain panel dims the stage (ch-dim) and the agent cards wait under the dim" },
  { check: "floating", b: /scm-diff role=dialog/, why: "C1: the diff view is a dialog over the stage and app pane, from the rail to the dock" },
  { check: "overlap", a: /^button\.th-st\b/, b: /^button\.glass\.solid\.rise "New trip|^div\.glass\.solid\.rise role=(status|alert)/, why: "a toast sits in the lane-header band, and the Thread scrolls under that band" },
  { check: "overlap", a: /^button \[.*, (worked|broke)\]$/, b: /\[Checkpoint \d+:/, why: "A6: a checkpoint diamond is a badge pinned on its trip glyph's corner" },
];

const allowed = (f: Finding, allow: Allow[]) =>
  allow.find((r) => (!r.check || (Array.isArray(r.check) ? r.check.includes(f.check) : r.check === f.check)) && (!r.a || r.a.test(f.a)) && (!r.b || r.b.test(f.b ?? "")));

export async function setSize(app: ElectronApplication, s: Size): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.getParentWindow())!;
    w.setMinimumSize(800, 600);
    w.setContentSize(s.w, s.h);
  }, s);
  await sleep(800); // ResizeObserver layouts (dock clamps, API client narrow/stack) settle, and Thread labels finish their 0.5s move
}

/** What themes/store.ts apply() does, without touching focus or open popovers. */
export async function setTheme(win: Page, id: ThemeId): Promise<void> {
  await win.evaluate(([css, id, glow]) => {
    let el = document.getElementById("shrike-tokens");
    if (!el) {
      el = document.createElement("style");
      el.id = "shrike-tokens";
      document.head.prepend(el);
    }
    el.textContent = css;
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.glow = glow;
  }, [cssVariables(id), id, themes[id].glow ? "on" : "off"] as const);
  await sleep(250);
}

/** Runs in the page. Self-contained: no closures over Node values. */
export function pageAudit(): Finding[] {
  const W = innerWidth, H = innerHeight;
  const out: Finding[] = [];
  const INTER = 'button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[role=tab],[role=option],[role=menuitem],[role=radio],[role=checkbox],[role=switch],[role=slider],[contenteditable="true"]';
  const box = (r: { left: number; top: number; width: number; height: number }) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const isect = (a: Box, b: Box): Box | null => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
    return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
  };
  const area = (b: Box) => b.w * b.h;
  const desc = (el: Element): string => {
    const lab = el.getAttribute("aria-label");
    const role = el.getAttribute("role");
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 3).join(".") : "";
    const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const modal = el.getAttribute("aria-modal") === "true" ? " aria-modal" : "";
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${role ? ` role=${role}` : ""}${lab ? ` [${lab.slice(0, 50)}]` : ""}${modal}${txt && !lab ? ` "${txt}"` : ""}`;
  };
  // The nearest named layer, so a finding says which card or panel it is in.
  const layer = (el: Element): string => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const r = e.getAttribute("role");
      if (e.getAttribute("aria-modal") === "true" || r === "dialog" || r === "status" || r === "alertdialog" || ((r === "region" || e.tagName === "ASIDE" || e.tagName === "NAV" || e.tagName === "FORM" || e.tagName === "HEADER") && e.getAttribute("aria-label"))) return desc(e).slice(0, 90);
    }
    return desc(el).slice(0, 90);
  };
  const cs = (el: Element) => getComputedStyle(el);
  const alpha = (c: string) => {
    if (!c || c === "transparent") return 0;
    const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/);
    if (!m) return 1;
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]!) : 1;
  };
  const opacityOf = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e; e = e.parentElement) o *= parseFloat(cs(e).opacity || "1");
    return o;
  };
  // Painted: something that hides what is under it. Returns 0 (not painted), 1 (translucent or blurred glass), 2 (opaque).
  const paint = (el: Element): 0 | 1 | 2 => {
    const tag = el.tagName;
    if (/^(IMG|VIDEO|CANVAS|IFRAME|WEBVIEW)$/.test(tag)) return 2;
    const s = cs(el);
    const a = alpha(s.backgroundColor) * parseFloat(s.opacity || "1");
    const bf = s.backdropFilter && s.backdropFilter !== "none";
    if (a >= 0.85 || (s.backgroundImage !== "none" && !s.backgroundImage.startsWith("radial-gradient") && a > 0.5)) return 2;
    if (bf || a > 0.12 || (s.backgroundImage !== "none" && s.backgroundImage.includes("gradient"))) return 1;
    return 0;
  };
  // Box clipped by overflow ancestors and the viewport. `by`: what clipped it ("viewport", "scroll" or "hidden").
  const clip = (el: Element, r: Box): { v: Box | null; by: string | null } => {
    let v: Box | null = r;
    let by: string | null = null;
    let pos = cs(el).position;
    let skipToPositioned = pos === "absolute";
    if (pos === "fixed") return { v: isect(r, { x: 0, y: 0, w: W, h: H }), by: null };
    for (let e = el.parentElement; e && v; e = e.parentElement) {
      const s = cs(e);
      if (skipToPositioned) {
        if (s.position === "static") continue;
        skipToPositioned = false;
      }
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const pr = e.getBoundingClientRect();
        const prev: Box = v;
        const big = 1e6; // an axis left visible (overflow: visible clip) does not cut
        v = isect(v, { x: s.overflowX === "visible" ? -big : Math.round(pr.left), y: s.overflowY === "visible" ? -big : Math.round(pr.top), w: s.overflowX === "visible" ? 2 * big : Math.round(pr.width), h: s.overflowY === "visible" ? 2 * big : Math.round(pr.height) });
        // Per axis: cut sideways by a box that only scrolls vertically is a cut, not a scroll.
        // Gone entirely: only the axis it fell off counts (a row scrolled out of an overflow-y list is not hidden sideways).
        const offX = prev.x >= pr.right || prev.x + prev.w <= pr.left, offY = prev.y >= pr.bottom || prev.y + prev.h <= pr.top;
        const cutX = v ? v.w < prev.w - 1 : offX, cutY = v ? v.h < prev.h - 1 : offY;
        const hid = (cutX && !/auto|scroll/.test(s.overflowX)) || (cutY && !/auto|scroll/.test(s.overflowY));
        if (cutX || cutY) by = hid ? "hidden" : by === "hidden" ? "hidden" : "scroll";
      }
      if (s.position === "fixed") break;
      if (s.position === "absolute") skipToPositioned = true;
    }
    if (v) {
      const before = area(v);
      v = isect(v, { x: 0, y: 0, w: W, h: H });
      if (v && area(v) < before - 1 && !by) by = "viewport";
    }
    return { v, by };
  };

  const shown = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true } as never) ?? true;
  const srOnly = (el: Element, r: DOMRect) => (r.width <= 2 && r.height <= 2) || cs(el).clip !== "auto" || /sr-only/.test(String((el as HTMLElement).className));

  interface Item { el: Element; r: Box; v: Box; by: string | null; inter: boolean; text: boolean }
  const items: Item[] = [];
  const seen = new Set<Element>();
  const add = (el: Element, inter: boolean) => {
    if (seen.has(el) || el.closest("#__layout_audit")) return;
    seen.add(el);
    if (!shown(el) || opacityOf(el) < 0.15) return;
    const raw = el.getBoundingClientRect();
    if (inter && raw.width < 1 && raw.height < 1) {
      if (!srOnly(el, raw) && !el.closest("[aria-hidden=true],[inert]")) out.push({ check: "zero", a: desc(el), ra: box(raw), detail: layer(el) });
      return;
    }
    if (srOnly(el, raw)) return;
    let r = box(raw);
    if (!inter) {
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const tr = rg.getBoundingClientRect();
      if (tr.width < 1 || tr.height < 1) return;
      r = isect(box(tr), r) ?? box(tr);
    }
    const { v, by } = clip(el, r);
    if (!v && inter && by === "hidden") out.push({ check: "cutoff", a: desc(el), ra: r, detail: `0% visible: hidden by a box that does not scroll · ${layer(el)}` });
    if (!v || v.w < 2 || v.h < 2) return;
    items.push({ el, r, v, by, inter, text: !inter });
  };
  for (const el of document.querySelectorAll(INTER)) add(el, true);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    const p = n.parentElement;
    if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(p.tagName)) continue;
    if (p.closest(INTER)) continue; // the control itself is the item
    add(p, false);
  }

  // (d) cut by the window edge or by an overflow:hidden box that does not scroll.
  for (const it of items) {
    if (!it.inter) continue;
    const frac = area(it.v) / Math.max(1, area(it.r));
    if (frac < 0.9 && it.by === "viewport") out.push({ check: "offscreen", a: desc(it.el), ra: it.r, detail: `${Math.round(frac * 100)}% on screen · ${layer(it.el)}` });
    else if (frac < 0.9 && it.by === "hidden") out.push({ check: "cutoff", a: desc(it.el), ra: it.r, detail: `${Math.round(frac * 100)}% visible · ${layer(it.el)}` });
  }

  // Cut by an ancestor that ends its line in an ellipsis and carries the full text: a truncation, not a clip.
  const ellipsized = (el: Element) => {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = cs(e);
      if (/hidden|clip/.test(s.overflowX)) return s.textOverflow === "ellipsis" && (!!e.closest("[title]") || !!e.closest("[aria-label]"));
    }
    return false;
  };
  // (c) clipped text: overflow without an ellipsis, or an ellipsis with no full text anywhere near.
  for (const it of items) {
    if (!it.text) continue;
    const el = it.el as HTMLElement;
    const s = cs(el);
    const titled = !!el.closest("[title]") || !!el.closest("[aria-label]");
    const clamp = s.webkitLineClamp && s.webkitLineClamp !== "none";
    if (el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(s.overflowX) && el.clientWidth > 0) {
      if (s.textOverflow === "ellipsis") { if (!titled) out.push({ check: "truncated", a: desc(el), ra: it.r, detail: `ellipsis with no title · ${layer(el)}` }); }
      else out.push({ check: "clipped", a: desc(el), ra: it.r, detail: `text ${el.scrollWidth}px in a ${el.clientWidth}px box · ${layer(el)}` });
    } else if (el.scrollHeight > el.clientHeight + 2 && /hidden|clip/.test(s.overflowY) && el.clientHeight > 0 && !clamp) {
      out.push({ check: "clipped", a: desc(el), ra: it.r, detail: `text ${el.scrollHeight}px tall in a ${el.clientHeight}px box · ${layer(el)}` });
    } else if (clamp && !titled && el.scrollHeight > el.clientHeight + 2) {
      out.push({ check: "truncated", a: desc(el), ra: it.r, detail: `line clamp with no title · ${layer(el)}` });
    } else if (it.by === "hidden" && (it.v.w < it.r.w - 2 || it.v.h < it.r.h * 0.6) && !ellipsized(el)) {
      out.push({ check: "clipped", a: desc(el), ra: it.r, detail: `text cut by a container that does not scroll (${Math.round((area(it.v) / area(it.r)) * 100)}% shown) · ${layer(el)}` });
    }
  }

  // (b) occlusion with real pointer-events: a control's centre must hit itself.
  for (const it of items) {
    if (!it.inter) continue;
    if (cs(it.el).pointerEvents === "none") continue;
    const cx = it.v.x + it.v.w / 2, cy = it.v.y + it.v.h / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || it.el === hit || it.el.contains(hit) || hit.contains(it.el)) continue;
    if ((it.el as HTMLElement).closest("label")?.contains(hit)) continue;
    out.push({ check: "occluded", a: desc(it.el), b: `${desc(hit).slice(0, 80)} in ${layer(hit)}`, ra: it.r, rb: box(hit.getBoundingClientRect()), detail: `click lands on ${desc(hit).slice(0, 60)}` });
  }

  // Visual stacking: let every element hit-test so painted layers above a text or control are found.
  const force = document.createElement("style");
  force.textContent = "@layer properties{*{pointer-events:auto!important}}"; // the first layer's !important outranks a utility's (pointer-events-none!)
  document.head.append(force);
  try {
    const coverAt = (it: Item, x: number, y: number) => {
      const stack = document.elementsFromPoint(x, y);
      const k = stack.indexOf(it.el);
      if (k < 0) return null;
      let worst: { el: Element; p: 1 | 2 } | null = null;
      for (let i = k - 1; i >= 0; i--) {
        const e = stack[i]!;
        if (it.el.contains(e) || e.closest("#__layout_audit")) continue;
        const p = paint(e);
        if (p && opacityOf(e) > 0.2 && (!worst || p > worst.p)) worst = { el: e, p };
      }
      return worst;
    };
    for (const it of items) {
      const c = coverAt(it, it.v.x + it.v.w / 2, it.v.y + it.v.h / 2);
      if (!c) continue;
      const ra = it.r, rb = box(c.el.getBoundingClientRect());
      out.push({ check: c.p === 2 ? "covered" : "glass", a: desc(it.el), b: `${desc(c.el).slice(0, 70)} in ${layer(c.el)}`, ra, rb, detail: c.p === 2 ? "painted over by an opaque layer" : "under a translucent or blurred layer" });
      (it as Item & { under?: boolean }).under = true;
    }

    // (a) two visible things drawn on top of each other in the same layer.
    const vis = items.filter((it) => !(it as Item & { under?: boolean }).under);
    for (let i = 0; i < vis.length; i++) {
      for (let j = i + 1; j < vis.length; j++) {
        const A = vis[i]!, B = vis[j]!;
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        const o = isect(A.v, B.v);
        if (!o || o.w < 3 || o.h < 3 || area(o) < 0.15 * Math.min(area(A.v), area(B.v))) continue;
        const stack = document.elementsFromPoint(o.x + o.w / 2, o.y + o.h / 2);
        const ka = stack.indexOf(A.el), kb = stack.indexOf(B.el);
        if (ka < 0 || kb < 0) continue;
        const [top, bot] = ka < kb ? [ka, kb] : [kb, ka];
        const botEl = stack[bot]!;
        if (stack.slice(top + 1, bot).some((e) => !e.contains(botEl) && paint(e) === 2)) continue; // an opaque card between (the top one's own card counts): that is "covered", not a collision
        out.push({ check: "overlap", a: desc(A.el), b: desc(B.el), ra: A.v, rb: B.v, detail: `${o.w}x${o.h}px overlap · ${layer(A.el)}` });
      }
    }
  } finally {
    force.remove();
  }

  // (e) controls closer than 4px (not nested, side by side or stacked).
  const ctl = items.filter((it) => it.inter && !(it as Item & { under?: boolean }).under);
  for (let i = 0; i < ctl.length; i++) {
    for (let j = i + 1; j < ctl.length; j++) {
      const A = ctl[i]!.v, B = ctl[j]!.v;
      if (ctl[i]!.el.contains(ctl[j]!.el) || ctl[j]!.el.contains(ctl[i]!.el)) continue;
      const yo = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      const xo = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      let gap = Infinity;
      if (yo > 0.5 * Math.min(A.h, B.h)) gap = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w));
      else if (xo > 0.5 * Math.min(A.w, B.w)) gap = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
      if (gap >= 0 && gap < 4) out.push({ check: "cramped", a: desc(ctl[i]!.el), b: desc(ctl[j]!.el), ra: A, rb: B, detail: `${gap.toFixed(1)}px apart · ${layer(ctl[i]!.el)}` });
    }
  }

  // (f) floating layers (fixed, or absolute with a z-index, painted, card sized) and the docks colliding.
  const docks = [...document.querySelectorAll('header[role=banner],[role=banner],form[aria-label="Ask your agent"],aside[aria-label="Right dock"],nav[aria-label="Right dock"],nav[aria-label=Workspaces],section[aria-label="Your app"],nav[aria-label=Trips]')];
  const floats: Element[] = [...docks];
  for (const el of document.body.querySelectorAll("*")) {
    const s = cs(el);
    if (!(s.position === "fixed" || (s.position === "absolute" && s.zIndex !== "auto"))) continue;
    if (!paint(el) || !shown(el) || opacityOf(el) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 32 || r.width * r.height > 0.6 * W * H) continue;
    floats.push(el);
  }
  for (let i = 0; i < floats.length; i++) {
    for (let j = i + 1; j < floats.length; j++) {
      const a = floats[i]!, b = floats[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      if (docks.includes(a) && docks.includes(b)) continue;
      const o = isect(box(a.getBoundingClientRect()), box(b.getBoundingClientRect()));
      if (!o || o.w < 6 || o.h < 6) continue;
      out.push({ check: "floating", a: `${desc(a).slice(0, 70)} in ${layer(a)}`, b: `${desc(b).slice(0, 70)} in ${layer(b)}`, ra: box(a.getBoundingClientRect()), rb: box(b.getBoundingClientRect()), detail: `${o.w}x${o.h}px overlap` });
    }
  }

  // Sideways scroll the user did not ask for.
  if (document.documentElement.scrollWidth > W + 1) out.push({ check: "hscroll", a: "html (the whole window)", ra: { x: 0, y: 0, w: document.documentElement.scrollWidth, h: H }, detail: `${document.documentElement.scrollWidth}px wide in a ${W}px window` });
  for (const el of document.body.querySelectorAll("*")) {
    const s = cs(el);
    if (!/auto|scroll/.test(s.overflowX) || el.scrollWidth <= el.clientWidth + 2 || el.clientWidth < 40 || !shown(el)) continue;
    // What sticks out furthest, so the finding names the culprit; a table or preformatted text inside is marked as such.
    const right = el.getBoundingClientRect().left + el.clientWidth;
    let wide: Element | null = null;
    for (const d of el.querySelectorAll("*")) if (d.getBoundingClientRect().right > right + 2 && (!wide || d.getBoundingClientRect().right > wide.getBoundingClientRect().right)) wide = d;
    const kind = wide?.closest("table") || (wide && getComputedStyle(wide).whiteSpace.startsWith("pre")) || /^pre$/i.test(el.tagName) || cs(el).whiteSpace.startsWith("pre") ? " (table or code)" : "";
    out.push({ check: "hscroll", a: `${desc(el).slice(0, 90)}${kind}`, ra: box(el.getBoundingClientRect()), detail: `${el.scrollWidth}px of content in ${el.clientWidth}px; widest: ${wide ? desc(wide).slice(0, 70) : "?"} · ${layer(el)}` });
  }
  return out;
}

async function capture(app: ElectronApplication, file: string, s: Size): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }, width) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.getParentWindow())!;
    const img = await w.webContents.capturePage();
    return img.resize({ width }).toJPEG(78).toString("base64");
  }, s.w);
  writeFileSync(file, Buffer.from(b64, "base64"));
}

async function mark(win: Page, fs: Finding[]): Promise<void> {
  await win.evaluate((fs) => {
    const root = document.createElement("div");
    root.id = "__layout_audit";
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    fs.forEach((f, i) => {
      for (const [r, solid] of [[f.ra, true], [f.rb, false]] as const) {
        if (!r) continue;
        const d = document.createElement("div");
        // ponytail: debug overlay only, never product UI, so a literal red is fine here
        d.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;outline:2px ${solid ? "solid" : "dashed"} #ff0033;outline-offset:-1px`;
        if (solid) {
          const n = document.createElement("span");
          n.textContent = String(i + 1);
          n.style.cssText = "position:absolute;left:0;top:-14px;font:700 10px monospace;color:#fff;background:#ff0033;padding:0 3px";
          d.append(n);
        }
        root.append(d);
      }
    });
    document.body.append(root);
  }, fs);
}

export interface Sweep { state: string; size: Size; theme: ThemeId; shot: string; marked?: string; findings: Finding[]; allowed: (Finding & { why: string })[] }

/** One state through the size x theme matrix: a clean shot each, the checks, and a marked shot when anything is found. */
export async function sweep(app: ElectronApplication, win: Page, out: string, state: string, o: { allow?: Allow[]; only?: [Size, ThemeId][] } = {}): Promise<Sweep[]> {
  mkdirSync(out, { recursive: true });
  const res: Sweep[] = [];
  let last: Size | null = null;
  for (const [s, t] of o.only ?? matrix()) {
    if (!last || last.w !== s.w || last.h !== s.h) await setSize(app, s);
    last = s;
    await setTheme(win, t);
    const base = `${state}--${s.w}x${s.h}--${t}`;
    const shot = join(out, `${base}.jpg`);
    await capture(app, shot, s);
    const all = (await win.evaluate(pageAudit).catch((e) => [{ check: "zero", a: `audit failed: ${(e as Error).message}`, ra: { x: 0, y: 0, w: 0, h: 0 } }])) as Finding[];
    const rules = [...ALLOW, ...(o.allow ?? [])];
    const seen = new Set<string>();
    const findings: Finding[] = [];
    const ok: (Finding & { why: string })[] = [];
    for (const f of all) {
      const key = `${f.check}|${f.a}|${f.b ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = allowed(f, rules);
      if (r) ok.push({ ...f, why: r.why });
      else findings.push(f);
    }
    const sw: Sweep = { state, size: s, theme: t, shot, findings, allowed: ok };
    if (findings.length) {
      await mark(win, findings.filter((f) => f.check !== "hscroll" || f.a.startsWith("html")));
      await sleep(80);
      sw.marked = join(out, `${base}--marked.jpg`);
      await capture(app, sw.marked, s);
      await win.evaluate(() => document.getElementById("__layout_audit")?.remove());
    }
    appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(sw)}\n`);
    res.push(sw);
  }
  await setSize(app, { w: 1440, h: 900 });
  await setTheme(win, "abyss");
  return res;
}
