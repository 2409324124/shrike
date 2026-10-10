import type { TripGeometry } from "../lib/thread-layout.ts";

// Arrival motion for one trip: M1 drop (thread draws, stations appear as the tip passes), M6 coils wind,
// M2 snap sparks, M3 return line, M8 re-knit (thread draws green, then settles). Imperative on the trip's DOM.

export const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function sparks(root: HTMLElement, x: number, y: number): void {
  for (let i = 0; i < 22; i++) {
    const s = document.createElement("i");
    s.className = "th-spark";
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    root.appendChild(s);
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * 46;
    s.animate([{ transform: "translate(0,0)", opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px)`, opacity: 0 }], {
      duration: 520 + Math.random() * 300,
      easing: "cubic-bezier(.16,1,.3,1)",
    }).onfinish = () => s.remove();
  }
}

/** Plays a trip's arrival. Returns a cancel function; `done` fires once at the end (also right away under reduced motion). */
export function playTrip(root: HTMLElement, g: TripGeometry, o: { knit: boolean; failed: boolean; okColor: string; failColor: string }, done: () => void): () => void {
  const out = root.querySelector<SVGPathElement>("path.th-out");
  const ret = root.querySelector<SVGPathElement>("path.th-ret");
  const tip = root.querySelector<SVGCircleElement>("circle.th-tip");
  if (reducedMotion() || !out || !ret) {
    done();
    return () => {};
  }
  const items = [...root.querySelectorAll<HTMLElement>("[data-i]")];
  const after = [...root.querySelectorAll<HTMLElement | SVGElement>(".th-after")];
  const marks = g.stations.map((s) => s.reach);
  const forks = [...root.querySelectorAll<SVGPathElement>("path.th-fork")].map((el) => ({ el, start: Number(el.dataset.start), len: el.getTotalLength() }));
  const len = out.getTotalLength();
  const rl = ret.getTotalLength();
  const dur = o.knit ? 2000 : 1500;
  const timers: number[] = [];
  let raf = 0;
  let finished = false;

  const show = (el: HTMLElement) => {
    if (el.style.opacity !== "0") return;
    el.style.opacity = "";
    el.style.scale = "";
    if (el.classList.contains("th-coil")) el.animate([{ scale: 0.2, rotate: "-160deg", opacity: 0 }, { scale: 1, rotate: "0deg", opacity: 1 }], { duration: 600, easing: "cubic-bezier(.16,1,.3,1)" });
  };
  const reset = () => {
    items.forEach((el) => { el.style.opacity = ""; el.style.scale = ""; });
    after.forEach((el) => { el.style.opacity = ""; });
    out.style.strokeDasharray = out.style.strokeDashoffset = out.style.stroke = "";
    forks.forEach((f) => (f.el.style.strokeDasharray = f.el.style.strokeDashoffset = f.el.style.stroke = ""));
    ret.style.strokeDasharray = ret.style.strokeDashoffset = ret.style.opacity = "";
    if (tip) tip.style.opacity = "0";
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    reset();
    done();
  };

  items.forEach((el) => { el.style.opacity = "0"; if (el.classList.contains("th-st")) el.style.scale = "0.2"; });
  after.forEach((el) => { el.style.opacity = "0"; });
  out.style.strokeDasharray = `${len}`;
  out.style.strokeDashoffset = `${len}`;
  if (o.knit) out.style.stroke = o.okColor;
  forks.forEach((f) => {
    f.el.style.strokeDasharray = `${f.len}`;
    f.el.style.strokeDashoffset = `${f.len}`;
    if (o.knit) f.el.style.stroke = o.okColor;
  });
  ret.style.opacity = "0";
  if (tip) tip.style.opacity = "1";

  const t0 = performance.now();
  const frame = (now: number) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 2);
    const at = len * e;
    out.style.strokeDashoffset = `${len - at}`;
    forks.forEach((f) => (f.el.style.strokeDashoffset = `${f.len - Math.max(0, Math.min(f.len, at - f.start))}`)); // T17 branches grow alongside
    if (tip) {
      const p = out.getPointAtLength(at);
      tip.setAttribute("cx", `${p.x}`);
      tip.setAttribute("cy", `${p.y}`);
    }
    items.forEach((el) => { if (at >= (marks[Number(el.dataset.i)] ?? 0) - 1) show(el); });
    if (k < 1) {
      raf = requestAnimationFrame(frame);
      return;
    }
    if (tip) tip.style.opacity = "0";
    items.forEach(show);
    out.style.strokeDasharray = out.style.strokeDashoffset = "";
    forks.forEach((f) => (f.el.style.strokeDasharray = f.el.style.strokeDashoffset = ""));
    const snap = g.stations.find((s) => s.snap);
    if (snap) {
      sparks(root, snap.x, snap.y);
      root.querySelectorAll<HTMLElement>(".th-st.error").forEach((st) =>
        st.animate([{ boxShadow: `0 0 0 0 ${o.failColor}` }, { boxShadow: "0 0 0 26px transparent" }], { duration: 700 }),
      );
    }
    // M3: the result travels back up to SCREEN.
    ret.style.opacity = "";
    if (o.failed) ret.animate([{ opacity: 0 }, { opacity: 0.85 }], { duration: 500 });
    else {
      ret.style.strokeDasharray = `${rl}`;
      ret.animate([{ strokeDashoffset: rl }, { strokeDashoffset: 0 }], { duration: 700, easing: "ease-out" });
    }
    timers.push(window.setTimeout(() => {
      ret.style.strokeDasharray = "";
      after.forEach((el) => { el.style.opacity = ""; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); });
      if (o.knit) [out, ...forks.map((f) => f.el)].forEach((el) => (el.style.stroke = "")); // M8: settles back to the spectrum
    }, o.failed ? 450 : 700));
    timers.push(window.setTimeout(finish, o.failed ? 700 : 1000));
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    timers.forEach(clearTimeout);
    if (!finished) {
      finished = true;
      reset();
    }
  };
}
