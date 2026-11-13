import type { Payments, PaymentsDriven } from "../ports";

export function createPayments(driven: PaymentsDriven): Payments {
  return { chargeCard: driven.settle };
}
