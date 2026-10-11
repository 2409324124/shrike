import "./files.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import type { ActionView, FileNode } from "@shrike/schema";
import { motion } from "@shrike/design";
import { api } from "../lib/api.ts";
import { CODE_FG, highlight, type Token } from "../lib/highlight.ts";
import { PLACE_GLYPH, type Trip } from "../lib/thread-layout.ts";
import { useProject } from "../stores/project.ts";
import { useThread } from "../stores/thread.ts";
import { useCalm } from "../system/System.tsx";
import { isTyping } from "../hud/commands.ts";
import { inlineChips, stationEvents } from "../thread/logic.ts";
import { sparks } from "../thread/motion.ts";
import { KindGlyph } from "../thread/Thread.tsx";
import { cardsOf, fileSteps, flatRows, focusKey, layoutStrip, links, moveOf, placeKey, section, stateAt, treeLayout, type End, type FStep, type Link } from "./logic.ts";

// FV: the Thread re-drawn on the project's own folders. Planes (REPO tree pinned left, FILES cards panning in story
// order, CODE the dive) are 2D translate+scale only: nothing rotates but a folder's chevron, and the plane you read
// rests at scale 1 on whole pixels. Everything on screen is a function of the focused step, so going back is the same
// moves undone. Spec: docs/06-design.md "Files view", the prototype in ~/Desktop/shrike-map.

const LH = 19; // code line height
const CH = 24; // the value chip's row under the live line
const ROW = 22; // tree row
const GAP = 56;
const GATE = 132;
const PW = 270; // place card width
const TREE_W = 248;
const TREE_X = 14;
const RAIL = 58;

const texts = new Map<string, Promise<{ lines: string[]; tokens?: Token[][] } | null>>();
function fileText(file: string): Promise<{ lines: string[]; tokens?: Token[][] } | null> {
  let p = texts.get(file);
  if (!p) {
    p = api()
      .readFile(file)
      .then(async (t) => {
        const text = t.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
        return { lines: text.split("\n"), tokens: await highlight(file, text).catch(() => undefined) };
      })
      .catch(() => null);
    texts.set(file, p);
    setTimeout(() => texts.delete(file), 30_000); // a saved file reads fresh next time
  }
  return p;
}

const trees = new Map<string, Promise<{ total: number; nodes: FileNode[] }>>();
const treeFor = (touched: string[]) => {
  const key = touched.join("|");
  if (!trees.has(key)) trees.set(key, api().mapTree(touched).catch(() => ({ total: 0, nodes: [] })));
  return trees.get(key)!;
};

const base = (f: string) => f.split("/").pop() ?? f;
const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type Shot = "files" | "code" | "repo" | "overview";

