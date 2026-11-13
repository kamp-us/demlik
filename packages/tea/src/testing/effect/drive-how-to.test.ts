/**
 * The drive how-to's Effect half, compiled and run (#550).
 *
 * `docs/how-to/test-a-machine-with-drive.md` shows each `#region` of this file
 * verbatim (`../../docs/page-mirrors.ts` holds the row). The Promise half is
 * `../../docs/how-to/test-a-machine-with-drive.test.ts`. This half is here
 * because only `src/effect/` and this directory may import `effect`.
 *
 * The last test reads the trace of every `drive` the cases ran, through the
 * `vi.mock` below that passes `drive` through and keeps each trace, so the
 * cases stay the page's code and carry no bookkeeping.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move a marker and break the row this file backs.

import { describe, expect, it, vi } from "vitest";
import {
  chargeCard,
  newOrder,
  order,
  reserveStock,
  shipParcel,
} from "../../../examples/order";
import { orderHandlers, Shop } from "../../../examples/order-effect";
import {
  expectEveryCellReached,
  type Trace,
} from "../../docs/how-to/every-cell-reached";

const traces = vi.hoisted((): Trace[] => []);

vi.mock("@demlik/tea/testing/effect", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@demlik/tea/testing/effect")>();
  const { Effect } = await import("effect");
  const drive = ((...args: Parameters<typeof actual.drive>) =>
    Effect.map(actual.drive(...args), (run) => {
      traces.push(run.trace);
      return run;
    })) as typeof actual.drive;
  return { ...actual, drive };
});

// #region drive
import { drive } from "@demlik/tea/testing/effect";
import { Effect, Layer } from "effect";

type Failure = "out_of_stock" | "declined" | "no_carrier";

/** A shop that says yes to everything except, when asked, one step. */
const fakeShop = (failure?: Failure) =>
  Layer.succeed(Shop, {
    reserve: () =>
      failure === "out_of_stock"
        ? Effect.fail({ _tag: "out_of_stock" as const })
        : Effect.succeed({ hold: "hold-1" }),
    charge: (cents) =>
      failure === "declined"
        ? Effect.fail({ _tag: "declined" as const })
        : Effect.succeed({ receipt: `paid-${cents}` }),
    ship: (sku) =>
      failure === "no_carrier"
        ? Effect.fail({ _tag: "no_carrier" as const })
        : Effect.succeed({ tracking: `track-${sku}` }),
  });

/** Drive one order to the end, on the real handlers over the fake shop. */
function driveOrder(failure?: Failure) {
  return Effect.runPromise(
    drive(
      order,
      newOrder,
      { type: "place", sku: "TEA-001", cents: 4200 },
      orderHandlers,
    ).pipe(Effect.provide(fakeShop(failure))),
  );
}
// #endregion drive

describe("docs/how-to/test-a-machine-with-drive.md, on the Effect engine", () => {
  // #region success
  it("ships an order whose card is accepted", async () => {
    const { state, trace } = await driveOrder();

    expect(state).toEqual({
      status: "shipped",
      sku: "TEA-001",
      cents: 4200,
      tracking: "track-TEA-001",
      failure: null,
    });

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd] : [],
    );
    expect(ran).toEqual([
      reserveStock({ sku: "TEA-001" }),
      chargeCard({ cents: 4200 }),
      shipParcel({ sku: "TEA-001" }),
    ]);
  });
  // #endregion success

  // #region failure
  it("stops an order with no stock, and charges nothing", async () => {
    const { state, trace } = await driveOrder("out_of_stock");

    expect(state).toEqual({
      status: "failed",
      sku: "TEA-001",
      cents: 4200,
      tracking: null,
      failure: "out_of_stock",
    });

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd] : [],
    );
    expect(ran).toEqual([reserveStock({ sku: "TEA-001" })]);
  });

  it("stops an order whose card is declined, and ships nothing", async () => {
    const { state, trace } = await driveOrder("declined");

    expect(state).toEqual({
      status: "failed",
      sku: "TEA-001",
      cents: 4200,
      tracking: null,
      failure: "declined",
    });

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd] : [],
    );
    expect(ran).toEqual([
      reserveStock({ sku: "TEA-001" }),
      chargeCard({ cents: 4200 }),
    ]);
  });

  it("stops an order no carrier takes, after the card was charged", async () => {
    const { state, trace } = await driveOrder("no_carrier");

    expect(state).toEqual({
      status: "failed",
      sku: "TEA-001",
      cents: 4200,
      tracking: null,
      failure: "no_carrier",
    });

    const ran = trace.flatMap((entry) =>
      entry.kind === "cmd" ? [entry.cmd] : [],
    );
    expect(ran).toEqual([
      reserveStock({ sku: "TEA-001" }),
      chargeCard({ cents: 4200 }),
      shipParcel({ sku: "TEA-001" }),
    ]);
  });
  // #endregion failure

  it("reaches every update cell of the order machine", () => {
    expectEveryCellReached(order, traces);
  });
});
