import { sleep } from "../../../shared/http.ts";
import { createPaymentIntent, retrieveIntent } from "../clients/stripe.ts";

const MAX_POLLS = 5;

// Stripe can answer "processing" for a while; ask again with exponential backoff until it settles.
export async function chargeWithBackoff(amountCents: number, customer: number) {
  let intent = await createPaymentIntent(amountCents, customer);
  for (let attempt = 1; intent.status === "processing"; attempt++) {
    if (attempt > MAX_POLLS) throw new Error("The payment is still processing. Try again in a minute.");
    await backoff(attempt);
    intent = await retrieveIntent(intent.id);
  }
  if (intent.status !== "succeeded") throw new Error(`The payment ${intent.status}`);
  return intent;
}

export async function backoff(attempt: number): Promise<void> {
  await sleep(100 * 2 ** (attempt - 1));
}
