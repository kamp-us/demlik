import type { Ledger, LedgerDriven } from "../ports";

export function createLedger(driven: LedgerDriven): Ledger {
  return { ...driven } as unknown as Ledger;
}
