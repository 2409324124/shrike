import "./options.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pin, X } from "lucide-react";
import type { OptionCard, OptionsSession } from "@shrike/schema";
import { cssColor as color } from "@shrike/design";
import { cx, IconButton, Spinner } from "../components/ui.tsx";
import { useAgent } from "../stores/agent.ts";
import { useUi } from "../stores/ui.ts";
import { approvedCards, approvedOf, fitScale, joinCards, MOCKUP_SANDBOX, mockupDoc, stepIndex, trail, VIEW_WIDTH, workingLine } from "./logic.ts";
import { liveSession, useOptions, useOptionsBridge, type View } from "./store.ts";

// M2–M4: the options board. One question at a time over the stage; cards with live mockups in sandboxed iframes,
// More like this / Change it / Pin / Add to combine / Approve, the history trail, and the tree's glowing connectors.

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** M-opt3: the mockup, drawn at phone or desktop width and scaled into its box. Untrusted HTML never leaves this iframe. */
export function Mockup({ c, view, height, live = false }: { c: OptionCard; view: View; height: number; live?: boolean }) {
  const [box, w] = useWidth<HTMLDivElement>();
  const doc = useMemo(() => (c.mockupHtml ? mockupDoc(c.mockupHtml) : ""), [c.mockupHtml]);
  const scale = fitScale(w || VIEW_WIDTH[view], view);
  const vw = VIEW_WIDTH[view];
  return (
    <div ref={box} className={cx("opt-frame", view)} style={{ height }}>
      {c.mockupHtml ? (
        <iframe
          title={`Mockup ${c.card}: ${c.label}`}
          sandbox={MOCKUP_SANDBOX}
          srcDoc={doc}
          referrerPolicy="no-referrer"
          tabIndex={live ? 0 : -1}
          style={{ width: vw, height: height / scale, left: Math.max(0, (w - vw * scale) / 2), transform: `scale(${scale})`, pointerEvents: live ? "auto" : "none" }}
        />
      ) : (
        <pre className="opt-pre">{c.preview ?? c.description}</pre>
      )}
    </div>
  );
}

function ViewToggle({ card }: { card: string }) {
  const view = useOptions((s) => s.view[card] ?? "phone");
  const set = (v: View) => useOptions.setState((s) => ({ view: { ...s.view, [card]: v } }));
  return (
    <span role="radiogroup" aria-label={`Width for ${card}`} className="opt-seg">
      {(["phone", "desktop"] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} onClick={(e) => (e.stopPropagation(), set(v))}>
          {v}
        </button>
      ))}
    </span>
  );
}

/** The steering buttons, on a card and on the enlarged card. */
function Actions({ s, c, lit = true }: { s: OptionsSession; c: OptionCard; lit?: boolean }) {
  const busy = useOptions((st) => st.sending) || s.state !== "asking";
  const pinned = useOptions((st) => (st.pins[s.id] ?? []).includes(c.card));
  const picked = useOptions((st) => st.picks.includes(c.card));
  const [tweak, setTweak] = useState<string | null>(null);
  const send = useOptions.getState().send;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <div className="opt-acts" onClick={stop}>
        <button type="button" className={cx("btn", !busy && lit && "go")} disabled={busy} onClick={() => void send(s.id, { action: "approve", cards: [c.card] })}>
          Approve this
        </button>
        <button type="button" className="opt-act" disabled={busy} onClick={() => void send(s.id, { action: "vary", card: c.card, count: 3 })}>
          More like this
        </button>
        <button type="button" className="opt-act" disabled={busy} aria-expanded={tweak !== null} onClick={() => setTweak(tweak === null ? "" : null)}>
          Change it
        </button>
        <button type="button" className="opt-act" aria-pressed={picked} title="Add two or more cards, then combine them into one" onClick={() => useOptions.getState().togglePick(c.card)}>
          {picked ? "Added to combine" : "Add to combine"}
        </button>
        <button type="button" className="opt-act" aria-pressed={pinned} aria-label={pinned ? `Unpin ${c.card}` : `Pin ${c.card}`} title="Keep this card handy to come back to" onClick={() => useOptions.getState().togglePin(s.id, c.card)}>
          <Pin size={12} aria-hidden /> {pinned ? "Pinned" : "Pin"}
        </button>
      </div>
      {tweak !== null && (
        <form
          className="flex gap-2"
          onClick={stop}
          onSubmit={(e) => {
            e.preventDefault();
            if (tweak.trim()) void send(s.id, { action: "tweak", card: c.card, text: tweak.trim() }).then((ok) => ok && setTweak(null));
          }}
        >
          <input
            autoFocus
            className="field min-w-0 flex-1 font-sans text-[13px]"
            aria-label={`What should change in ${c.card}`}
            placeholder="What should change? e.g. bigger button, darker"
            value={tweak}
            onChange={(e) => setTweak(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setTweak(null))}
          />
          <button type="submit" className="btn" disabled={busy || !tweak.trim()}>
            Send
          </button>
        </form>
      )}
    </>
  );
}

