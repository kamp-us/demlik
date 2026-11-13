/**
 * The property-test how-to, compiled and run (#930).
 *
 * `docs/how-to/find-a-wrong-machine-with-a-law.md` shows each `#region` of this
 * file verbatim (`../../docs/page-mirrors.ts` holds the row), after the
 * machine it tests, `examples/order-effect-schema.ts`. The page's blocks, in
 * page order, are one module that starts with that machine, so a name its
 * block imports, here `Schema`, is imported at the top of this file and in no
 * region: `pages-typecheck.test.ts` compiles the page as pasted. The fixture
 * below the regions is what makes the page's claims true: the right machine
 * passes, two wrong ones fall, on ten seeds, and the lists reach every Msg.
 * This half is here because only `src/effect/` and this directory may import
 * `effect`.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move a marker and break the row this file backs.

import { Schema } from "effect";
import { describe } from "vitest";
import { order as zodOrder, type OrderMsg } from "../../../examples/order";
import {
  chargeCard,
  order,
  type reserveStock,
  type shipParcel,
} from "../../../examples/order-effect-schema";
import { NotEffectSchemaError } from ".";

// #region lists
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
// #endregion lists

// #region law
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
// #endregion law

// #region check
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
// #endregion check

// #region passes
import { expect, it } from "vitest";

it("holds on the order machine", async () => {
  const result = await check(order, 749);

  expect(result._tag).toBe("Passed");
});
// #endregion passes

// #region wrong
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
// #endregion wrong

// #region reached
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
// #endregion reached

// What the page promises, on ten seeds rather than the one it shows.

const SEEDS = [749, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The same wrong line, charging nothing. */
const chargesNothing: typeof order = {
  ...order,
  update: {
    ...order.update,
    reserve_stock_ok: (s) => [
      { ...s, status: "charging" },
      [chargeCard({ cents: 0 })],
    ],
  },
};

describe("a law over schema-drawn lists, on ten seeds", () => {
  it.each(
    SEEDS,
  )("holds on the order machine and its lists reach all seven Msg types, seed %i", async (seed) => {
    const reached = new Set<string>();
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        lists,
        (msgs) => {
          for (const { type } of msgs) reached.add(type);
          return chargesWhatWasPlaced(order, msgs) === null;
        },
        { runs: 300, size: 30, seed },
      ),
    );

    expect(result._tag).toBe("Passed");
    expect([...reached].sort()).toEqual([
      "charge_card_err",
      "charge_card_ok",
      "place",
      "reserve_stock_err",
      "reserve_stock_ok",
      "ship_parcel_err",
      "ship_parcel_ok",
    ]);
  });

  it.each(
    SEEDS,
  )("is broken by a machine that charges 0 and by one that charges a cent too many, seed %i", async (seed) => {
    for (const wrong of [chargesNothing, chargesTooMuch]) {
      const result = await check(wrong, seed);

      expect(result._tag).toBe("Falsified");
    }
  });
});

describe("a machine whose Cmds are zod", () => {
  it("is refused with a NotEffectSchemaError, as the page says before its first block", () => {
    const refused = arbSchemaGuidedSequence(
      zodOrder,
      {},
      { outside: { place } },
    );

    expect(Result.isFailure(refused)).toBe(true);
    if (!Result.isFailure(refused)) return;
    expect(refused.failure).toBeInstanceOf(NotEffectSchemaError);
    expect(refused.failure).toMatchObject({ cmdType: "reserve_stock" });
  });
});
