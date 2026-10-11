import { sendEmail } from "../clients/email.ts";
import { renderOrderEmail } from "../templates/orderPlaced.ts";

export async function onOrderPlaced(event: { orderId: number; email: string; totalCents: number; items: number }) {
  const message = renderOrderEmail(event);
  return sendEmail(event.email, message.subject, message.text);
}
