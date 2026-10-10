import { useEffect, useMemo, useRef, useState } from "react";
import type { Medal, Progress, SkillRank } from "@shrike/schema";
import { call } from "../lib/api.ts";
import { cx } from "../components/ui.tsx";
import { toast } from "../stores/ui.ts";
import { useSkills } from "../stores/skills.ts";
import { RankBadge, SystemTag, useCalm } from "../system/System.tsx";
import { rankOf } from "../system/ranks.ts";
import { CollectCard, fmtXp, MedalDisc, MetalLetter } from "./parts.tsx";
import { renderProfilePng } from "./share.ts";
import { useProgress } from "./store.ts";
import { titleOf } from "./xp.ts";

// XP7: the top bar's title and XP, and the Hunter profile it opens. XP9: the held quest result chip beside them.

/** "SDE2 · 1,240 XP" with a slim bar toward the next title. Click opens the profile. */
export function XpChip() {
  const p = useProgress((s) => s.progress);
  const open = useProgress((s) => s.profile);
  const before = useProgress((s) => (s.open ? s.result?.before : undefined));
  if (!p) return null;
  const t = before === undefined ? { title: p.title, xp: p.xp, from: p.titleFrom, nextAt: p.nextAt } : { ...titleOf(before), xp: before }; // XP3 on screen shows the gain first; a held chip shows the real total
  const k = t.nextAt ? (t.xp - t.from) / (t.nextAt - t.from) : 1;
  return (
    <>
      <button
        type="button"
        className="xp-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={p.nextTitle ? `${fmtXp((p.nextAt ?? 0) - p.xp)} XP to ${p.nextTitle}. Open your profile.` : "Open your profile"}
        onClick={() => useProgress.getState().setProfile(!open)}
      >
        <span className="t">
          {t.title} <span>· {fmtXp(t.xp)} XP</span>
        </span>
        <span className="b" aria-hidden>
          <i style={{ width: `${Math.max(0, Math.min(1, k)) * 100}%` }} />
        </span>
      </button>
      <QuestChip />
      {open && <Profile p={p} onClose={() => useProgress.getState().setProfile(false)} />}
    </>
  );
}

/** XP9: a result that landed mid-work, held here until clicked. */
function QuestChip() {
  const r = useProgress((s) => (s.open ? null : s.result));
  const calm = useCalm();
  return (
    <span role="status" className="contents">
      {r && (
        <button type="button" className={cx("xr-chip", calm && "calm")} title={`${r.quest}. Open the results.`} onClick={() => useProgress.getState().show()}>
          <span className="lb">Quest result</span>
          <MetalLetter grade={r.grade} />
          <span className="xp">+{fmtXp(r.xp)} XP</span>
        </button>
      )}
    </span>
  );
}

const RANK_ORDER: SkillRank[] = ["S", "A", "B", "C", "D", "E"];
const MEDALS: Medal[] = ["gold", "silver", "bronze"];

