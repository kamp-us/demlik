export type ForRestocking = (sku: string, count: number) => Promise<void>;
export type ForCounting = (sku: string) => Promise<number>;
export type ForSavingStock = (sku: string, count: number) => Promise<void>;

type StockReads = { count: ForCounting };
export type Stock = StockReads & { restock: ForRestocking };
export type StockDriven = { save: ForSavingStock };
