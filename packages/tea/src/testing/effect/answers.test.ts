/**
 * Property tests on Effect's own `Arbitrary`, with answers drawn from each Cmd's
 * Effect schema (#749): `arbSchemaGuidedSequence` draws the lists,
 * `Arbitrary.checkEffect` runs them, `foldEvents` folds each, and a law judges
 * it. No answer is written by hand, and nothing here imports fast-check.
 */

import { Arbitrary, Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cmd } from "../../effect";
import {
  Cmd as CoreCmd,
  defineMachine,
  type Reducer,
  type Settled,
} from "../../index";
import {
  arbSchemaGuidedSequence,
  foldEvents,
  lawInvariant,
  NoCmdsError,
  NotEffectSchemaError,
  NothingToDrawError,
} from ".";

// An order desk. `open` asks three things at once: a price, the stock and a
// charge. The state counts what is still out and never keeps a Cmd, so only the
// drawing rule keeps an answer tied to a Cmd that was really sent. `offline` and
// `timeout` ask again, so one Cmd can wait twice.

const sku = Schema.Struct({ sku: Schema.Literals(["A", "B"]) });
const price = Cmd.make("price", {
  input: sku,
  ok: Schema.Struct({
    cents: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  }),
  err: ["offline"],
});
const stock = Cmd.make("stock", {
  input: sku,
  ok: Schema.Struct({
    units: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  }),
  err: ["out_of_stock"],
});
const charge = Cmd.make("charge", {
  input: sku,
  ok: Schema.Struct({ receipt: Schema.String }),
  err: ["declined", "timeout"],
});

type Defs = typeof price | typeof stock | typeof charge;
type Sent = ReturnType<Defs>;
type Sku = "A" | "B";

interface Desk {
  readonly phase: "idle" | "open" | "closed";
  /** Asks sent and not yet answered. A healthy desk never goes below zero. */
  readonly pending: number;
  readonly total: number;
  readonly receipts: number;
}

type Msg =
  | { readonly type: "open"; readonly sku: Sku }
  | { readonly type: "close" }
  | Settled<Defs>;

const answered = (s: Desk, more: Partial<Desk> = {}): Desk => ({
  ...s,
  pending: s.pending - 1,
  ...more,
});

const update: Reducer<Desk, Msg, Sent> = {
  open: (s, m) => [
    { ...s, phase: "open", pending: s.pending + 3 },
    [price({ sku: m.sku }), stock({ sku: m.sku }), charge({ sku: m.sku })],
  ],
  close: (s) => (s.pending === 0 ? [{ ...s, phase: "closed" }, []] : [s, []]),
  price_ok: (s, m) => [answered(s, { total: s.total + m.value.cents }), []],
  price_err: (s, m) => [s, [price({ sku: m.cmd.sku })]],
  stock_ok: (s) => [answered(s), []],
  stock_err: (s) => [answered(s), []],
  charge_ok: (s) => [answered(s, { receipts: s.receipts + 1 }), []],
  charge_err: (s, m) =>
    m.error._tag === "timeout"
      ? [s, [charge({ sku: m.cmd.sku })]]
      : [answered(s), []],
};

const FRESH_DESK: Desk = { phase: "idle", pending: 0, total: 0, receipts: 0 };

const desk = (
  cells: Reducer<Desk, Msg, Sent> = update,
  priceDef: typeof price = price,
) =>
  defineMachine({
    types: {
      model: {} as Desk,
      msg: {} as Msg,
      cmd: {} as Sent,
      ctx: {} as object,
    },
    cmds: [priceDef, stock, charge],
    init: (loaded) => [loaded ?? FRESH_DESK, []],
    update: cells,
  });

const machine = desk();

/** Broken reducer: a lost stock check is counted as two answers. */
const doubleCounts = desk({
  ...update,
  stock_err: (s) => [{ ...s, pending: s.pending - 2 }, []],
});

/**
 * Broken schema: `price`'s `ok` schema was edited to hand back text, and the
 * reducer, unchanged, adds it to a number. The cast is the edit: the reducer's
 * type still says `cents` is a number, as a reducer's would after the edit.
 */
const textPrice = Cmd.make("price", {
  input: sku,
  ok: Schema.Struct({ cents: Schema.String }),
  err: ["offline"],
}) as unknown as typeof price;
const takesText = desk(update, textPrice);

