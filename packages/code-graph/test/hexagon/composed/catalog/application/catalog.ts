import type { Catalog, CatalogDriven } from "../ports";

export function createCatalog(driven: CatalogDriven): Catalog {
  return { ...driven } as unknown as Catalog;
}
