export type ForShipping = (parcel: string) => Promise<void>;
export type ForCarrying = (parcel: string) => Promise<string>;

export type ShipmentIntents = { ship: ForShipping };
export type ShipmentBase = ShipmentIntents;
export type Shipment = ShipmentBase;
export type ShipmentDriven = { carry: ForCarrying };
