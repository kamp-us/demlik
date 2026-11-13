import { defineMachine } from "@demlik/tea";
import { Cmd } from "@demlik/tea/effect";
import { Schema } from "effect";
import { newOrder, type OrderMsg, type OrderState } from "./order";

/** Hold the stock, with the schemas written in Effect Schema. */
export const reserveStock = Cmd.make("reserve_stock", {
  input: Schema.Struct({ sku: Schema.String }),
  ok: Schema.Struct({ hold: Schema.String }),
  err: ["out_of_stock"],
});

/** Charge the card for the held stock. */
export const chargeCard = Cmd.make("charge_card", {
  input: Schema.Struct({ cents: Schema.Number }),
  ok: Schema.Struct({ receipt: Schema.String }),
  err: ["declined"],
});

/** Hand the parcel to a carrier. */
export const shipParcel = Cmd.make("ship_parcel", {
  input: Schema.Struct({ sku: Schema.String }),
  ok: Schema.Struct({ tracking: Schema.String }),
  err: ["no_carrier"],
});

const failed = (s: OrderState, failure: string): OrderState => ({
  ...s,
  status: "failed",
  failure,
});

/** The order machine again: the same seven cells, over the Cmds above. */
export const order = defineMachine({
  types: { model: {} as OrderState, msg: {} as OrderMsg },
  cmds: [reserveStock, chargeCard, shipParcel],
  init: (loaded) => [loaded ?? newOrder, []],
  update: {
    place: (s, m) => [
      { ...s, status: "reserving", sku: m.sku, cents: m.cents },
      [reserveStock({ sku: m.sku })],
    ],
    reserve_stock_ok: (s) => [
      { ...s, status: "charging" },
      [chargeCard({ cents: s.cents })],
    ],
    reserve_stock_err: (s, m) => [failed(s, m.error._tag), []],
    charge_card_ok: (s) => [
      { ...s, status: "shipping" },
      [shipParcel({ sku: s.sku })],
    ],
    charge_card_err: (s, m) => [failed(s, m.error._tag), []],
    ship_parcel_ok: (s, m) => [
      { ...s, status: "shipped", tracking: m.value.tracking },
      [],
    ],
    ship_parcel_err: (s, m) => [failed(s, m.error._tag), []],
  },
});