function Card({ s, c, i, focused }: { s: OptionsSession; c: OptionCard; i: number; focused: boolean }) {
  const picked = useOptions((st) => st.picks.includes(c.card));
  const view = useOptions((st) => st.view[c.card] ?? "phone");
  const enlarge = () => useOptions.setState({ enlarged: c.card, focus: c.card });
  return (
    <article
      data-card={c.card}
      data-child={c.card}
      aria-label={`Option ${c.card}: ${c.label}`}
      aria-current={focused || undefined}
      tabIndex={focused ? 0 : -1}
      className={cx("opt-card", focused && "focus", picked && "picked")}
      onFocus={() => useOptions.getState().setFocus(c.card)}
      onMouseDown={() => useOptions.getState().setFocus(c.card)}
    >
      <div className="flex items-center gap-2">
        <span className="opt-name">{c.card}</span>
        <span className="opt-label" title={c.label}>{c.label}</span>
        <span className="micro text-[9px] text-faint" aria-hidden>{i + 1}</span>
        <ViewToggle card={c.card} />
      </div>
      <button type="button" className="opt-shot" aria-label={`Enlarge ${c.card}`} onClick={enlarge}>
        <Mockup c={c} view={view} height={230} />
      </button>
      <p className="opt-desc" title={c.description}>{c.description}</p>
      <Actions s={s} c={c} lit={focused} />
    </article>
  );
}

/** M-opt5: one card fills the stage. Arrows still move; Esc goes back to the row. */
function Enlarged({ s, c }: { s: OptionsSession; c: OptionCard }) {
  const view = useOptions((st) => st.view[c.card] ?? "phone");
  const [box, w] = useWidth<HTMLDivElement>();
  const [h, setH] = useState(480);
  useLayoutEffect(() => setH(Math.max(240, (box.current?.clientHeight ?? 520) - 4)), [w]);
  return (
    <section className="opt-big" role="dialog" aria-label={`Option ${c.card} enlarged`}>
      <div className="flex items-center gap-2.5">
        <span className="opt-name">{c.card}</span>
        <b className="font-display text-[17px] font-semibold text-ink">{c.label}</b>
        <span className="min-w-0 flex-1 truncate text-[13px] text-dim">{c.description}</span>
        <ViewToggle card={c.card} />
        <IconButton label="Back to the cards" onClick={() => useOptions.setState({ enlarged: null })}>
          <X size={14} />
        </IconButton>
      </div>
      <div ref={box} className="min-h-0 flex-1">
        <Mockup c={c} view={view} height={h} live />
      </div>
      <Actions s={s} c={c} />
    </section>
  );
}

/** M-opt6: the path to this round, and every other round. */
function Trail({ s, n }: { s: OptionsSession; n: number }) {
  const path = trail(s, n);
  const others = s.rounds.filter((r) => !path.includes(r));
  return (
    <nav aria-label="History" className="opt-trail">
      {path.map((r, i) => (
        <span key={r.n} className="contents">
          {i > 0 && <span className="opt-sep" aria-hidden>›</span>}
          <button type="button" className="opt-crumb" aria-current={r.n === n ? "step" : undefined} onClick={() => useOptions.getState().setRound(s.id, r.n)}>
            {r.title}
          </button>
        </span>
      ))}
      {others.length > 0 && (
        <select aria-label="Other rounds" className="field ml-2 h-6 text-[11px]" value="" onChange={(e) => e.target.value && useOptions.getState().setRound(s.id, Number(e.target.value))}>
          <option value="">Other rounds · {others.length}</option>
          {others.map((r) => (
            <option key={r.n} value={r.n}>
              {r.title}
            </option>
          ))}
        </select>
      )}
    </nav>
  );
}