export function Profile({ p, onClose }: { p: Progress; onClose(): void }) {
  const skills = useSkills((s) => s.list);
  const [formula, setFormula] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => void (formula && more.current?.scrollIntoView({ block: "nearest" })), [formula]); // the body scrolls; the footer stays
  const [busy, setBusy] = useState(false);
  const calm = useCalm();
  const byRank = useMemo(() => {
    const m = new Map<SkillRank, string[]>(RANK_ORDER.map((r) => [r, []]));
    for (const s of skills.filter((x) => x.source !== "builtin" || (x.proficiency ?? 0) > 0)) m.get(rankOf(s.version, s.proficiency).rank)!.push(s.name);
    return m;
  }, [skills]);
  const owned = p.cards.filter((c) => c.at).length;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);

  const share = async (how: "save" | "copy") => {
    setBusy(true);
    try {
      const blob = await renderProfilePng(p, byRank);
      if (how === "copy") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast("Copied your profile card. Paste it anywhere.", "ok");
      } else {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = await call((a) => a.saveImage(bytes, `shrike-${p.title.toLowerCase().replace(/\s+/g, "-")}`), "Couldn't save the image");
        if (path) toast(`Saved to ${path}`, "ok");
      }
    } catch (e) {
      toast(`Couldn't make the image: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const k = p.nextAt ? (p.xp - p.titleFrom) / (p.nextAt - p.titleFrom) : 1;
  return (
    <div className="no-drag fixed inset-0 z-[60] grid place-items-center bg-[color-mix(in_srgb,var(--void)_70%,transparent)] p-4" onClick={onClose}>
      <section role="dialog" aria-label="Hunter profile" className={cx("sys w-[min(900px,100%)]", calm && "sys-calm")} onClick={(e) => e.stopPropagation()}>
        <div className="sys-panel flex max-h-[calc(100vh-48px)] flex-col px-6 pt-4 pb-5">
          <SystemTag>Hunter profile</SystemTag>
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
            <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="min-w-[240px] flex-1">
                <span className="sys-kind text-[10px]">Title</span>
                <h2 className="m-0 mt-1 font-display text-[34px] leading-none font-semibold text-[var(--c-core)] [text-shadow:0_0_18px_color-mix(in_srgb,var(--c-cyan)_45%,transparent)]">{p.title}</h2>
                <div className="mt-2.5 flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="text-ink">{fmtXp(p.xp)} XP</span>
                  <span className="flex-1" />
                  <span className="text-faint">{p.nextTitle ? `${fmtXp((p.nextAt ?? 0) - p.xp)} to ${p.nextTitle}` : "Top of the ladder"}</span>
                </div>
                <div className="xr-bar" aria-hidden>
                  <i style={{ width: `${Math.max(0, Math.min(1, k)) * 100}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-3" aria-label="Medals">
                {MEDALS.map((m) => (
                  <span key={m} className="flex flex-col items-center gap-1">
                    <MedalDisc medal={m} size={42} label={false} className={cx(!p.medals[m] && "opacity-30")} />
                    <span className="font-mono text-[11px] text-ink">{p.medals[m]}</span>
                  </span>
                ))}
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-4 gap-2">
              {[
                ["Quests completed", p.quests],
                ["Bugs fixed", p.bugsFixed],
                ["Projects started", p.projectsStarted],
                ["Pull requests shipped", p.prsShipped],
              ].map(([k, v]) => (
                <div key={k} className="border border-[color-mix(in_srgb,var(--c-cyan)_22%,transparent)] bg-[color-mix(in_srgb,var(--c-cyan)_5%,transparent)] px-3 py-2">
                  <dt className="micro text-[9px] text-dim">{k}</dt>
                  <dd className="m-0 mt-1 font-display text-[22px] leading-none text-[var(--c-core)]">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_230px] gap-5">
              <section aria-label="Card binder">
                <div className="mb-2 flex items-center gap-2">
                  <span className="sys-kind text-[10px]">Card binder</span>
                  <span className="font-mono text-[10px] text-faint">
                    {owned}/{p.cards.length}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,92px)] gap-2.5">
                  {p.cards.map((c) => (
                    <CollectCard key={c.id} card={c} locked={!c.at} small />
                  ))}
                </div>
              </section>
              <section aria-label="Skills by rank">
                <span className="sys-kind text-[10px]">Skills by rank</span>
                <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
                  {RANK_ORDER.map((r) => {
                    const names = byRank.get(r)!;
                    return (
                      <li key={r} className={cx("flex items-center gap-2 text-[12px]", !names.length && "opacity-40")}>
                        <RankBadge rank={r} small />
                        <span className="w-5 font-mono text-[11px] text-ink">{names.length}</span>
                        <span className="min-w-0 flex-1 truncate text-dim" title={names.join(", ")}>
                          {names.slice(0, 3).join(", ") || "None yet"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {p.project && (
                  <p className="sys-line m-0 mt-3 text-[11.5px]">
                    {p.project.name}: {fmtXp(p.project.xp)} XP from {p.project.quests} {p.project.quests === 1 ? "quest" : "quests"}
                  </p>
                )}
              </section>
            </div>

            {formula && (
              <div ref={more} className="mt-3">
                <p className="sys-line m-0 mb-2 text-[12px]">Only real work counts: quests you finish, fixes that are verified, skills you grow. Nothing is ever taken away.</p>
                <ul className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-1 p-0">
                  {p.formula.map((f) => (
                    <li key={f.label} className="flex items-baseline gap-2 border-b border-hair py-1 text-[12px]">
                      <span className="min-w-0 flex-1 text-dim">{f.label}</span>
                      <span className="font-mono text-[11px] text-signal">+{f.xp}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hair pt-3">
            <button type="button" className="hud-btn" aria-expanded={formula} onClick={() => setFormula(!formula)}>
              How XP works
            </button>
            <span className="flex-1" />
            <button type="button" className="hud-btn" disabled={busy} onClick={() => void share("copy")}>
              Copy as image
            </button>
            <button type="button" className="hud-btn solid" disabled={busy} onClick={() => void share("save")}>
              Share as image
            </button>
            <button type="button" className="hud-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {(["tl", "tr", "bl", "br"] as const).map((c) => (
          <span key={c} className={`sys-corner ${c}`} aria-hidden />
        ))}
      </section>
    </div>
  );
}

