import type { Audited } from "../shared/audit";

export type ForRaising = (customer: string) => Promise<string>;
export type ForVoiding = (invoice: string) => Promise<void>;
export type ForArchiving = (invoice: string) => Promise<void>;

export type InvoiceIntents = { raise: ForRaising };
export type Invoicing = InvoiceIntents & Audited & { void: ForVoiding };
export type InvoicingDriven = { archive: ForArchiving };