export function FilesView({ view, trip }: { view: ActionView; trip: Trip }) {
  const k = useThread((s) => Math.min(s.focus.station, trip.stations.length - 1));
  const dived = useThread((s) => s.dived);
  const outward = useThread((s) => s.outward);
  const playing = useThread((s) => s.playing);
  const timeMode = useThread((s) => s.timeMode);
  const project = useProject((s) => s.project?.name ?? "project");
  const calm = useCalm();
  const shot: Shot = dived ? "code" : outward === 1 ? "repo" : outward === 2 ? "overview" : "files";

  const steps = useMemo(() => fileSteps(view, trip), [view, trip]);
  const cards = useMemo(() => cardsOf(steps), [steps]);
  const order = useMemo(() => [...cards.files, ...cards.places].map((c) => c.key), [cards]);
  const all = useMemo(() => links(steps, order), [steps, order]);
  const st = stateAt(steps, k);
  const cur = steps[k];
  const last = steps.length - 1;

  // stage size
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    return () => ro.disconnect();
  }, []);
  const [capH, setCapH] = useState(110); // the shell's caption sits over the stage, just above the rail
  useEffect(() => {
    const c = document.querySelector<HTMLElement>("[data-caption]");
    if (!c) return;
    const ro = new ResizeObserver(() => setCapH(c.offsetHeight));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;
  const fold = W < 640; // too narrow for the tree beside a card: the tree folds away (the path bar names the file) and Esc brings it back
  const PIN = W < 900 ? 0.74 : 0.86;
  const CARD_Y = H < 600 ? 76 : H < 720 ? 100 : 124;
  const WIN_N = clampN(Math.floor((H - RAIL - (capH - 20) - CARD_Y - 177) / LH), 5, 16); // card chrome + 4 facts is 177px: the facts stay above the caption
  const L = fold ? 16 : TREE_X + Math.round(TREE_W * PIN) + 16;
  const CW = Math.round(fold ? Math.max(260, W - 32) : Math.max(300, Math.min(W < 900 ? 440 : 500, W - L - 60)));
  const strip = useMemo(() => layoutStrip(cards, { start: 0, cw: CW, gap: GAP, gate: GATE, pw: PW }), [cards, CW]);

  // the tree slice (main lists the project and counts every folder; only this trip's route comes back)
  const touched = useMemo(() => [...new Set(steps.flatMap((s) => [s.file, s.enter?.file]).filter((f): f is string => !!f))].sort(), [steps]);
  const [tree, setTree] = useState<{ total: number; nodes: FileNode[] } | null>(null);
  useEffect(() => {
    let live = true;
    void treeFor(touched).then((t) => live && setTree(t));
    return () => void (live = false);
  }, [touched.join("|")]);
  const rows = useMemo(() => flatRows(tree?.nodes ?? [], project), [tree, project]);
  const [opened, setOpened] = useState<Set<string>>(new Set()); // folders the user opened by hand
  useEffect(() => setOpened(new Set()), [view.id]);
  const openKey = [...st.open].join("|");
  const open = useMemo(() => new Set([...st.open, ...opened]), [openKey, opened]);
  const tl = useMemo(() => treeLayout(rows, open, ROW), [rows, open]);

  // code for each card
  const [code, setCode] = useState<Record<string, { lines: string[]; tokens?: Token[][] } | null>>({});
  useEffect(() => {
    let live = true;
    for (const c of cards.files) if (!(c.key in code) && !/(^|\/)\.env(\.|$)/.test(c.key)) void fileText(c.key).then((t) => live && setCode((m) => ({ ...m, [c.key]: t })));
    return () => void (live = false);
  }, [cards]);

  // the move: direction-aware delays (forward opens folders, then pans, then lights the line; back undoes it in reverse)
  const prev = useRef(k);
  const dragging = useRef(false);
  const glow = typeof document !== "undefined" && document.documentElement.dataset.glow !== "off";
  const vars = useMemo(() => {
    const from = prev.current;
    const m = moveOf(steps, order, from, k, motion.hop);
    const f = dragging.current ? 0.35 : 1;
    const P = m.pan * f;
    const v =
      calm ? { dt: 0, td: 0, dp: 0, pd: 0, dc: 0, dl: 0 }
      : m.dir > 0 ? { dt: 0, td: 180 * f, dp: 120 * f, pd: P || motion.base, dc: 200 * f, dl: P ? 120 + P * 0.7 : 60 }
      : { dt: P * 0.55, td: 180 * f, dp: 90 * f, pd: P || motion.base, dc: 0, dl: P ? P * 0.6 : 40 };
    return { m, v };
  }, [k, steps, order, calm]);
  useEffect(() => void (prev.current = k), [k]);

  // camera
  const fk = st.focus;
  const center = (key?: string) => (key ? (strip.x[key] ?? 0) + (key.startsWith("place:") ? PW / 2 : CW / 2) : CW / 2);
  const cc = Math.round(L + (W - L) / 2);
  const ay = CARD_Y + 180;
  let cam = { tx: cc - center(fk), ty: 0, k: 1, fo: 1, fb: 0, rx: TREE_X, ry: CARD_Y, rk: PIN, ro: 1, rb: 0 };
  if (shot === "code") cam = { ...cam, k: 1.06, tx: Math.round(cc - 1.06 * center(fk)), ty: Math.round(ay - 1.06 * ay), fo: 0.2, fb: 1.6, ro: 0.5, rk: PIN * 0.95, rb: 0.6 };
  else if (shot === "repo") cam = { ...cam, rk: 1, rx: TREE_X + 4, ry: CARD_Y - 4, k: 0.84, tx: Math.round(cc + 60 - 0.84 * center(fk)), ty: Math.round(ay - 0.84 * ay), fo: 0.3, fb: 1.2 };
  else if (shot === "overview") {
    const kk = Math.min(1, (W - L - 40) / Math.max(1, strip.end));
    cam = { ...cam, k: kk, tx: Math.round(L + 20), ty: Math.round(ay - kk * ay) };
  }
  if (fold && shot !== "repo") cam = { ...cam, rx: -TREE_W - 40, ro: 0 };
  const maskL = fold && shot !== "repo" ? -80 : Math.round(cam.rx + TREE_W * cam.rk - 10);
  if (shot === "files" && !fold) cam.tx = Math.max(Math.min(cam.tx, L + 24), fk ? maskL + 60 - (strip.x[fk] ?? 0) : -Infinity); // a narrow stage: the focused card clears the tree's fade
  cam.tx = Math.round(cam.tx);
  const style = {
    "--d-tree": `${vars.v.dt}ms`, "--tree-dur": `${vars.v.td}ms`, "--d-pan": `${vars.v.dp}ms`, "--pan-dur": `${vars.v.pd}ms`,
    "--d-card": `${vars.v.dc}ms`, "--d-live": `${vars.v.dl}ms`, "--cam-dur": `${calm ? 0 : shot === "overview" ? motion.camera : 450}ms`, "--mask-l": `${maskL}px`,
  } as CSSProperties;

  // Home / End and Space while playing: the rest of the keys are the shell's (hud/commands.ts)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      useThread.getState().setPlaying(false);
      useThread.getState().setFocus(view.id, e.key === "Home" ? 0 : last);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.id, last]);
  useEffect(() => {
    if (!playing) return;
    const th = useThread.getState();
    if (th.focus.station >= last) th.setFocus(view.id, 0);
    const t = setInterval(() => {
      const s = useThread.getState();
      if (s.focus.station >= last) return s.setPlaying(false);
      s.setFocus(view.id, s.focus.station + 1);
      useThread.setState({ playing: true });
    }, 1700);
    return () => clearInterval(t);
  }, [playing, view.id, last]);

  const go = (i: number) => {
    useThread.getState().setPlaying(false);
    if (i >= 0) useThread.getState().setFocus(view.id, clampN(i, 0, last));
  };

  // connectors: drawn from the DOM every frame while things move, so they stay glued to lines mid-pan
  const svg = useRef<SVGSVGElement>(null);
  const fiber = useRef<SVGPathElement>(null);
  const comet = useRef<SVGCircleElement>(null);
  const prog = useRef(new Map<number, { p: number; from: number; to: number; t0: number; dur: number }>());
  useLayoutEffect(() => {
    const root = stage.current;
    const g = svg.current;
    if (!root || !g || !W) return;
    const now = performance.now();
    const { m, v } = vars;
    const drawDur = calm ? 1 : Math.max(380, m.pan);
    let cometAt = -1;
    all.forEach((l, i) => {
      const q = prog.current.get(i) ?? { p: 0, from: 0, to: 0, t0: 0, dur: 1 };
      const to = l.j <= k ? 1 : 0;
      if (q.to !== to) {
        Object.assign(q, { from: q.p, to, t0: now + (to && l.j === k ? v.dl : 0), dur: calm ? 1 : to && l.j === k ? drawDur : 200 });
        if (to && l.j === k) cometAt = i;
      }
      if (calm || dragging.current) Object.assign(q, { p: to, from: to, dur: 1 });
      prog.current.set(i, q);
    });
    const snap = steps[k]?.snap && m.dir > 0 && prev.current !== k;
    let raf = 0;
    const until = now + (calm ? 50 : 2200);
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    let sparked = false;
    const frame = () => {
      const t = performance.now();
      const sr = root.getBoundingClientRect();
      const paths = g.querySelectorAll<SVGPathElement>("path.fm-link");
      let cp: DOMPoint | null = null;
      all.forEach((l, i) => {
        const el = paths[i];
        const q = prog.current.get(i)!;
        q.p = t < q.t0 ? q.from : t >= q.t0 + q.dur ? q.to : q.from + (q.to - q.from) * ease((t - q.t0) / q.dur);
        if (!el) return;
        if (q.p <= 0.001) return el.setAttribute("d", "");
        const a = anchor(root, sr, l.from, l.ret ? "B" : "R");
        const b = anchor(root, sr, l.to, l.ret ? "B" : "L");
        if (!a || !b) return el.setAttribute("d", "");
        el.setAttribute("d", l.ret ? under(a, b, Math.max(0, all.filter((x) => x.ret && x.j < l.j).length)) : orth(a, b));
        const len = el.getTotalLength();
        el.setAttribute("stroke-dasharray", l.ret && q.p >= 0.999 ? "6 6" : `${len * q.p} ${len + 20}`);
        if (i === cometAt && t >= q.t0 && t < q.t0 + q.dur) cp = el.getPointAtLength(len * q.p);
      });
      const c = comet.current;
      if (c) cp && !calm ? (c.setAttribute("cx", String((cp as DOMPoint).x)), c.setAttribute("cy", String((cp as DOMPoint).y)), c.setAttribute("opacity", "1")) : c.setAttribute("opacity", "0");
      // the depth fiber: lit tree row to the live line in its card
      const fe = fiber.current;
      const hotRow = root.querySelector<HTMLElement>(".fm-row.hot .nm");
      const hotFile = steps[k]?.file;
      if (fe && hotRow && hotFile && shot === "files" && !fold &&!steps[k]?.place && t > now + v.dl) {
        const tv = root.querySelector(".fm-tvp")!.getBoundingClientRect();
        const nr = hotRow.getBoundingClientRect();
        const tr = root.querySelector(".fm-tree")!.getBoundingClientRect();
        const a = { x: tr.right - sr.left, y: clampN(nr.top + nr.height / 2, tv.top, tv.bottom) - sr.top };
        const b = anchor(root, sr, { key: hotFile, line: steps[k]?.line }, "L");
        if (b) {
          fe.setAttribute("d", `M ${a.x} ${a.y} C ${(a.x + b.x) / 2} ${a.y}, ${(a.x + b.x) / 2} ${b.y}, ${b.x} ${b.y}`);
          const len = fe.getTotalLength();
          const fp = calm ? 1 : clampN((t - now - v.dl) / 300, 0, 1);
          fe.setAttribute("stroke-dasharray", `${len * fp} ${len + 20}`);
        }
      } else fe?.setAttribute("d", "");
      if (snap && !sparked && !calm && t > now + v.dl + drawDur) {
        sparked = true;
        const pl = root.querySelector<HTMLElement>(".fm-place.focus");
        if (pl) {
          const r = pl.getBoundingClientRect();
          sparks(root, r.left - sr.left, r.top - sr.top + 44);
        }
      }
      if (t < until) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [k, shot, W, H, all, code, tree, calm, fold]);

  // tree: auto-scroll so the hot row stays in view
  const TVH = Math.max(200, Math.round((H - CARD_Y - 210) / PIN) - 34);
  const vh = Math.min(TVH, tl.height + 8);
  const hotIdx = rows.findIndex((r) => r.node.path === st.hot);
  const hy = hotIdx >= 0 ? tl.y[hotIdx]! : 0;
  const off = tl.height <= vh ? 0 : Math.max(vh - tl.height - 8, Math.min(0, Math.round(vh * 0.42 - hy)));
  const rowY = (p: string) => tl.y[rows.findIndex((r) => r.node.path === p)] ?? 0;
  const rail = (d: number) => 10 + d * 14 + 6;
  const trailTo = (f: string) => {
    const parts = f.split("/");
    let d = `M ${rail(0)} 11`;
    for (let i = 1; i < parts.length; i++) d += ` V ${rowY(parts.slice(0, i).join("/")) + 11} H ${rail(i)}`;
    return `${d} V ${rowY(f) + 11} H ${10 + parts.length * 14 + 12}`;
  };
  const stopNo = new Map(cards.files.map((c, i) => [c.key, i + 1]));

  // what to say
  const crumbParts = cur?.place ? [project, "outside your project", cur.place.name.split(" · ")[0]!] : cur?.file ? [project, ...cur.file.split("/")] : [project];
  const fnText = cur ? `${cur.label}${cur.file && !cur.place ? ` L${cur.line}` : ""}` : "";
  const broke = steps.slice(0, k + 1).some((s) => s.snap);
  const frames = cur?.stack ?? [];
  const shown = frames.length > 4 ? [frames[0]!, null, ...frames.slice(-3)] : frames;

  return (
    <div
      ref={stage}
      className={`fm${calm ? " calm" : ""}${shot === "overview" ? " overview" : ""}${playing ? " playing" : ""}${timeMode ? " timev" : ""}`}
      style={style}
      role="region"
      aria-label="Files view. Left and right step through the trip, both ways. Enter dives, Escape surfaces. V goes back to the Thread."
    >
      <div className="fm-ground" style={{ transform: `translate(${Math.round((cam.tx % 22) * 0.35)}px,0)` }} />
      {W > 0 && (
        <>
          <div className="fm-clip">
            <div className="fm-plane fm-files" style={{ transform: `translate(${cam.tx}px,${cam.ty}px) scale(${cam.k})`, opacity: cam.fo, filter: cam.fb && glow && !calm ? `blur(${cam.fb}px)` : "none" }}>
              {strip.gates.map((g) => (
                <div key={g.label + g.x} className={`fm-gate${k >= g.first ? "" : " gone"}`} style={{ left: g.x, top: CARD_Y - 26, height: WIN_N * LH + CH + 190 }}>
                  <span>{g.label}</span>
                </div>
              ))}
              {cards.files.map((c, ci) => (
                <FileCard
                  key={c.key}
                  file={c.key}
                  steps={steps}
                  k={k}
                  first={c.first}
                  x={strip.x[c.key]!}
                  y={CARD_Y}
                  w={CW}
                  winN={WIN_N}
                  focused={fk === c.key}
                  near={Math.abs(ci - Math.max(0, cards.files.findIndex((x) => x.key === fk))) <= 2 || shot === "overview"}
                  code={code[c.key]}
                  view={view}
                  onPick={(i) => (i === k ? useThread.getState().dive() : go(i))}
                />
              ))}
              {cards.places.map((c) => {
                const v = [...steps.slice(0, k + 1)].reverse().find((s) => s.place && placeKey(s.place) === c.key) ?? steps[c.first]!;
                const e = stationEvents(view, trip.stations[v.i]!.stepIndex).event;
                return (
                  <div
                    key={c.key}
                    data-key={c.key}
                    className={`fm-place${k >= c.first ? "" : " gone"}${fk === c.key ? " focus" : k > c.first ? " dim" : ""}${v.err ? " err" : ""}`}
                    style={{ left: strip.x[c.key], top: CARD_Y + 70 + strip.placeY[c.key]! * 190 }}
                    onClick={() => go(v.i)}
                  >
                    <div className="h">
                      <KindGlyph d={PLACE_GLYPH[c.place!.kind as keyof typeof PLACE_GLYPH] ?? PLACE_GLYPH.outside} />
                      <b>{c.place!.name.split(" · ")[0]}</b>
                      {c.place!.detail && <small>{c.place!.detail}</small>}
                    </div>
                    <pre>{e?.db?.statement ?? v.label}{e?.db?.params ? `\n← ${e.db.params}` : ""}</pre>
                    {v.err && v.chip && <span className="fm-chip err">refused: {v.chip}</span>}
                    {trip.stations[v.i]?.opaque && <small className="weak">Shrike can't see inside</small>}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="fm-plane fm-repo" style={{ transform: `translate(${cam.rx}px,${cam.ry}px) scale(${cam.rk})`, opacity: cam.ro, filter: cam.rb && glow && !calm ? `blur(${cam.rb}px)` : "none" }}>
            <div className="fm-tree">
              <div className="th">
                <b>EXPLORER</b>
                <span className="sp" />
                <span>{tree ? `${tree.total.toLocaleString("en-US")} FILES` : "READING…"}</span>
              </div>
              <div className="fm-tvp" role="tree" aria-label="Project folders" style={{ height: vh }}>
                <div className="fm-tin" style={{ transform: `translateY(${off}px)` }}>
                  {rows.map((r, i) => {
                    const n = r.node;
                    const isOpen = n.dir && open.has(n.path) && !!n.children;
                    const ran = !n.dir && st.ran.has(n.path);
                    const failed = !n.dir && st.failed.has(n.path);
                    const failedIn = n.dir && r.depth > 0 && [...st.failed].some((f) => f.startsWith(`${n.path}/`));
                    const inside = n.dir && r.depth > 0 && !isOpen ? touched.filter((f) => f.startsWith(`${n.path}/`)) : [];
                    const hot = !n.dir && n.path === st.hot;
                    return (
                      <div
                        key={n.path || "/"}
                        role="treeitem"
                        aria-expanded={n.dir ? isOpen : undefined}
                        aria-selected={hot || undefined}
                        className={`fm-row${n.dir ? " dir" : ""}${n.ignored ? " ign" : ""}${n.fold ? " fold" : ""}${r.depth === 0 ? " root" : ""}${ran ? " ran" : ""}${hot ? " hot" : ""}${failed || (hot && cur?.err) ? " err" : ""}${failedIn ? " errp" : ""}${isOpen ? " open" : ""}${tl.shown[i] ? "" : " hid"}`}
                        style={{ transform: `translateY(${tl.y[i]}px)`, paddingLeft: 10 + r.depth * 14, transitionDelay: `calc(var(--d-tree) + ${Math.min(18, 300 / Math.max(1, rows.length)) * i | 0}ms)` }}
                        title={n.path}
                        onClick={() => {
                          if (n.dir && r.depth > 0 && n.children) setOpened((o) => (o.has(n.path) ? new Set([...o].filter((x) => x !== n.path)) : new Set(o).add(n.path)));
                          else if (!n.dir && !n.fold) go(steps.findIndex((s) => s.file === n.path || s.enter?.file === n.path));
                        }}
                      >
                        {r.anc.slice(1).map((_, j) => <span key={j} className="g" style={{ left: 10 + (j + 1) * 14 - 8 }} />)}
                        {n.dir && !n.fold ? (
                          <svg className="cv" viewBox="0 0 12 12" aria-hidden>
                            <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <span className="cvs" />
                        )}
                        <span className="nm">{n.name}</span>
                        {n.dir && !n.ignored && r.depth > 0 && n.count !== undefined && <span className="cnt">{n.count.toLocaleString("en-US")}</span>}
                        <span className="st">
                          {ran && stopNo.has(n.path) && <span className="num">{stopNo.get(n.path)}</span>}
                          {failed ? <Cross /> : ran ? <span className="sdot" /> : null}
                          {inside.length > 0 && <span className={`badge${failedIn ? " err" : inside.some((f) => st.ran.has(f)) ? " lit" : ""}`}>{inside.length}</span>}
                          {n.dir && isOpen && failedIn && <Cross />}
                        </span>
                        <span className="brk"><i /><i /><i /><i /></span>
                      </div>
                    );
                  })}
                  <svg className="fm-tsvg" width={TREE_W} height={Math.max(10, tl.height)} aria-hidden>
                    {[...st.ran].filter((f) => f !== st.hot && rows.some((r) => r.node.path === f)).map((f) => <path key={f} className={`burn${st.failed.has(f) ? " err" : ""}`} d={trailTo(f)} />)}
                    {st.hot && rows.some((r) => r.node.path === st.hot) && <path key={`${st.hot}|${open.size}`} className={`trail${cur?.err ? " err" : ""}`} d={trailTo(st.hot)} pathLength={1} />}
                  </svg>
                </div>
              </div>
            </div>
          </div>

          <div className="fm-ovclip" style={{ opacity: shot === "code" || shot === "repo" ? 0.18 : 1 }}>
            <svg ref={svg} className="fm-ov" aria-hidden>
              <defs>
                <linearGradient id="fm-spec" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
                  <stop offset="0" stopColor="var(--violet)" />
                  <stop offset=".45" stopColor="var(--blue)" />
                  <stop offset="1" stopColor="var(--cyan)" />
                </linearGradient>
                <radialGradient id="fm-comet">
                  <stop offset="0" stopColor="var(--core)" />
                  <stop offset=".6" stopColor="var(--cyan)" stopOpacity=".6" />
                  <stop offset="1" stopColor="var(--cyan)" stopOpacity="0" />
                </radialGradient>
              </defs>
              {all.map((l: Link, i) => (
                <path key={i} className={`fm-link${l.ret ? " ret" : ""}${l.from.key !== fk && l.to.key !== fk ? " far" : ""}`} fill="none" stroke={l.err || l.ret ? "var(--fail)" : "url(#fm-spec)"} strokeWidth={l.ret ? 1.8 : 2.4} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              <circle ref={comet} r="9" fill="url(#fm-comet)" opacity="0" />
            </svg>
          </div>
          <svg className="fm-ov top" aria-hidden>
            <path ref={fiber} fill="none" stroke={cur?.err ? "var(--fail)" : "var(--cyan)"} strokeWidth="1.4" opacity=".85" />
          </svg>

          {shot === "code" && cur?.file && <Dive key={`${cur.file}:${k}`} step={cur} view={view} trip={trip} left={fold ? 16 : Math.round(Math.max(L - 40, cc - Math.min(660, W * 0.62) / 2))} top={CARD_Y - 14} width={fold ? W - 32 : Math.round(Math.min(660, W * 0.62))} maxH={H - CARD_Y - RAIL - 120} />}

          <div className="fm-hud">
            <div className={`crumb${cur?.err ? " err" : ""}`}>
              {crumbParts.map((p, i) => (
                <span key={i}>
                  {i > 0 && <span className="sep">›</span>}
                  {i === crumbParts.length - 1 ? <b>{p}</b> : p}
                </span>
              ))}
              {cur && (
                <>
                  <span className="sep">›</span>
                  <span className="fnc">{fnText}</span>
                </>
              )}
              <span className="count">
                {project} · <b>{tree ? tree.total.toLocaleString("en-US") : "…"}</b> files · <b>{st.ran.size}</b> ran{broke && <> · <span className="bk">broke</span></>}
              </span>
            </div>
            <div className="stack">
              <span className="k">CALL STACK</span>
              {shown.map((f, i) =>
                f ? (
                  <span key={f.id} className="frw">
                    {i > 0 && <span className="a">›</span>}
                    <button type="button" className={`fr${i === shown.length - 1 ? " cur" : ""}${i === shown.length - 1 && cur?.err ? " err" : ""}`} disabled={f.station < 0} onClick={() => go(f.station)} title={f.station >= 0 ? `Go to step ${f.station + 1}` : undefined}>
                      <b>{f.label}</b> {f.at}
                    </button>
                  </span>
                ) : (
                  <span key="more" className="a">› +{frames.length - 4} ›</span>
                ),
              )}
              {cur && cur.gone.length > 0 && (
                <>
                  <span className="a">returned from</span>
                  {cur.gone.map((f) => (
                    <button key={f.id} type="button" className="fr gone" onClick={() => go(f.station)} disabled={f.station < 0}>
                      <b>{f.label}</b> {f.at}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <Rail steps={steps} k={k} timeMode={timeMode} onGo={go} onDrag={(on) => (dragging.current = on)} />
          <p className="th-sr" aria-live="polite">
            {cur ? `Step ${k + 1} of ${steps.length}, ${cur.label}${cur.file ? ` in ${cur.file}, line ${cur.line}` : ""}${cur.err ? ", failed" : ""}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function Cross() {
  return (
    <svg className="sx" viewBox="0 0 10 10" aria-label="failed">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

type Pt = { x: number; y: number };

function anchor(root: HTMLElement, sr: DOMRect, e: End, side: "L" | "R" | "B"): Pt | null {
  const card = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(e.key)}"]`);
  if (!card) return null;
  const c = card.getBoundingClientRect();
  if (side === "B") return { x: c.left + c.width / 2 - sr.left, y: c.bottom - sr.top };
  const x = (side === "L" ? c.left : c.right) - sr.left;
  if (e.key.startsWith("place:")) return { x, y: c.top + 44 - sr.top };
  const win = card.querySelector(".fm-win")?.getBoundingClientRect() ?? c;
  const ln = e.line ? card.querySelector(`.fm-ln[data-l="${e.line}"]`)?.getBoundingClientRect() : undefined;
  const y = ln ? clampN(ln.top + ln.height / 2, win.top + 6, win.bottom - 6) : win.top + win.height / 2;
  return { x, y: y - sr.top };
}

function orth(a: Pt, b: Pt, r = 10): string {
  if (Math.abs(a.y - b.y) < 1.5) return `M ${a.x} ${a.y} H ${b.x}`;
  const mx = (a.x + b.x) / 2;
  const dy = Math.sign(b.y - a.y);
  const rr = Math.min(r, Math.abs(b.y - a.y) / 2, Math.abs(mx - a.x));
  return `M ${a.x} ${a.y} H ${mx - rr} Q ${mx} ${a.y} ${mx} ${a.y + dy * rr} V ${b.y - dy * rr} Q ${mx} ${b.y} ${mx + rr} ${b.y} H ${b.x}`;
}

function under(a: Pt, b: Pt, depth: number): string {
  const y = Math.max(a.y, b.y) + 30 + depth * 14;
  return `M ${a.x} ${a.y} V ${y - 10} Q ${a.x} ${y} ${a.x - 10} ${y} H ${b.x + 10} Q ${b.x} ${y} ${b.x} ${y - 10} V ${b.y}`;
}

/** MAP2: one file of the trip. Its window scrolls to the live line; the lines that ran are banded; the value sits under its line. */
function FileCard(p: { file: string; steps: FStep[]; k: number; first: number; x: number; y: number; w: number; winN: number; focused: boolean; near: boolean; code: { lines: string[]; tokens?: Token[][] } | null | undefined; view: ActionView; onPick(i: number): void }) {
  const { file, steps, k, winN } = p;
  // the visit this card shows: the latest step at or before k that lit it, else its first
  const at = (s: FStep) => s.file === file || s.enter?.file === file;
  const v = [...steps.slice(0, k + 1)].reverse().find(at) ?? steps[p.first]!;
  const entering = v.file !== file; // the step entered this file's function; its own call site is elsewhere
  const live = entering ? v.enter!.line : v.line!;
  const lines = p.code?.lines ?? [];
  const sec = v.weak === "Used here" ? { start: live, end: live, weak: true } : section(lines.length ? lines : [""], live, entering ? v.enter!.line : v.def);
  const chip = !entering && v.chip ? v.chip : undefined;
  const winH = winN * LH + CH;
  const win = Math.max(1, Math.max(live - winN + 3, Math.min(sec.start - 1, live - 2)));
  const n = Math.max(1, lines.length);
  const from = Math.max(1, Math.min(win, sec.start) - 4);
  const to = Math.min(n, Math.max(win + winN + 4, sec.end + 2));
  const secret = /(^|\/)\.env(\.|$)/.test(file);
  const pl = winH / n;
  const visits = steps.slice(0, k + 1).filter(at);
  const bands = [...new Map(visits.map((s) => {
    const l = s.file === file ? s.line! : s.enter!.line;
    const b = s.weak === "Used here" ? { start: l, end: l } : section(lines.length ? lines : [""], l, s.file === file ? s.def : s.enter!.line);
    return [`${b.start}-${b.end}`, { ...b, cur: s.i === v.i, err: s.err }] as const;
  })).values()];
  const dir = file.slice(0, file.lastIndexOf("/") + 1);
  const shown = k >= p.first;
  return (
    <div
      data-key={file}
      className={`fm-card${shown ? "" : " gone"}${p.focused ? " focus" : shown ? " dim" : ""}${p.focused && v.err ? " err" : ""}`}
      style={{ left: p.x, top: p.y, width: p.w }}
      onClick={() => p.onPick(v.i)}
      onDoubleClick={() => useThread.getState().dive()}
    >
      <div className="ch">
        <i />
        <i />
        <i />
        <b title={file}>
          <u>{dir}</u>
          {file.slice(dir.length)}
        </b>
        <span className="lane">{v.lane}</span>
        <span className="fnms">
          <b>{v.label}</b> · {v.ms < 1 && v.ms > 0 ? v.ms.toFixed(1) : Math.round(v.ms)}ms
        </span>
      </div>
      <div className="cb">
        <div className="mm" style={{ height: winH }}>
          <div className="bars">
            {lines.length <= 800 &&
              lines.map((t, i) => {
                const ind = t.match(/^\s*/)![0].length;
                const len = t.trim().length;
                return len ? <i key={i} style={{ top: +(i * pl).toFixed(1), left: Math.min(ind, 12) * 0.9, width: Math.max(2, Math.min(17 - Math.min(ind, 12) * 0.9, len * 0.3)) }} /> : null;
              })}
          </div>
          {bands.map((b) => <div key={`${b.start}-${b.end}`} className={`band${b.cur ? " cur" : ""}${b.err ? " err" : ""}`} style={{ top: (b.start - 1) * pl, height: Math.max(3, (b.end - b.start + 1) * pl) }} />)}
          <div className="vp" style={{ transform: `translateY(${((win - 1) * pl).toFixed(1)}px)`, height: Math.min(winH, winN * pl) }} />
        </div>
        <div className="fm-win" style={{ height: winH }}>
          {secret ? (
            <div className="none">Hidden: this file holds secrets</div>
          ) : p.code === null ? (
            <div className="none">This file is gone</div>
          ) : !p.code ? (
            <div className="none">Reading…</div>
          ) : (
            <div className="lines" style={{ transform: `translateY(${-(win - 1) * LH}px)` }}>
              <div className={`secband${v.err ? " err" : ""}${sec.weak ? " weak" : ""}`} style={{ transform: `translateY(${(sec.start - 1) * LH}px)`, height: (sec.end - sec.start + 1) * LH + (chip && live >= sec.start && live <= sec.end ? CH : 0) }} />
              <div className={`livebar${v.err && !entering ? " err" : ""}`} style={{ transform: `translateY(${(live - 1) * LH}px)` }} />
              {p.near &&
                Array.from({ length: to - from + 1 }, (_, j) => from + j).map((i) => {
                  const toks = p.code!.tokens?.[i - 1];
                  return (
                    <div key={i} data-l={i} className={`fm-ln${i < sec.start || i > sec.end ? " out" : ""}${i === live ? " lv" : ""}`} style={{ transform: `translateY(${(i - 1) * LH + (chip && i > live ? CH : 0)}px)` }}>
                      <i>{i}</i>
                      <span>{toks ? toks.map((t, q) => <span key={q} style={{ color: t.color }}>{t.content}</span>) : <span style={{ color: CODE_FG }}>{lines[i - 1] || " "}</span>}</span>
                    </div>
                  );
                })}
              {chip && (
                <div className="vchip" style={{ transform: `translateY(${live * LH + 1}px)` }}>
                  <span className={`fm-chip${v.chipError || (v.err && v.kind !== "function") ? " err" : ""}${v.kind === "log" ? " log" : ""}`} title={chip}>{chip}</span>
                </div>
              )}
              {(v.weak || sec.weak) && !entering && <span className="tagw" style={{ transform: `translateY(${(live - 1) * LH + 2}px)` }}>{(v.weak ?? "Roughly here").toUpperCase()}</span>}
            </div>
          )}
        </div>
      </div>
      <dl className="facts">
        {v.facts.slice(0, 4).map((f) => (
          <div key={f.k} className="fr2">
            <dt>{f.k}</dt>
            <dd className={f.err ? "err" : ""} title={f.v}>{f.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** MAP3: Enter lifts the section that ran to the reading plane, with every value inline. */
function Dive({ step, view, trip, left, top, width, maxH }: { step: FStep; view: ActionView; trip: Trip; left: number; top: number; width: number; maxH: number }) {
  const [code, setCode] = useState<{ lines: string[]; tokens?: Token[][] } | null | undefined>();
  useEffect(() => void fileText(step.file!).then(setCode), [step.file]);
  const secret = /(^|\/)\.env(\.|$)/.test(step.file!);
  const sec = code ? section(code.lines, step.line!, step.def) : null;
  const a = sec ? Math.max(1, sec.start - 1) : 0;
  const b = sec && code ? Math.min(code.lines.length, sec.end + 1, a + 60) : 0;
  const { event, events } = stationEvents(view, trip.stations[step.i]!.stepIndex);
  const chips = sec && event ? inlineChips(events, event, step.file!, a, b) : null;
  return (
    <div className={`fm-dive${step.err ? " err" : ""}`} style={{ left, top, width, maxHeight: maxH }} role="region" aria-label={`Code for ${step.label}`}>
      <div className="ch">
        <i />
        <i />
        <i />
        <b>{step.file}</b>
        <span className="lane">{step.lane}</span>
        <span className="keys">E OPEN FILE · ESC BACK</span>
      </div>
      {secret ? (
        <div className="none">Hidden: this file holds secrets</div>
      ) : code === null ? (
        <div className="none">This file is gone</div>
      ) : !code || !sec ? (
        <div className="none">Reading…</div>
      ) : (
        <pre>
          {Array.from({ length: b - a + 1 }, (_, j) => a + j).map((i) => {
            const toks = code.tokens?.[i - 1];
            return (
              <div key={i}>
                <div className={`dl${i === step.line ? ` live${step.err ? " err" : ""}` : ""}${i < sec.start || i > sec.end ? " ctx" : ""}`}>
                  <i>{i}</i>
                  <span>{toks ? toks.map((t, q) => <span key={q} style={{ color: t.color }}>{t.content}</span>) : code.lines[i - 1] || " "}</span>
                </div>
                {chips?.get(i)?.map((c) => (
                  <div key={c.text} className="dl">
                    <i />
                    <span className="inl">
                      <span className={`fm-chip${c.error ? " err" : ""}`}>{c.text}</span>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </pre>
      )}
      <dl className="facts">
        {step.facts.map((f) => (
          <div key={f.k} className="fr2">
            <dt>{f.k}</dt>
            <dd className={f.err ? "err" : ""}>{f.v}</dd>
          </div>
        ))}
      </dl>
      <div className="why">{step.caption}</div>
    </div>
  );
}

/** MAP14: the steps as a scrubber. Click a tick, drag both ways; segments name the file each run of steps sat in. */
function Rail({ steps, k, timeMode, onGo, onDrag }: { steps: FStep[]; k: number; timeMode: boolean; onGo(i: number): void; onDrag(on: boolean): void }) {
  const track = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = steps.length;
  const cum = steps.reduce<number[]>((a, s) => (a.push((a.at(-1) ?? 0) + Math.max(0, s.ms)), a), []);
  const total = cum.at(-1) || 1;
  const xOf = (i: number) => (n < 2 ? 0 : timeMode ? (i === 0 ? 0 : (0.06 + 0.94 * Math.sqrt(cum[i - 1]! / total)) * w) : (i / (n - 1)) * w);
  const nearest = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xOf(i) - (clientX - r.left)) < Math.abs(xOf(best) - (clientX - r.left))) best = i;
    return best;
  };
  const drag = useRef(false);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    drag.current = true;
    onDrag(true);
    onGo(nearest(e.clientX));
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const i = nearest(e.clientX);
    if (i !== k) onGo(i);
  };
  const up = () => {
    drag.current = false;
    onDrag(false);
  };
  const segs: { a: number; b: number; label: string }[] = [];
  for (let i = 0; i < n; ) {
    const key = focusKey(steps, i) ?? "";
    let j = i;
    while (j + 1 < n && (focusKey(steps, j + 1) ?? "") === key) j++;
    segs.push({ a: i, b: j, label: key.startsWith("place:") ? (steps[i]!.place?.name.split(" · ")[0] ?? "") : base(key) });
    i = j + 1;
  }
  // A long trip has more segments than room: a label shows only where it fits beside its neighbours (the current one always does).
  const span = (g: (typeof segs)[number]) => {
    const mid = (xOf(g.a) + xOf(g.b)) / 2;
    const w = g.label.length * 6.6 + 10;
    return [mid - w / 2, mid + w / 2] as const;
  };
  const cur = segs.find((g) => k >= g.a && k <= g.b);
  let right = -Infinity;
  const shown = new Set(cur ? [cur] : []);
  for (const g of segs) {
    const [l, r] = span(g);
    if (g === cur || l < right || (cur && l < span(cur)[1] && r > span(cur)[0])) continue;
    shown.add(g);
    right = r;
  }
  return (
    <div
      className="fm-rail"
      role="slider"
      tabIndex={-1}
      aria-label="Trip steps"
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={k + 1}
      aria-valuetext={`Step ${k + 1}: ${steps[k]?.label ?? ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <div ref={track} className="track">
        <div className="fill" style={{ width: xOf(k) }} />
        {steps.map((s, i) => (
          <div key={i} className={`tk${i <= k ? " done" : ""}${i <= k && s.err && s.snap ? " err" : ""}${s.place ? " pl" : ""}`} style={{ left: xOf(i) }} title={`${i + 1}. ${s.label}${s.file ? ` · ${base(s.file)}:${s.line}` : ""}`} />
        ))}
        {segs.filter((g) => shown.has(g)).map((g) => (
          <div key={g.a} className={`seglbl${k >= g.a && k <= g.b ? " cur" : ""}${k >= g.a && k <= g.b && steps[k]?.err ? " err" : ""}`} style={{ left: (xOf(g.a) + xOf(g.b)) / 2 }}>
            {g.label}
          </div>
        ))}
        {timeMode && steps.map((s, i) => (i === 0 || i === n - 1 || xOf(i) - xOf(i - 1) > 38 ? <div key={`t${i}`} className="tms" style={{ left: xOf(i) }}>{Math.round(cum[i]!)}ms</div> : null))}
        <div className={`knob${steps[k]?.err ? " err" : ""}`} style={{ left: xOf(k) }} />
      </div>
    </div>
  );
}
