import type { Shipment, ShipmentDriven } from "../ports";

export function createShipment(driven: ShipmentDriven): Shipment {
  return { ship: async (parcel) => void (await driven.carry(parcel)) };
}