const ctx = {};

const outside = {
  open: Arbitrary.map(Arbitrary.schema(Schema.Literals(["A", "B"])), (s) => ({
    type: "open" as const,
    sku: s,
  })),
  close: Arbitrary.Constant({ type: "close" as const }),
};

/** The law: no more answers than asks, and the total is a count of cents. */
const deskHolds = (msgs: readonly Msg[], m: typeof machine = machine) =>
  lawInvariant(foldEvents(m, ctx, null, msgs), ({ next }) =>
    next.pending < 0
      ? `pending went to ${next.pending}`
      : Number.isSafeInteger(next.total) || `total is ${String(next.total)}`,
  );

const listsFor = (m: typeof machine) =>
  Result.getOrThrow(
    arbSchemaGuidedSequence(m, ctx, { outside, maxLength: 60 }),
  );

const SEEDS = [1, 749, 2026] as const;

const check = (m: typeof machine, seed: number) =>
  Effect.runPromise(
    Arbitrary.checkEffect(listsFor(m), (msgs) => deskHolds(msgs, m) === null, {
      runs: 500,
      size: 60,
      seed,
    }),
  );

const sample = (m: typeof machine, count = 300) =>
  Effect.runPromise(
    Arbitrary.sampleEffect(listsFor(m), { count, size: 60, seed: 749 }),
  );

/** A Cmd's identity, since each fold builds its Cmds anew. */
const key = (cmd: { readonly type: string }): string => JSON.stringify(cmd);

describe("a machine is property-tested on Effect with no answer written by hand", () => {
  it.each(
    SEEDS,
  )("the law holds on the real desk over 500 runs, seed %i", async (seed) => {
    const result = await check(machine, seed);
    expect(result._tag).toBe("Passed");
    if (result._tag === "Passed") expect(result.runs).toBe(500);
  });

  it("draws lists that keep three Cmds in flight and reach the 60-event cap", async () => {
    const lists = await sample(machine);
    let mostInFlight = 0;
    for (const msgs of lists) {
      const fold = foldEvents(machine, ctx, null, msgs);
      for (const { next } of fold.steps) {
        mostInFlight = Math.max(mostInFlight, next.pending);
      }
      expect(msgs.length).toBeLessThanOrEqual(60);
    }
    expect(mostInFlight).toBeGreaterThanOrEqual(3);
    expect(Math.max(...lists.map((msgs) => msgs.length))).toBeGreaterThan(20);
  });

  it.each(
    SEEDS,
  )("fails a reducer that breaks the law with a shrunk list, seed %i", async (seed) => {
    const result = await check(doubleCounts, seed);
    expect(result._tag).toBe("Falsified");
    if (result._tag !== "Falsified") return;
    expect(result.shrunkInput.length).toBeLessThanOrEqual(
      result.initialInput.length,
    );
    expect(deskHolds(result.shrunkInput, doubleCounts)?.reason).toMatch(
      /^pending went to -/,
    );
    expect(result.shrunkInput.some((msg) => msg.type === "stock_err")).toBe(
      true,
    );
  });

  it.each(
    SEEDS,
  )("fails an ok schema the reducer cannot take with a shrunk list, seed %i", async (seed) => {
    const result = await check(takesText, seed);
    expect(result._tag).toBe("Falsified");
    if (result._tag !== "Falsified") return;
    expect(result.shrunkInput.length).toBeLessThanOrEqual(
      result.initialInput.length,
    );
    expect(deskHolds(result.shrunkInput, takesText)?.reason).toMatch(
      /^total is /,
    );
    expect(result.shrunkInput.map((msg) => msg.type)).toEqual([
      "open",
      "price_ok",
    ]);
  });

  it("never shrinks to a list longer than the one first found, over 200 seeds", async () => {
    // The retries are what used to grow a shrunk list: with an answer dropped,
    // deleting an earlier answer let a later dropped one back in.
    const grew: number[] = [];
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const broken of [doubleCounts, takesText]) {
        const result = await check(broken, seed);
        if (
          result._tag !== "Falsified" ||
          result.shrunkInput.length > result.initialInput.length
        ) {
          grew.push(seed);
        }
      }
    }
    expect(grew).toEqual([]);
  });
});

