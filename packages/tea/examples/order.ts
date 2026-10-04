import { Cmd, defineMachine } from "@demlik/tea";
import { z } from "zod";

/** Hold the stock. The handler returns an outcome; the engine mints the Msg. */
export const reserveStock = Cmd.define("reserve_stock", {
  input: z.object({ sku: z.string() }),
  ok: z.object({ hold: z.string() }),
  err: ["out_of_stock"],
});

/** Charge the card for the held stock. */
export const chargeCard = Cmd.define("charge_card", {
  input: z.object({ cents: z.number() }),
  ok: z.object({ receipt: z.string() }),
  err: ["declined"],
});

/** Hand the parcel to a carrier. */
export const shipParcel = Cmd.define("ship_parcel", {
  input: z.object({ sku: z.string() }),
  ok: z.object({ tracking: z.string() }),
  err: ["no_carrier"],
});

export interface OrderState {
  readonly status:
    | "new"
    | "reserving"
    | "charging"
    | "shipping"
    | "shipped"
    | "failed";
  readonly sku: string;
  readonly cents: number;
  readonly tracking: string | null;
  /** The tag of the step that failed. */
  readonly failure: string | null;
}

export type OrderMsg = {
  readonly type: "place";
  readonly sku: string;
  readonly cents: number;
};

/** An order nobody has placed yet. */
export const newOrder: OrderState = {
  status: "new",
  sku: "",
  cents: 0,
  tracking: null,
  failure: null,
};

const failed = (s: OrderState, failure: string): OrderState => ({
  ...s,
  status: "failed",
  failure,
});

/** Three steps in order: reserve, charge, ship. A failed step ends the order. */
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
