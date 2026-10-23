import type { ForLogging } from "outside";

export type ForRemoving = (id: string) => void;
export type ForAdding = (name: string, count?: number) => Promise<string>;
export type ForListing = () => readonly string[];
export type ForSaving = <T>(value: T) => Promise<T>;
type StoreCall<T> = (value: T) => Promise<T>;
export type ForWriting = StoreCall<string>;
export type ForReadingStats = () => number;
export type ForLoading = (
  key: string,
) => Promise<string | null>;

type Base = { readonly load: ForLoading };
type Stats = { readonly stat: ForReadingStats };
export interface Storage extends Base, Stats {
  clear(key: string): void;
}
export type Empty = {};
export type WarehouseDriven = Base & {
  readonly save: ForSaving;
  readonly write: ForWriting;
  readonly log: ForLogging;
};
export type Warehouse = {
  readonly remove: ForRemoving;
  readonly list: ForListing;
  readonly add: ForAdding;
};
export type Metadata = { readonly count: number };
