/**
 * The drive how-to's Promise half, compiled and run (#550).
 *
 * `docs/how-to/test-a-machine-with-drive.md` shows each `#region` of this file
 * verbatim (`../page-mirrors.ts` holds the row), so the tests a reader copies
 * are tests this suite runs. The Effect half is
 * `../../testing/effect/drive-how-to.test.ts`.
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
import { expectEveryCellReached, type Trace } from "./every-cell-reached";

const traces = vi.hoisted((): Trace[] => []);

vi.mock("@demlik/tea/testing/promise", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@demlik/tea/testing/promise")>();
  const drive = (async (...args: Parameters<typeof actual.drive>) => {
    const run = await actual.drive(...args);
    traces.push(run.trace);
    return run;
  }) as typeof actual.drive;
  return { ...actual, drive };
});

// #region drive
import { drive } from "@demlik/tea/testing/promise";

/** Drive one order to the end. Only the step that fails changes between tests. */
function driveOrder(failure?: "out_of_stock" | "declined" | "no_carrier") {
  return drive(
    order,
    newOrder,
    { type: "place", sku: "TEA-001", cents: 4200 },
    {
      reserve_stock: async (_cmd, { ok, err }) =>
        failure === "out_of_stock"
          ? err({ _tag: "out_of_stock" })
          : ok({ hold: "hold-1" }),
      charge_card: async (cmd, { ok, err }) =>
        failure === "declined"
          ? err({ _tag: "declined" })
          : ok({ receipt: `paid-${cmd.cents}` }),
      ship_parcel: async (cmd, { ok, err }) =>
        failure === "no_carrier"
          ? err({ _tag: "no_carrier" })
          : ok({ tracking: `track-${cmd.sku}` }),
    },
  );
}
// #endregion drive

describe("docs/how-to/test-a-machine-with-drive.md, on the Promise engine", () => {
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
