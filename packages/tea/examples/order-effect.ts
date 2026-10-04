import type { CmdOf } from "@demlik/tea";
import { Context, Effect } from "effect";
import type { chargeCard, reserveStock, shipParcel } from "./order";

/** The shop's three calls, as an Effect service. Provide it with a Layer. */
export class Shop extends Context.Service<
  Shop,
  {
    readonly reserve: (
      sku: string,
    ) => Effect.Effect<{ hold: string }, { _tag: "out_of_stock" }>;
    readonly charge: (
      cents: number,
    ) => Effect.Effect<{ receipt: string }, { _tag: "declined" }>;
    readonly ship: (
      sku: string,
    ) => Effect.Effect<{ tracking: string }, { _tag: "no_carrier" }>;
  }
>()("Shop") {}

/** The order machine's Effect handlers: the map `run` takes as `interpret`. */
export const orderHandlers = {
  reserve_stock: (cmd: CmdOf<typeof reserveStock>) =>
    Effect.gen(function* () {
      const shop = yield* Shop;
      return yield* shop.reserve(cmd.sku);
    }),
  charge_card: (cmd: CmdOf<typeof chargeCard>) =>
    Effect.gen(function* () {
      const shop = yield* Shop;
      return yield* shop.charge(cmd.cents);
    }),
  ship_parcel: (cmd: CmdOf<typeof shipParcel>) =>
    Effect.gen(function* () {
      const shop = yield* Shop;
      return yield* shop.ship(cmd.sku);
    }),
};
