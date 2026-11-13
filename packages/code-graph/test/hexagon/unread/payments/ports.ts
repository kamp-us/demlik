export type ForChargingCards = (id: string) => Promise<void>;
export type ForChargingTransfers = (id: string, iban: string) => Promise<void>;
export type ForSettling = (id: string) => Promise<void>;

export type PaymentsByCard = { chargeCard: ForChargingCards };
export type PaymentsByTransfer = { chargeTransfer: ForChargingTransfers };
export type Payments = PaymentsByCard | PaymentsByTransfer;
export type PaymentsDriven = { settle: ForSettling };
