import type { Billing, BillingDriven } from "../ports";

export function createBilling(driven: BillingDriven): Billing {
  return {
    pay: (invoice) => driven.ledger(invoice),
    refund: async () => {},
    dispute: async () => {},
  };
}
