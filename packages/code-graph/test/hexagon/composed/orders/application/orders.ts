import type { Orders, OrdersDriven } from "../ports";

export function createOrders(driven: OrdersDriven): Orders {
  return {
    previewOrder: async (id) => id,
    placeOrder: (id) => driven.saveOrder(id),
    cancelOrder: async () => {},
  };
}
