import { urlOf } from "../../../shared/http.ts";

export async function sendEmail(to: string, subject: string, text: string): Promise<{ id: string }> {
  const res = await fetch(`${urlOf.email}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, subject, text }) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `email provider said ${res.status}`);
  return { id: body.id };
}
