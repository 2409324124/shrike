import type { OptionsReply } from "@shrike/schema";

// M1: what ask_options says back to the agent. Also the prompt of a resumed turn when nothing was waiting (main/options.ts).

const ECHO_MAX = 120_000; // ponytail: a combine of many big mockups only repeats what fits; past this, Claude's own context has them
const attr = (s: string) => s.replace(/["<>\n]/g, " ").trim();

/** The answer as one JSON line, the mockups it points at, and what to do next. Keys avoid words redaction masks (session, card). */
export function optionsReplyText(r: OptionsReply): string {
  const a0 = r.answer;
  const head = JSON.stringify({
    action: r.action,
    thread: r.session,
    ...(a0 && "card" in a0 ? { option: a0.card } : {}),
    ...(a0 && "cards" in a0 ? { options: a0.cards } : {}),
    ...(a0 && "count" in a0 && a0.count ? { count: a0.count } : {}),
    ...(a0 && "text" in a0 && a0.text ? { text: a0.text } : {}),
  });
  let room = ECHO_MAX;
  const cards = r.cards.map((c) => {
    const body = (c.mockupHtml ?? c.preview ?? "(no mockup)").replace(/<\/card/gi, "<\\/card");
    const fits = body.length <= room;
    if (fits) room -= body.length;
    return `<card name="${attr(c.card)}"${c.id ? ` id="${attr(c.id)}"` : ""} label="${attr(c.label)}">\n${fits ? body : "(too long to repeat here: it is the mockup you sent for this option)"}\n</card>`;
  }).join("\n");
  const again = `Call ask_options again with thread "${r.session}"`;
  const a = r.answer;
  let next: string;
  switch (a?.action) {
    case "vary":
      next = `The user wants ${a.count ?? 3} more like card ${a.card}. Keep what makes ${a.card} itself; make each new one differ from the others in one clear, visible way. ${again} and the new options.`;
      break;
    case "tweak":
      next = `The user wants card ${a.card} changed: "${a.text}". Make that change and nothing else. ${again} and the changed card as one option.`;
      break;
    case "combine":
      next = `The user wants one mockup that combines cards ${a.cards.join(" and ")}${a.text ? `, taking: "${a.text}"` : ""}. ${again} and the merged card as one option (two only if there are two honest ways to merge).`;
      break;
    case "approve":
      next = `The user approved ${a.cards.join(" and ")}. Build exactly this in their app now with propose_patch, using the app's own components and styles. The mockup stays next to your patch so they can compare. Once the patch is applied, call propose_skill_update for design-taste with what this choice says about their taste (one short reason, the whole improved skill).`;
      break;
    case "other":
      next = `The user answered in their own words: "${a.text}". Do what they said; if it needs a new choice, ${again}.`;
      break;
    default:
      next = `The user hasn't answered yet; the cards are still on their screen. ${again} and no options to keep waiting. Don't ask in text.`;
  }
  return [head, cards, next].filter(Boolean).join("\n");
}
