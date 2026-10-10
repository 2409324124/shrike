import "./progress.css";
import type { CSSProperties } from "react";
import type { Medal as MedalKind, ProgressCard, QuestGrade } from "@shrike/schema";
import { cx } from "../components/ui.tsx";

// Shared XP visuals: metal rank letter, medal disc, collectible card. Metals: S/gold, A/silver, B/bronze, C and D steel.

export const GRADE_METAL: Record<QuestGrade, "gold" | "silver" | "bronze" | "steel"> = { S: "gold", A: "silver", B: "bronze", C: "steel", D: "steel" };
const RARITY_WORD = { bronze: "Bronze", silver: "Silver", gold: "Gold", golden: "Golden" } as const;
const EMBLEM: Record<string, string> = {
  "first-start": "▶", "first-fix": "✕", "first-ship": "⇪", "first-gold": "★", "projects-3": "◎", "skills-10": "▦", "flow-streak": "≋",
  "race-won": "⚑", "fixes-10": "✶", "first-s": "S", senior: "▲", "skill-s": "♛", fellow: "✪",
};

export function MetalLetter({ grade, className, style }: { grade: QuestGrade; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx("xp-letter", `m-${GRADE_METAL[grade]}`, className)} style={style} data-letter={grade} aria-label={`Rank ${grade}`}>
      {grade}
    </span>
  );
}

export function MedalDisc({ medal, size = 56, label = true, className }: { medal: MedalKind; size?: number; label?: boolean; className?: string }) {
  return (
    <span className={cx("xp-medal", `m-${medal}`, className)} style={{ width: size, height: size, fontSize: size * 0.42 }} role="img" aria-label={`${medal} medal`}>
      <i aria-hidden>★</i>
      {label && <b>{medal}</b>}
    </span>
  );
}

/** XP6: a collectible card. Locked shows a silhouette with the hint; `flip` turns it over from its back once. */
export function CollectCard({ card, locked, flip, small, className, style }: { card: ProgressCard; locked?: boolean; flip?: boolean; small?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx("xp-card", `r-${card.rarity}`, locked && "locked", flip && "flip", small && "sm", className)} style={style} title={locked ? card.desc : undefined} role="img" aria-label={locked ? `Locked card: ${card.desc}` : `${RARITY_WORD[card.rarity]} card: ${card.name}. ${card.desc}`}>
      <div className="xp-card-in">
        <div className="xp-card-face front">
          <span className="rar">{locked ? "Locked" : RARITY_WORD[card.rarity]}</span>
          <span className="emb" aria-hidden>
            {locked ? "?" : (EMBLEM[card.id] ?? "◆")}
          </span>
          <b className="nm">{locked ? "? ? ?" : card.name}</b>
          <span className="ds">{card.desc}</span>
          {card.rarity === "golden" && !locked && <span className="foil" aria-hidden />}
        </div>
        <div className="xp-card-face back" aria-hidden>
          <span className="bk">S</span>
        </div>
      </div>
    </div>
  );
}

export const fmtXp = (n: number) => Math.round(n).toLocaleString("en-US");
