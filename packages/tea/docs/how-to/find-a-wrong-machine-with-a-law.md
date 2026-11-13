# Find a wrong machine with a law

To find a [machine](../glossary.md#machine) that does the wrong thing without
writing the [Msgs](../glossary.md#msg) that show it, state a
[law](../glossary.md#law) the machine must keep and let tea draw the Msg lists.
`arbSchemaGuidedSequence` draws each list so that every answer comes from the
schema of a [Cmd](../glossary.md#cmd) the machine has already sent, `foldEvents`
[folds](../glossary.md#fold) it through the machine, and the law judges the
result inside Effect's `Arbitrary.checkEffect`. When a list breaks the law, you
get the smallest list the check could shrink the failure to. You write no
answer by hand.

This page finds an order machine that charges the wrong amount.

`arbSchemaGuidedSequence` and the laws (`lawInvariant`, `lawTerminates` and
`lawTrace`) are `@experimental` on a subpath that is otherwise `stable`.
[`MAINTAINING.md`](https://github.com/kamp-us/demlik/blob/main/packages/tea/MAINTAINING.md)
promises nothing for an experimental name: it may change or disappear in any
release, so a test built on them may need an edit when you upgrade. `foldEvents`
keeps the `stable` promise of its subpath.

The Cmds must be written with Effect Schema. `arbSchemaGuidedSequence` draws an
answer from each Cmd's `ok` schema, so on a machine whose Cmds use zod, like the
order machine in [Test a machine with `drive`](./test-a-machine-with-drive.md),
it returns a failed `Result` holding a `NotEffectSchemaError` and draws nothing.
This page uses that order machine with its three Cmds written in Effect Schema.

Paste the blocks below in page order into one test file, beside the drive
page's `order.ts`.

## 1. Write the machine's Cmds in Effect Schema

This is the twin of the drive page's `order.ts`. It imports the order's state
and its starting value from there, and its seven `update` cells are the same.
Only the Cmds change, from `Cmd.define` over zod to `Cmd.make` from
`@demlik/tea/effect` over Effect Schema.

```ts
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
```

## 2. Draw lists of Msgs

Give `arbSchemaGuidedSequence` the machine, its [`ctx`](../glossary.md#ctx) and,
as `outside`, the Msgs no Cmd answers for: here `place`, someone placing an
order. Every other Msg in a list answers a Cmd the machine has sent and nothing
has answered yet, and its value is drawn from that Cmd's schema: an `ok` value,
or one of its `err` tags. `maxLength` caps a list at 30 Msgs.

`cents` starts at 1, so a charge of nothing is wrong for every order the lists
place. The call returns a `Result`, since it refuses a machine it cannot draw
for, and `Result.getOrThrow` unwraps it.

```ts
import { arbSchemaGuidedSequence } from "@demlik/tea/testing/effect";
import { Arbitrary, Result } from "effect";

/** The Msg no Cmd answers for: someone placing an order. */
const place = Arbitrary.schema(
  Schema.Struct({
    type: Schema.Literal("place"),
    sku: Schema.String,
    cents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  }),
);

/** Msg lists in which every answer comes from the schema of a Cmd that was sent. */
const lists = Result.getOrThrow(
  arbSchemaGuidedSequence(order, {}, { outside: { place }, maxLength: 30 }),
);
```

## 3. State the law

`foldEvents` folds a list through the machine and returns every step: the Msg,
the Cmds it sent and the Model before and after. `lawTrace` hands your function
all the steps and answers `null` when the law holds. When it breaks, it answers
a `LawBreak` whose `reason` is the string your function returned, or `null` when
it returned `false`.

This law reads the amount from the `place` Msg and not from the Model. A wrong
line that also wrote the wrong amount into the Model would agree with a law that
read it there. It is `lawTrace` and not `lawInvariant` because the `place` Msg
comes steps before the Cmd it governs, and `lawInvariant` judges one step at a
time.

```ts
import type { Settled } from "@demlik/tea";
import { foldEvents, lawTrace } from "@demlik/tea/testing/effect";

type Msg =
  | OrderMsg
  | Settled<typeof reserveStock | typeof chargeCard | typeof shipParcel>;

/** The law: every `charge_card` Cmd carries the cents of the latest `place` Msg. */
const chargesWhatWasPlaced = (machine: typeof order, msgs: readonly Msg[]) =>
  lawTrace(foldEvents(machine, {}, null, msgs), (steps) => {
    let placed: number | null = null;
    for (const { msg, cmds } of steps) {
      if (msg.type === "place") placed = msg.cents;
      for (const cmd of cmds)
        if (cmd.type === "charge_card" && cmd.cents !== placed)
          return `charge_card carries ${cmd.cents}, the order holds ${placed}`;
    }
    return null;
  });
```

## 4. Run the law on the machine

`Arbitrary.checkEffect` draws lists and judges each with the law. Here it draws
300, each up to 30 Msgs. Its `size` caps a list too, and defaults to 10, so pass
one at least as large as `maxLength`. The `seed` makes a run repeat.

```ts
import { Effect } from "effect";

/** Judge 300 lists of up to 30 Msgs with the law. The seed makes a run repeat. */
const check = (machine: typeof order, seed: number) =>
  Effect.runPromise(
    Arbitrary.checkEffect(
      lists,
      (msgs) => chargesWhatWasPlaced(machine, msgs) === null,
      { runs: 300, size: 30, seed },
    ),
  );
```

`Passed` means all 300 lists kept the law.

```ts
import { expect, it } from "vitest";

it("holds on the order machine", async () => {
  const result = await check(order, 749);

  expect(result._tag).toBe("Passed");
});
```

## 5. Plant a wrong amount and read the failure

To see the check find a bug, copy the machine with one cell changed: after the
stock is held, it charges one cent too many.

`Falsified` carries `shrunkInput`, the smallest list the check could shrink the
failure to. Here that is a `place` and the stock's answer. Run the law on it to
read the `reason`.

```ts
/** The order machine with one line wrong: it charges one cent too many. */
const chargesTooMuch: typeof order = {
  ...order,
  update: {
    ...order.update,
    reserve_stock_ok: (s) => [
      { ...s, status: "charging" },
      [chargeCard({ cents: s.cents + 1 })],
    ],
  },
};

it("is broken by a machine that charges one cent too many", async () => {
  const result = await check(chargesTooMuch, 749);

  expect(result._tag).toBe("Falsified");
  if (result._tag !== "Falsified") return;
  expect(result.shrunkInput).toEqual([
    { type: "place", sku: "", cents: 1 },
    {
      type: "reserve_stock_ok",
      cmd: { type: "reserve_stock", sku: "" },
      value: { hold: "" },
    },
  ]);
  expect(chargesWhatWasPlaced(chargesTooMuch, result.shrunkInput)?.reason).toBe(
    "charge_card carries 2, the order holds 1",
  );
});
```

## 6. Check that the lists reach every Msg

A law that passes on lists that never reached a Msg has not judged it. Sample
the lists and count the Msg types they hold.

```ts
it("draws lists that reach every Msg", async () => {
  const drawn = await Effect.runPromise(
    Arbitrary.sampleEffect(lists, { count: 300, size: 30, seed: 749 }),
  );

  expect(new Set(drawn.flat().map((msg) => msg.type))).toEqual(
    new Set([
      "place",
      "reserve_stock_ok",
      "reserve_stock_err",
      "charge_card_ok",
      "charge_card_err",
      "ship_parcel_ok",
      "ship_parcel_err",
    ]),
  );
});
```

## See also

- [`@demlik/tea/testing/effect`](../reference/testing-effect.md) for the
  signatures and options of `arbSchemaGuidedSequence`, `foldEvents` and the laws.
- [ADR 0032](https://github.com/kamp-us/demlik/blob/main/.decisions/0032-effect-property-tests-draw-answers-from-cmd-schemas.md)
  for why the lists are drawn from each Cmd's schema.
- If your Cmds use zod, draw the lists with `arbGuidedSequence` and judge them
  with `propertyTrace` from `@demlik/tea/pbt`, which takes the answers you write
  and runs on fast-check: [`@demlik/tea/pbt`](../reference/pbt.md).
