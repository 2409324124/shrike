import { money, type Money } from "./money.ts";

export interface ReceiptLine {
  name: string;
  qty: number;
  cents: number;
  taxRate: number;
}

// The receipt shows tax per line. Each line's tax is in whole cents, so the lines add up to what was charged.
export function receiptTotals(lines: ReceiptLine[], shippingCents: number) {
  const rows = [];
  let subtotal = 0;
  let tax = 0;
  for (const line of lines) {
    const t = lineTax(line);
    rows.push({ ...line, taxCents: t.cents });
    subtotal += line.cents;
    tax += t.cents;
  }
  return { rows, subtotal: money(subtotal), tax: money(tax), shipping: money(shippingCents), total: money(subtotal + tax + shippingCents) };
}

export function lineTax(line: ReceiptLine): Money {
  return money(line.cents * line.taxRate);
}
