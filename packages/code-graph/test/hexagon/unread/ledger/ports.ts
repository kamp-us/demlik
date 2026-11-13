export type ForPosting = (entry: string) => Promise<void>;
export type ForClosing = (period: string) => Promise<void>;
export type ForWriting = (entry: string) => Promise<void>;

type Page<T> = { items: T[] };
export type Ledger = Page<string> & { post: ForPosting; close: ForClosing };
export type LedgerDriven = { write: ForWriting };
