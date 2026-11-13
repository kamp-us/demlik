export type ForPaying = (invoice: string) => Promise<void>;
export type ForRefunding = (invoice: string, cents: number) => Promise<void>;
export type ForDisputing = (invoice: string, note: string) => Promise<void>;
export type ForLedgering = (entry: string) => Promise<void>;

export interface BillingIntents {
  pay: ForPaying;
}
export interface Billing extends BillingIntents {
  refund: ForRefunding;
  dispute: ForDisputing;
}
export type BillingDriven = { ledger: ForLedgering };
