export type ForPreviewingOrders = (id: string) => Promise<string>;
export type ForPlacingOrders = (id: string) => Promise<void>;
export type ForCancellingOrders = (id: string, reason?: string) => Promise<void>;
export type ForSavingOrders = (id: string) => Promise<void>;

export type OrderIntents = { previewOrder: ForPreviewingOrders };
export type Orders = OrderIntents & {
  placeOrder: ForPlacingOrders;
  cancelOrder: ForCancellingOrders;
};
export type OrdersDriven = { saveOrder: ForSavingOrders };
