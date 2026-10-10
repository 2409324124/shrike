const MAX = 80;

export function clean(s: string | null | undefined): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX ? t.slice(0, MAX - 1) + "…" : t;
}

function labelsText(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  if (!labels) return "";
  return clean(Array.from(labels, (l) => l.textContent).join(" "));
}

export function accessibleName(el: Element): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
    if (t) return t;
  }
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (el instanceof HTMLInputElement) {
    if (["button", "submit", "reset"].includes(el.type)) return clean(el.value) || (el.type === "submit" ? "Submit" : "");
    if (el.type === "image") return clean(el.alt);
    const fromLabel = labelsText(el);
    if (fromLabel) return fromLabel;
    if (el.type === "checkbox" || el.type === "radio") {
      return clean(el.title) || clean(el.parentElement?.textContent);
    }
    return clean(el.placeholder) || clean(el.title) || clean(el.name);
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return labelsText(el) || clean((el as HTMLTextAreaElement).placeholder) || clean(el.title) || clean(el.name);
  }
  const text = clean(el.textContent);
  if (text) return text;
  const img = el.querySelector("img[alt]");
  return clean(img?.getAttribute("alt")) || clean(el.getAttribute("title"));
}
