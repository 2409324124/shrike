// Nightly reindex: rebuilds the search index from the catalog. Shrike runs it with SHRIKE_CALLER=cron (see package.json),
// so its trips start in a CRON lane.
import { urlOf } from "../../shared/http.ts";

const BOOT_DELAY_MS = Number(process.env.CRON_BOOT_DELAY_MS ?? 4000);
const DAY_MS = 24 * 60 * 60_000;

async function nightlyReindex(): Promise<void> {
  try {
    const res = await fetch(`${urlOf.search}/admin/reindex`, { method: "POST", headers: { "user-agent": "bazaar-cron/1.0" } });
    console.log(`reindex: ${res.status}`, await res.text());
  } catch (err) {
    console.error("reindex failed:", (err as Error).message);
  }
}

// ponytail: once shortly after boot (so a dev session sees it) and then every 24h; a real deploy would use the platform's scheduler.
setTimeout(nightlyReindex, BOOT_DELAY_MS);
setInterval(nightlyReindex, DAY_MS);
console.log(`cron ready: reindex in ${BOOT_DELAY_MS / 1000}s, then nightly`);
