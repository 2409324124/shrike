// ponytail: browsing history is a fixed list for the demo shopper; a real one would read an events store.
const VIEWED: Record<number, { productIds: number[]; categories: string[] }> = {
  1: { productIds: [4, 7, 12, 14, 21, 9], categories: ["kitchen", "home"] },
};

export function recentlyViewed(userId: number) {
  return VIEWED[userId] ?? { productIds: [], categories: [] };
}