describe("every answer answers a Cmd that was sent and not yet answered", () => {
  it("ties each answer to a waiting Cmd, though the desk keeps none", async () => {
    let answers = 0;
    for (const msgs of await sample(machine)) {
      const fold = foldEvents(machine, ctx, null, msgs);
      const waiting = fold.initCmds.map(key);
      for (const { msg, cmds } of fold.steps) {
        if ("cmd" in msg) {
          const at = waiting.indexOf(key(msg.cmd));
          expect(at).toBeGreaterThanOrEqual(0);
          waiting.splice(at, 1);
          answers += 1;
        }
        waiting.push(...cmds.map(key));
      }
    }
    expect(answers).toBeGreaterThan(1000);
  });

  it("drops an answer drawn with nothing waiting", async () => {
    // No outside Msg, and `init` sends nothing: every event drawn is an answer
    // with no Cmd waiting, so every list comes out empty.
    const quiet = Result.getOrThrow(arbSchemaGuidedSequence(machine, ctx));
    const lists = await Effect.runPromise(
      Arbitrary.sampleEffect(quiet, { count: 100, seed: 1 }),
    );
    expect(lists.every((msgs) => msgs.length === 0)).toBe(true);
  });
});

describe("answers come from the Cmd's own schema", () => {
  const pricedAt = (cents: number) =>
    Cmd.make("price", {
      input: sku,
      ok: Schema.Struct({ cents: Schema.Literal(cents) }),
      err: ["offline"],
    }) as unknown as typeof price;

  /** One test body for every schema: it never names a value. */
  const drawn = async (priceDef: typeof price) => {
    const m = desk(update, priceDef);
    const cents = new Set<number>();
    const tags = new Map<string, Set<string>>();
    for (const msgs of await sample(m)) {
      for (const msg of msgs) {
        if (msg.type === "price_ok") cents.add(msg.value.cents);
        if (msg.type.endsWith("_err") && "error" in msg) {
          const seen = tags.get(msg.type) ?? new Set<string>();
          seen.add(msg.error._tag);
          tags.set(msg.type, seen);
        }
      }
    }
    return { cents, tags };
  };

  it("draws an ok answer from schema.ok, so editing the schema changes it", async () => {
    expect((await drawn(pricedAt(7))).cents).toEqual(new Set([7]));
    expect((await drawn(pricedAt(9))).cents).toEqual(new Set([9]));
  });

  it("draws an err answer carrying one of the Cmd's errTags, each of them", async () => {
    const { tags } = await drawn(price);
    expect(tags).toEqual(
      new Map([
        ["price_err", new Set(["offline"])],
        ["stock_err", new Set(["out_of_stock"])],
        ["charge_err", new Set(["declined", "timeout"])],
      ]),
    );
  });
});

describe("a machine it cannot draw answers for gets a result naming the problem", () => {
  it("names a Cmd whose ok schema is not an Effect schema", () => {
    const zodPrice = CoreCmd.define("price", {
      input: z.object({ sku: z.enum(["A", "B"]) }),
      ok: z.object({ cents: z.number() }),
      err: ["offline"],
    }) as unknown as typeof price;
    const result = arbSchemaGuidedSequence(desk(update, zodPrice), ctx, {
      outside,
    });
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(NotEffectSchemaError);
    expect(result.failure).toMatchObject({
      _tag: "NotEffectSchemaError",
      cmdType: "price",
    });
    expect(result.failure.message).toContain(
      `the "price" Cmd's ok schema is not an Effect schema`,
    );
  });

  it("names a machine with no machine.cmds", () => {
    const bare = defineMachine({
      types: {
        model: {} as Desk,
        msg: {} as Msg,
        cmd: {} as Sent,
        ctx: {} as object,
      },
      init: (loaded) => [loaded ?? FRESH_DESK, []],
      update,
    });
    const result = arbSchemaGuidedSequence(bare, ctx, { outside });
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(NoCmdsError);
    expect(result.failure.message).toContain("the machine has no `cmds`");
  });

  it("names an empty cmds list with nothing outside to draw", () => {
    const empty = defineMachine({
      types: {
        model: {} as Desk,
        msg: {} as { readonly type: "close" },
        cmd: {} as never,
        ctx: {} as object,
      },
      cmds: [],
      init: (loaded) => [loaded ?? FRESH_DESK, []],
      update: { close: (s) => [s, []] },
    });
    const result = arbSchemaGuidedSequence(empty, ctx);
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(NothingToDrawError);
  });
});
