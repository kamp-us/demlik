# Test a machine with `drive`

To test a [machine](../glossary.md#machine) that emits [Cmds](../glossary.md#cmd),
hand `drive` the machine, a starting [Model](../glossary.md#model), one
[Msg](../glossary.md#msg) and fake [handlers](../glossary.md#handler). It runs
every Cmd through its handler and feeds each answer back until the machine
emits nothing more, then returns the final Model and everything that ran. The
test needs no host and no `run`.

`drive` has one export per [engine](../glossary.md#engine):
`@demlik/tea/testing/promise` and `@demlik/tea/testing/effect`. Steps 1 to 4
use the Promise engine. Step 5 runs the same tests on the Effect engine.

To assert on a list of Msgs with no handlers at all, see
[Replay a recorded run in a test](./replay-in-a-test.md).

## 1. Start from the machine

The tests below drive this order machine. It takes three steps in order
(reserve the stock, charge the card, ship the parcel) and a failed step ends
the order.

```ts
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
```

## 2. Write fake handlers and call `drive`

Pass `drive` four things: the machine, the Model to start from, the Msg to
send, and one handler per Cmd. Write each handler the way you write it for
`run`, with a canned answer in place of the real call. Import `order` and
`newOrder` from the machine file.

```ts
import { drive } from "@demlik/tea/testing/promise";

/** Drive one order to the end. Only the card's answer changes between tests. */
function driveOrder(card: "accepted" | "declined") {
  return drive(
    order,
    newOrder,
    { type: "place", sku: "TEA-001", cents: 4200 },
    {
      reserve_stock: async (_cmd, { ok }) => ok({ hold: "hold-1" }),
      charge_card: async (cmd, { ok, err }) =>
        card === "declined"
          ? err({ _tag: "declined" })
          : ok({ receipt: `paid-${cmd.cents}` }),
      ship_parcel: async (cmd, { ok }) => ok({ tracking: `track-${cmd.sku}` }),
    },
  );
}
```

Wrap the call in a function that takes the one answer your tests vary. Here
that is the card.

## 3. Assert on the final Model and the Cmds that ran

`drive` resolves with `{ state, trace }`. `state` is the Model once the machine
went quiet. `trace` lists every Msg folded and every Cmd run, in order; keep the
`cmd` entries to get the Cmds.

```ts
it("ships an order whose card is accepted", async () => {
  const { state, trace } = await driveOrder("accepted");

  expect(state).toEqual({
    status: "shipped",
    sku: "TEA-001",
    cents: 4200,
    tracking: "track-TEA-001",
    failure: null,
  });

  const ran = trace.flatMap((entry) =>
    entry.kind === "cmd" ? [entry.cmd.type] : [],
  );
  expect(ran).toEqual(["reserve_stock", "charge_card", "ship_parcel"]);
});
```

## 4. Assert on a failure path

Make one fake answer with `err` and drive again. Assert the Model the failure
leaves, then assert the Cmds: the list shows the steps that ran before the
failure and that no later step ran.

```ts
it("stops an order whose card is declined, and ships nothing", async () => {
  const { state, trace } = await driveOrder("declined");

  expect(state.status).toBe("failed");
  expect(state.failure).toBe("declined");
  expect(state.tracking).toBeNull();

  const ran = trace.flatMap((entry) =>
    entry.kind === "cmd" ? [entry.cmd.type] : [],
  );
  expect(ran).toEqual(["reserve_stock", "charge_card"]);
});
```

A handler that returns `err` with a declared tag is a failure the machine
handles, so the drive still resolves. A handler that throws rejects the drive
with that error. [Why failures are values and bugs are
throws](../explanation/errors-as-data.md) explains the split.

## 5. Run the same tests on the Effect engine

On the Effect engine a handler returns an `Effect`, and here each one reads
what it calls from a service. Keep the handlers your app hands `run`, and fake
the service under them. These are the order machine's handlers:

```ts
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
```

Import `drive` from `@demlik/tea/testing/effect`. It takes the same four
arguments and returns an `Effect`. Build the fake service as a Layer, provide
it, and run the Effect. Import `Shop` and `orderHandlers` from the file above.

```ts
import { drive } from "@demlik/tea/testing/effect";
import { Effect, Layer } from "effect";

/** A shop that says yes to everything except, when asked, the card. */
const fakeShop = (card: "accepted" | "declined") =>
  Layer.succeed(Shop, {
    reserve: () => Effect.succeed({ hold: "hold-1" }),
    charge: (cents) =>
      card === "declined"
        ? Effect.fail({ _tag: "declined" as const })
        : Effect.succeed({ receipt: `paid-${cents}` }),
    ship: (sku) => Effect.succeed({ tracking: `track-${sku}` }),
  });

/** Drive one order to the end, on the real handlers over the fake shop. */
function driveOrder(card: "accepted" | "declined") {
  return Effect.runPromise(
    drive(
      order,
      newOrder,
      { type: "place", sku: "TEA-001", cents: 4200 },
      orderHandlers,
    ).pipe(Effect.provide(fakeShop(card))),
  );
}
```

This `driveOrder` resolves with the same `{ state, trace }`, so the two tests
from steps 3 and 4 run against it unchanged.

## See also

- [`@demlik/tea/testing/promise`](../reference/testing-promise.md) and
  [`@demlik/tea/testing/effect`](../reference/testing-effect.md) for `drive`'s
  full signature, its options and the errors it fails with.
- [Run a machine on the Effect engine](./run-on-the-effect-engine.md) for how
  Effect handlers and Layers reach `run`.
