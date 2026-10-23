import type { Warehouse, WarehouseDriven } from "../ports";

export function createWarehouse(driven: WarehouseDriven): Warehouse {
  return {
    remove: () => {},
    list: () => [],
    add: (name) => driven.save(name),
  };
}

export function validate(name: string): boolean {
  return name.length > 0;
}
