export interface Money {
  cents: number;
  currency: string;
}

// Money is whole cents, as Stripe and the ledger keep it. A fraction of a cent is a bug upstream, so it fails here.
export function money(cents: number, currency = "usd"): Money {
  if (!Number.isInteger(cents)) throw new RangeError(`Money must be a whole number of cents, got ${cents}`);
  return { cents, currency };
}