/** M-opt4: the cards this round grew from, joined to it by the Thread's connectors (the focused card's line glows). */
function Tree({ s, from, focus, children }: { s: OptionsSession; from: string[]; focus: string | null; children: ReactNode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [paths, setPaths] = useState<{ d: string; lit: boolean; key: string }[]>([]);
  const parents = from.map((c) => s.cards[c]).filter((c): c is OptionCard => !!c);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !parents.length) return setPaths([]);
    const at = root.getBoundingClientRect();
    const box = (el: Element) => el.getBoundingClientRect();
    const out: { d: string; lit: boolean; key: string }[] = [];
    for (const p of root.querySelectorAll<HTMLElement>("[data-parent]")) {
      const a = box(p);
      for (const c of root.querySelectorAll<HTMLElement>("[data-child]")) {
        const b = box(c);
        const [x1, y1, x2, y2] = [a.left + a.width / 2 - at.left, a.bottom - at.top, b.left + b.width / 2 - at.left, b.top - at.top];
        const my = (y1 + y2) / 2;
        out.push({ key: `${p.dataset.parent}-${c.dataset.child}`, d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, lit: c.dataset.child === focus });
      }
    }
    setPaths(out.sort((x, y) => Number(x.lit) - Number(y.lit)));
  }, [w, focus, from.join(","), s.rounds.length]);
  return (
    <div ref={ref} className="opt-tree">
      {parents.length > 0 && (
        <>
          <svg className="opt-links" aria-hidden>
            <defs>
              <linearGradient id="opt-spectrum" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color.violet} />
                <stop offset="0.5" stopColor={color.blue} />
                <stop offset="1" stopColor={color.cyan} />
              </linearGradient>
            </defs>
            {paths.map((p) => (
              <path key={p.key} d={p.d} className={p.lit ? "lit" : undefined} />
            ))}
          </svg>
          <div className="opt-parents" aria-label="Grew from">
            {parents.map((p) => (
              <button
                key={p.card}
                type="button"
                data-parent={p.card}
                className="opt-parent"
                title={`Back to ${p.card}`}
                onClick={() => (useOptions.getState().setRound(s.id, p.round), useOptions.getState().setFocus(p.card))}
              >
                <span className="flex items-center gap-1.5">
                  <span className="opt-name">{p.card}</span>
                  <span className="truncate text-[12px] text-dim">{p.label}</span>
                </span>
                <Mockup c={p} view="phone" height={84} />
              </button>
            ))}
          </div>
        </>
      )}
      {children}
    </div>
  );
}

