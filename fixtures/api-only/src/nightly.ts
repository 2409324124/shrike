// Nightly sync: makes sure every customer from the CRM export has an account.
// Run it like cron would: `npm run nightly`. Under Shrike, set SHRIKE_CALLER=cron so its trips start in a CRON lane.
const API = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 4300}`;

const crmExport = [
  { email: "Sam@Example.com", name: "Sam Rivera" }, // already registered as sam@example.com
  { email: "ria@example.com", name: "Ria Patel" },
];

async function syncUser(user: { email: string; name: string }): Promise<boolean> {
  const res = await fetch(`${API}/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "nightly-sync/1.0" },
    body: JSON.stringify(user),
  });
  const body = (await res.json()) as { id?: number; error?: string };
  console.log(`${user.email}: ${res.status}`, res.ok ? `user #${body.id}` : body.error);
  return res.ok;
}

let failed = 0;
for (const user of crmExport) if (!(await syncUser(user))) failed++;
console.log(failed ? `nightly sync: ${failed} of ${crmExport.length} failed` : "nightly sync: all good");
process.exitCode = failed ? 1 : 0;
