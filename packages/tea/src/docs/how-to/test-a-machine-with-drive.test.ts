/**
 * The drive how-to's Promise half, compiled and run (#550).
 *
 * `docs/how-to/test-a-machine-with-drive.md` shows each `#region` of this file
 * verbatim (`../page-mirrors.ts` holds the row), so the tests a reader copies
 * are tests this suite runs. The Effect half is
 * `../../testing/effect/drive-how-to.test.ts`.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move a marker and break the row this file backs.

import { describe, expect, it } from "vitest";
import { newOrder, order } from "../../../examples/order";

// #region drive
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
// #endregion drive

describe("docs/how-to/test-a-machine-with-drive.md, on the Promise engine", () => {
  // #region success
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
  // #endregion success

  // #region failure
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
  // #endregion failure
});