/** M-opt7: pinned cards (jump back to them) and the combine bar (or your own words). */
function Foot({ s, count }: { s: OptionsSession; count: number }) {
  const picks = useOptions((st) => st.picks).filter((c) => s.cards[c]);
  const pins = (useOptions((st) => st.pins[s.id]) ?? []).filter((c) => s.cards[c]);
  const busy = useOptions((st) => st.sending) || s.state !== "asking";
  const [take, setTake] = useState("");
  const [words, setWords] = useState("");
  const send = useOptions.getState().send;
  const hint = `← → move · ${count > 1 ? `1–${Math.min(9, count)} pick · ` : ""}Enter enlarge · ⌘↵ approve · Esc put away`;
  const jump = (card: string) => (useOptions.getState().setRound(s.id, s.cards[card]!.round), useOptions.getState().setFocus(card));
  return (
    <div className="opt-foot">
      {pins.length > 0 && (
        <span className="flex items-center gap-1.5" aria-label="Pinned">
          <span className="lbl text-[9.5px]">Pinned</span>
          {pins.map((c) => (
            <button key={c} type="button" className="opt-chip pin" onClick={() => jump(c)} title={s.cards[c]!.label}>
              <Pin size={10} /> {c}
            </button>
          ))}
        </span>
      )}
      {picks.length > 0 ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          aria-label="Combine"
          onSubmit={(e) => {
            e.preventDefault();
            if (picks.length >= 2) void send(s.id, { action: "combine", cards: picks, ...(take.trim() ? { text: take.trim() } : {}) }).then((ok) => ok && setTake(""));
          }}
        >
          <span className="lbl text-[9.5px] text-violet">Combine</span>
          {picks.map((c) => (
            <button key={c} type="button" className="opt-chip" aria-label={`Remove ${c} from combine`} onClick={() => useOptions.getState().togglePick(c)}>
              {c} <X size={10} />
            </button>
          ))}
          <input className="field min-w-0 flex-[1_1_12rem] font-sans text-[13px]" aria-label="What to take from each" placeholder={picks.length >= 2 ? `What to take from each, e.g. header from ${picks[0]}, colours from ${picks[1]}` : "Pick one more card to combine"} value={take} onChange={(e) => setTake(e.target.value)} />
          <button type="submit" className={cx("btn", picks.length >= 2 && !busy && "go")} disabled={busy || picks.length < 2}>
            Combine {joinCards(picks)}
          </button>
          {s.multi && (
            <button type="button" className="btn" disabled={busy} onClick={() => void send(s.id, { action: "approve", cards: picks })}>
              Approve these
            </button>
          )}
        </form>
      ) : (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (words.trim()) void send(s.id, { action: "other", text: words.trim() }).then((ok) => ok && setWords(""));
          }}
        >
          <input className="field min-w-0 flex-1 font-sans text-[13px]" aria-label="Tell your agent something else" placeholder="None of these? Say what you want instead" value={words} onChange={(e) => setWords(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !words.trim()}>
            Send
          </button>
        </form>
      )}
      <span className="micro w-full truncate text-[9.5px] text-faint" aria-hidden title={hint}>
        {hint}
      </span>
    </div>
  );
}

function Board({ s }: { s: OptionsSession }) {
  const n = useOptions((st) => st.round[s.id] ?? s.rounds.length);
  const round = s.rounds[n - 1] ?? s.rounds.at(-1)!;
  const focus = useOptions((st) => st.focus);
  const enlarged = useOptions((st) => st.enlarged);
  const cards = round.cards.map((c) => s.cards[c]).filter((c): c is OptionCard => !!c);
  const focused = cards.find((c) => c.card === focus) ?? cards[0];
  const big = enlarged ? s.cards[enlarged] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useOptions.getState();
      if (e.key === "Escape") {
        if (typing(e.target)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (st.enlarged) useOptions.setState({ enlarged: null });
        else useOptions.setState({ hidden: s.id });
        return;
      }
      if (typing(e.target) || useAgent.getState().open) return;
      const i = Math.max(0, cards.findIndex((c) => c.card === (st.focus ?? cards[0]?.card)));
      const go = (j: number) => {
        const c = cards[j];
        if (!c) return;
        useOptions.setState({ focus: c.card, ...(st.enlarged ? { enlarged: c.card } : {}) });
        if (!st.enlarged) document.querySelector<HTMLElement>(`[data-card="${CSS.escape(c.card)}"]`)?.focus();
      };
      let done = true;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") go(stepIndex(i, e.key === "ArrowRight" ? 1 : -1, cards.length));
      else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) go(Number(e.key) - 1);
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        if (s.state === "asking" && cards[i]) void st.send(s.id, { action: "approve", cards: [cards[i]!.card] });
      } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) useOptions.setState({ enlarged: cards[i]?.card ?? null });
      else done = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (done) (e.preventDefault(), e.stopImmediatePropagation()); // the Thread's keys wait while the cards are up
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s, cards]);

  return (
    <div className="opt-scrim" onMouseDown={(e) => e.target === e.currentTarget && useOptions.setState({ hidden: s.id })}>
      <section role="dialog" aria-label={`Options: ${s.question}`} className="opt-board">
        <div className="flex items-start gap-3">
          <span className="mt-1 text-violet" aria-hidden>
            ✦
          </span>
          <div className="min-w-0 flex-1">
            <div className="lbl mb-1 text-[9.5px] text-violet">{s.header}</div>
            <h2 className="opt-question">{s.question}</h2>
          </div>
          <IconButton label="Put the options away" onClick={() => useOptions.setState({ hidden: s.id })}>
            <X size={14} />
          </IconButton>
        </div>
        <Trail s={s} n={round.n} />
        <div className="opt-body">
          {round.note && <p className="mb-3 text-center text-[13px] text-dim">You said: “{round.note}”</p>}
          <Tree s={s} from={round.from} focus={focused?.card ?? null}>
            <div className="opt-row" role="group" aria-label={round.title}>
              {cards.map((c, i) => (
                <Card key={c.card} s={s} c={c} i={i} focused={c.card === focused?.card} />
              ))}
            </div>
          </Tree>
          {s.state === "working" && (
            <div className="opt-working" role="status">
              <Spinner size={12} className="text-violet" />
              {workingLine(s.last)}
            </div>
          )}
        </div>
        <Foot s={s} count={cards.length} />
        {big && <Enlarged s={s} c={big} />}
      </section>
    </div>
  );
}

