import type { Invoicing, InvoicingDriven } from "../ports";

export function createInvoicing(driven: InvoicingDriven): Invoicing {
  return { ...driven } as unknown as Invoicing;
}
