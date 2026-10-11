import { urlOf } from "../../../shared/http.ts";

export async function relatedSearches(names: string[]): Promise<string[]> {
  const res = await fetch(`${urlOf.search}/related`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names }) });
  return res.ok ? res.json() : [];
}