/** M-opt8 compare: the approved mockup over the stage, next to the app it was built into. */
function Compare() {
  const runId = useAgent((s) => s.run?.id);
  const s = useOptions((st) => approvedOf(st.sessions, runId));
  const c = s ? approvedCards(s)[0] : undefined;
  const [box, w] = useWidth<HTMLDivElement>();
  const [h, setH] = useState(480);
  useLayoutEffect(() => setH(Math.max(240, (box.current?.clientHeight ?? 520) - 4)), [w]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), e.stopImmediatePropagation(), useOptions.setState({ compare: false }));
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  if (!s || !c) return null;
  return (
    <div className="opt-scrim">
      <section role="dialog" aria-label="What you approved" className="opt-board">
        <div className="flex items-center gap-2.5">
          <span className="lbl text-[9.5px] text-violet">What you approved</span>
          <span className="opt-name">{c.card}</span>
          <b className="font-display text-[16px] font-semibold text-ink">{c.label}</b>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">Your app, as built, is on the left.</span>
          <ViewToggle card={c.card} />
          <IconButton label="Close" onClick={() => useOptions.setState({ compare: false })}>
            <X size={14} />
          </IconButton>
        </div>
        <div ref={box} className="min-h-0 flex-1">
          <Mockup c={c} view={useOptions.getState().view[c.card] ?? "phone"} height={h} live />
        </div>
      </section>
    </div>
  );
}

/** Mounted once on the stage (Shell). */
export function OptionsLayer() {
  useOptionsBridge();
  const s = useOptions((st) => liveSession(st));
  const compare = useOptions((st) => st.compare);
  const away = useOptions((st) => st.sessions.findLast((x) => x.id === st.hidden && x.state === "asking"));
  if (compare) return <Compare />;
  if (s) return <Board s={s} />;
  if (!away) return null;
  return (
    <div className="pointer-events-none! absolute inset-x-0 bottom-24 z-30 flex justify-center">
      <button type="button" className="pill pointer-events-auto py-2! text-[13px] text-ink" onClick={() => useOptions.setState({ hidden: null })}>
        <span className="text-violet" aria-hidden>
          ✦
        </span>
        Your agent is waiting for your pick
        <span className="lbl">· Show options</span>
      </button>
    </div>
  );
}

/** M-opt8: in the fix card, what you approved next to what was built. Click to compare full size. */
export function ApprovedMockup() {
  const runId = useAgent((s) => s.run?.id);
  const s = useOptions((st) => approvedOf(st.sessions, runId));
  const c = s ? approvedCards(s)[0] : undefined;
  if (!s || !c) return null;
  return (
    <section aria-label="Approved mockup" className="opt-approved">
      <span className="lbl text-[9.5px]">
        What you approved · <span className="text-ink">{joinCards(s.approved ?? [])}</span> {c.label}
      </span>
      <button type="button" className="opt-shot" aria-label="Compare with what was built" onClick={() => (useUi.setState({ toasts: [] }), useOptions.setState({ compare: true }))}>
        <Mockup c={c} view="phone" height={130} />
      </button>
    </section>
  );
}

/** M6: the Ask pill's toggle. On, the ask goes out with "answer with ask_options". */
export function ShowOptionsToggle() {
  const on = useOptions((s) => s.askMode);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => useOptions.setState({ askMode: !on })}
      title="Your agent answers with cards you can see and steer: mockups, more like this, combine, approve"
      className={cx("btn h-6 px-2 text-[10px]", on && "on")}
    >
      Show me options
    </button>
  );
}
