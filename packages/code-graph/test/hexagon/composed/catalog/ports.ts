export type ForListing = (page?: number) => Promise<string[]>;
export type ForFinding = (id: string) => Promise<string | null>;
export type ForSearching = (query: string) => Promise<string[]>;
export type ForPublishing = (id: string) => Promise<void>;
export type ForTagging = (id: string, tag: string) => Promise<void>;
export type ForPricing = (id: string, cents: number) => Promise<void>;
export type ForIndexing = (id: string) => Promise<void>;
export type ForStoring = (id: string, body: string) => Promise<void>;

export type CatalogReads = {
  readonly list: ForListing;
  readonly get: ForFinding;
  readonly search: ForSearching;
  readonly count: () => Promise<number>;
  readonly exists: (id: string) => Promise<boolean>;
  readonly recent?: ForListing;
};
export type CatalogWrites = {
  add: (body: string) => Promise<string>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<string>;
};
type PricingBase = {
  setPrice: ForPricing;
  discount: (id: string, percent: number) => Promise<void>;
  bulkDiscount: (ids: string[], percent: number) => Promise<void>;
  clearDiscount: (id: string) => Promise<void>;
  priceHistory: (id: string) => Promise<number[]>;
  currency: string;
};
export type CatalogPricing = PricingBase;
interface TagReads {
  listTags: () => Promise<string[]>;
  findByTag: ForSearching;
}
export interface CatalogTags extends TagReads {
  tag: ForTagging;
  untag: ForTagging;
  renameTag: (from: string, to: string) => Promise<void>;
  mergeTags: (from: string, into: string) => Promise<void>;
}
export type Catalog = CatalogReads &
  CatalogWrites &
  CatalogPricing &
  CatalogTags & {
    publish: ForPublishing;
    unpublish: ForPublishing;
    schedule: (id: string, at: string) => Promise<void>;
    feature: (id: string) => Promise<void>;
    unfeature: (id: string) => Promise<void>;
    reindex: ForIndexing;
  };
export type CatalogDriven = { store: ForStoring };
