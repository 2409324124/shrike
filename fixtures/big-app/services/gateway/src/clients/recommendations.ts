import { urlOf } from "../../../shared/http.ts";

export async function recommendFor(userId: number): Promise<{ id: number; name: string; priceCents: number }[]> {
  const res = await fetch(`${urlOf.recommendations}/for/${userId}`);
  return res.ok ? res.json() : [];
}
